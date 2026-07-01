import pino from 'pino'
import type { ObjectId } from 'mongodb'
import { getConnector, type ProjectKey } from '@/config/projects.js'
import { postToThread } from '@/shared/connectors/discord.js'
import type { PendingMonitor } from '@/shared/state/monitors.ts'
import { claimTick, recordSnapshot, markExpired } from '@/shared/state/monitors.js'

const log = pino({ name: 'pending-monitor-tick' })

const STUCK_MINUTES = 30

interface PendingItem {
  kind: string
  ref: string
  orderId: string | null
  createdAt: string
  customerEmail: string | null
  customerFirstName: string | null
  engineVersion?: 'v1' | 'v2'
}

interface ProjectResult {
  project: ProjectKey
  ok: boolean
  error?: string
  items: PendingItem[]
  newItems: PendingItem[]
  stillItems: PendingItem[]
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
  const totalTicks = Math.ceil(monitor.duration_hours / monitor.interval_hours)

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

  const report = formatReport({
    monitor,
    tickNumber,
    totalTicks,
    results,
    firstSeenAt: nextFirstSeen,
    now,
  })
  await postToThread(monitor.thread_id, report).catch((err) => {
    log.error({ err, threadId: monitor.thread_id }, 'failed to post tick report')
  })

  // Post-tick: has the schedule elapsed?
  const nextRun = new Date(now.getTime() + monitor.interval_hours * 3600_000)
  if (nextRun > monitor.expires_at) {
    await markExpired(monitor._id)
    await postToThread(
      monitor.thread_id,
      `🏁 Monitor completed — ran ${tickNumber} tick${tickNumber === 1 ? '' : 's'} over ${monitor.duration_hours}h. No further checks.`,
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
    const items: PendingItem[] = res.items
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

function formatReport(args: {
  monitor: PendingMonitor
  tickNumber: number
  totalTicks: number
  results: ProjectResult[]
  firstSeenAt: PendingMonitor['first_seen_at']
  now: Date
}): string {
  const { monitor, tickNumber, totalTicks, results, firstSeenAt, now } = args
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

    const stuck = r.stillItems
      .map((i) => ({ item: i, ageMin: ageMinutes(firstSeenAt[r.project]?.[i.ref], now) }))
      .filter((x) => x.ageMin >= STUCK_MINUTES)
      .sort((a, b) => b.ageMin - a.ageMin)
      .slice(0, 8)
    if (stuck.length) {
      lines.push('')
      lines.push(`⚠️ Stuck (>${STUCK_MINUTES}min, still pending across ticks):`)
      for (const { item, ageMin } of stuck) {
        lines.push(`- ${item.kind} \`${item.ref}\` · ${item.customerEmail ?? '?'} · ${formatAge(ageMin)}`)
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
  const isFinal = nextRun > monitor.expires_at
  lines.push('')
  lines.push(
    isFinal
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
