import pino from 'pino'
import { getConnector, type ProjectKey } from '@/config/projects.js'
import { postToThread } from '@/shared/connectors/discord.js'
import type { PendingMonitor } from '@/shared/state/monitors.js'
import { claimTick, recordSnapshot, markExpired } from '@/shared/state/monitors.js'
import type { PendingReadingItem } from '@/shared/connectors/types.js'
import {
  autoRegenerateStuck,
  formatRegenStatus,
  MAX_REGEN_ROWS_PER_PROJECT,
  STUCK_MINUTES,
  type RegenResult,
  type StuckCandidate,
} from './ensure-stuck.js'

const log = pino({ name: 'pending-monitor-tick' })

interface ProjectResult {
  project: ProjectKey
  ok: boolean
  error?: string
  items: PendingReadingItem[]
  newItems: PendingReadingItem[]
  stillItems: PendingReadingItem[]
  resolvedRefs: string[]
}

/**
 * Run one tick of a monitor: pull /pending-readings for each project,
 * diff refs against the last snapshot, post a summary to the thread, and
 * persist the new snapshot. If the monitor's next_run_at is now past its
 * expires_at, mark it expired and post a closing line.
 *
 * Backend failures are per-project: one project down doesn't stop the tick
 * for the other. The failed project's line explicitly says so in the report.
 */
export async function runTick(monitor: PendingMonitor): Promise<void> {
  if (!monitor._id) {
    log.error({ monitor }, 'monitor missing _id — cannot claim tick')
    return
  }
  const now = new Date()
  const claimed = await claimTick(monitor._id, now, monitor.interval_hours)
  if (!claimed) {
    // Another worker beat us, or status flipped between find and claim.
    return
  }

  const tickNumber = claimed.tick_count + 1
  const totalTicks = monitor.expected_ticks ?? Math.max(1, Math.ceil(monitor.duration_hours / monitor.interval_hours))
  const isFinalTick = tickNumber >= totalTicks

  const results = await Promise.all(
    monitor.projects.map((p) => runOneProject(p, monitor)),
  )

  const nextSnapshot: PendingMonitor['last_snapshot'] = {}
  const nextFirstSeen: PendingMonitor['first_seen_at'] = { ...monitor.first_seen_at }
  for (const r of results) {
    if (r.ok) {
      nextSnapshot[r.project] = r.items.map((i) => i.ref)
      const seenMap = { ...(nextFirstSeen[r.project] ?? {}) }
      const currentRefs = new Set(r.items.map((i) => i.ref))
      for (const ref of Object.keys(seenMap)) {
        if (!currentRefs.has(ref)) delete seenMap[ref]
      }
      const nowIso = now.toISOString()
      for (const item of r.items) {
        if (!seenMap[item.ref]) seenMap[item.ref] = item.createdAt || nowIso
      }
      nextFirstSeen[r.project] = seenMap
    }
  }

  await recordSnapshot(monitor._id, nextSnapshot, nextFirstSeen)

  const stuckCandidates = collectStuckCandidates({
    results,
    firstSeenAt: nextFirstSeen,
    now,
  })
  const regenResults = await autoRegenerateStuck(stuckCandidates)

  const report = formatReport({
    monitor,
    tickNumber,
    totalTicks,
    isFinalTick,
    results,
    firstSeenAt: nextFirstSeen,
    now,
    regenResults,
  })
  await postToThread(monitor.thread_id, report).catch((err) => {
    log.error({ err, threadId: monitor.thread_id }, 'failed to post tick report')
  })

  if (isFinalTick) {
    await markExpired(monitor._id)
    await postToThread(
      monitor.thread_id,
      `🏁 Monitor completed — ran ${tickNumber} tick${tickNumber === 1 ? '' : 's'} over ${humanizeHours(monitor.duration_hours)}. No further checks.`,
    ).catch(() => {})
  }
}

async function runOneProject(
  project: ProjectKey,
  monitor: PendingMonitor,
): Promise<ProjectResult> {
  const connector = getConnector(project)
  try {
    const res = await connector.listPendingReadings({ kind: 'all', limit: 200 })
    const items = res.items
    const prevRefs = new Set(monitor.last_snapshot[project] ?? [])
    const currentRefs = new Set(items.map((i) => i.ref))
    const newItems = items.filter((i) => !prevRefs.has(i.ref))
    const stillItems = items.filter((i) => prevRefs.has(i.ref))
    const resolvedRefs = [...prevRefs].filter((r) => !currentRefs.has(r))
    return { project, ok: true, items, newItems, stillItems, resolvedRefs }
  } catch (err) {
    return {
      project,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      items: [],
      newItems: [],
      stillItems: [],
      resolvedRefs: [],
    }
  }
}

/**
 * Items whose order age (`now - createdAt`, tracked in firstSeenAt) is at
 * least STUCK_MINUTES. Sorted oldest first so the per-tick cap picks the
 * most concerning items first.
 *
 * Age is the sole gate — the "seen in ≥ 2 ticks" filter was removed. When
 * the monitor interval is long (e.g. 8h), an item whose createdAt is
 * already older than STUCK_MINUTES at first sighting shouldn't be delayed
 * another whole interval to "confirm" it's stuck. ensureReading is
 * idempotent (backend returns the running job status when a job is
 * already in flight), so a false-positive proposal is cheap.
 */
function collectStuckCandidates(args: {
  results: ProjectResult[]
  firstSeenAt: PendingMonitor['first_seen_at']
  now: Date
}): StuckCandidate[] {
  const { results, firstSeenAt, now } = args
  const out: StuckCandidate[] = []
  for (const r of results) {
    if (!r.ok) continue
    for (const item of r.items) {
      const ageMin = ageMinutes(firstSeenAt[r.project]?.[item.ref], now)
      if (ageMin < STUCK_MINUTES) continue
      out.push({ project: r.project, item, ageMin })
    }
  }
  out.sort((a, b) => b.ageMin - a.ageMin)
  return out
}

function formatReport(args: {
  monitor: PendingMonitor
  tickNumber: number
  totalTicks: number
  isFinalTick: boolean
  results: ProjectResult[]
  firstSeenAt: PendingMonitor['first_seen_at']
  now: Date
  regenResults: RegenResult[]
}): string {
  const { monitor, tickNumber, totalTicks, isFinalTick, results, firstSeenAt, now, regenResults } = args
  const regenByProject = new Map<ProjectKey, Map<string, RegenResult>>()
  for (const r of regenResults) {
    let byRef = regenByProject.get(r.project)
    if (!byRef) {
      byRef = new Map()
      regenByProject.set(r.project, byRef)
    }
    byRef.set(r.ref, r)
  }

  const lines: string[] = []
  lines.push(
    `📊 **Pending-orders check** · tick ${tickNumber}/${totalTicks} · ${humanizeHours(monitor.interval_hours)} interval`,
  )

  for (const r of results) {
    lines.push('')
    lines.push(`**${r.project}**`)

    if (!r.ok) {
      lines.push(`❌ Fetch failed: \`${r.error}\``)
      continue
    }

    const prevCount = (monitor.last_snapshot[r.project] ?? []).length
    const total = r.items.length
    const delta =
      monitor.tick_count === 0
        ? '(first tick — baseline)'
        : `was ${prevCount}, +${r.newItems.length} new, -${r.resolvedRefs.length} resolved`
    lines.push(`Total pending: **${total}** · ${delta}`)

    const stuck = r.items
      .map((i) => ({ item: i, ageMin: ageMinutes(firstSeenAt[r.project]?.[i.ref], now) }))
      .filter((x) => x.ageMin >= STUCK_MINUTES)
      .sort((a, b) => b.ageMin - a.ageMin)
    if (stuck.length) {
      const projectRegens = regenByProject.get(r.project)
      const failed = stuck.filter((x) => {
        const rr = projectRegens?.get(x.item.ref)
        return rr && !rr.ok
      }).length
      lines.push('')
      lines.push(
        `🛟 Auto-regenerated stuck (>${STUCK_MINUTES}min old): **${stuck.length}** ${stuck.length === 1 ? 'item' : 'items'}${failed ? ` · ❌ ${failed} failed` : ''}`,
      )
      const shown = stuck.slice(0, MAX_REGEN_ROWS_PER_PROJECT)
      for (const { item, ageMin } of shown) {
        const rr = projectRegens?.get(item.ref)
        const status = rr ? formatRegenStatus(rr) : '· (no result)'
        lines.push(
          `- ${item.kind} \`${item.ref}\` · ${item.customerEmail ?? '?'} · ${formatAge(ageMin)} · ${status}`,
        )
      }
      if (stuck.length > shown.length) {
        lines.push(`- …and ${stuck.length - shown.length} more (all triggered)`)
      }
    }

    if (r.newItems.length && monitor.tick_count > 0) {
      const preview = r.newItems.slice(0, 5)
      lines.push('')
      lines.push(`✨ New this tick (${r.newItems.length}):`)
      for (const item of preview) {
        lines.push(`- ${item.kind} \`${item.ref}\` · ${item.customerEmail ?? '?'}`)
      }
      if (r.newItems.length > preview.length) {
        lines.push(`- …and ${r.newItems.length - preview.length} more`)
      }
    }

    if (r.resolvedRefs.length) {
      lines.push('')
      lines.push(`✅ Resolved since last tick: ${r.resolvedRefs.length}`)
    }
  }

  const nextRun = new Date(now.getTime() + monitor.interval_hours * 3600_000)
  lines.push('')
  lines.push(
    isFinalTick
      ? `_This was the final tick._`
      : `_Next check: <t:${Math.floor(nextRun.getTime() / 1000)}:t>_`,
  )
  return lines.join('\n')
}

function ageMinutes(seenAt: string | undefined, now: Date): number {
  if (!seenAt) return 0
  const then = new Date(seenAt).getTime()
  if (Number.isNaN(then)) return 0
  return Math.max(0, Math.floor((now.getTime() - then) / 60_000))
}

function formatAge(min: number): string {
  if (min < 60) return `${min}min`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m ? `${h}h${m}m` : `${h}h`
}

function humanizeHours(h: number): string {
  if (h >= 1) return `${h % 1 === 0 ? h : h.toFixed(1)}h`
  return `${Math.round(h * 60)}m`
}
