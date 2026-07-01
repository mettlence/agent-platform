import pino from 'pino'
import { getConnector, type ProjectKey } from '@/config/projects.js'
import { getDiscordClient, postToThread } from '@/shared/connectors/discord.js'
import type { PendingMonitor } from '@/shared/state/monitors.js'
import { claimTick, recordSnapshot, markExpired } from '@/shared/state/monitors.js'
import { attachDiscordMessageId, createApproval, findPendingByRef } from '@/shared/state/approvals.js'

const log = pino({ name: 'pending-monitor-tick' })

const STUCK_MINUTES = 30
/**
 * Cap on auto-proposals emitted per tick, summed across all projects. Keeps
 * a bad-day incident (dozens of stuck items) from flooding the thread with
 * approval prompts. Extras are counted in the report so the operator knows
 * how many were suppressed.
 */
const MAX_AUTO_PROPOSALS_PER_TICK = 3
const AUTO_PROPOSAL_TTL_MINUTES = 60

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
  const proposalCount = await proposeGenerateForStuck({
    monitor,
    candidates: stuckCandidates,
  })

  const report = formatReport({
    monitor,
    tickNumber,
    totalTicks,
    isFinalTick,
    results,
    firstSeenAt: nextFirstSeen,
    now,
    proposalCount,
    stuckCount: stuckCandidates.length,
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

interface StuckCandidate {
  project: ProjectKey
  item: PendingItem
  ageMin: number
}

/**
 * Items that are (a) present in this tick AND the previous tick (`stillItems`),
 * and (b) at least STUCK_MINUTES old measured from firstSeenAt. Sorted oldest
 * first so a per-tick cap picks the most concerning items first.
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
    for (const item of r.stillItems) {
      const ageMin = ageMinutes(firstSeenAt[r.project]?.[item.ref], now)
      if (ageMin < STUCK_MINUTES) continue
      out.push({ project: r.project, item, ageMin })
    }
  }
  out.sort((a, b) => b.ageMin - a.ageMin)
  return out
}

/**
 * For each candidate up to MAX_AUTO_PROPOSALS_PER_TICK, park a pending_approvals
 * row and post an approval draft in the monitor thread. Skips items that
 * already have a still-pending proposal so operators don't get repeat prompts
 * on every tick. Returns the number of proposals actually posted.
 */
async function proposeGenerateForStuck(args: {
  monitor: PendingMonitor
  candidates: StuckCandidate[]
}): Promise<number> {
  const { monitor, candidates } = args
  if (candidates.length === 0) return 0

  const client = getDiscordClient()
  const channel = await client.channels.fetch(monitor.thread_id).catch(() => null)
  // Accept either a Thread (default flow) or a plain text channel (inline
  // mode). Both have identical send/react semantics; the isThread gate is
  // the only thing that changes.
  if (!channel || !('send' in channel)) {
    log.warn({ threadId: monitor.thread_id }, 'monitor target channel missing — skipping proposals')
    return 0
  }

  let posted = 0
  for (const cand of candidates) {
    if (posted >= MAX_AUTO_PROPOSALS_PER_TICK) break

    const existing = await findPendingByRef(
      monitor.thread_id,
      cand.project,
      cand.item.ref,
      cand.item.kind,
    )
    if (existing) continue

    const email = cand.item.customerEmail ?? ''
    const expires = new Date(Date.now() + AUTO_PROPOSAL_TTL_MINUTES * 60_000)

    let approvalId
    try {
      approvalId = await createApproval({
        thread_id: monitor.thread_id,
        ticket_id: `monitor-${cand.item.ref}`,
        project: cand.project,
        agent: 'pending-monitor',
        customer_email: email,
        drafted_action: {
          action_type: 'ensure_reading_from_monitor',
          project: cand.project,
          ref: cand.item.ref,
          kind: cand.item.kind,
          customer_email: email,
          age_min_at_propose: cand.ageMin,
        },
        discord_message_id: '',
        expires_at: expires,
      })
    } catch (err) {
      log.error({ err, ref: cand.item.ref }, 'createApproval failed for auto-propose')
      continue
    }

    const body = formatProposal(cand)
    try {
      const msg = await channel.send(body)
      await attachDiscordMessageId(approvalId, msg.id)
      await msg.react('✅')
      await msg.react('❌')
      posted++
    } catch (err) {
      log.error({ err, ref: cand.item.ref }, 'posting auto-proposal failed')
    }
  }
  return posted
}

function formatProposal(cand: StuckCandidate): string {
  const { project, item, ageMin } = cand
  return [
    `🛟 **Recover pending order?**`,
    '',
    `- Project: **${project}**`,
    `- Kind: **${item.kind}**`,
    `- Ref: \`${item.ref}\``,
    `- Customer: ${item.customerEmail ?? '(unknown)'}${item.customerFirstName ? ` · ${item.customerFirstName}` : ''}`,
    `- Age: **${formatAge(ageMin)}** (stuck across ticks)`,
    '',
    'Proposed action: call `ensure-reading` — kicks generation if the job is missing, no-ops if a job is already running.',
    '',
    'React ✅ to trigger, ❌ to ignore.',
  ].join('\n')
}

function formatReport(args: {
  monitor: PendingMonitor
  tickNumber: number
  totalTicks: number
  isFinalTick: boolean
  results: ProjectResult[]
  firstSeenAt: PendingMonitor['first_seen_at']
  now: Date
  proposalCount: number
  stuckCount: number
}): string {
  const { monitor, tickNumber, totalTicks, isFinalTick, results, firstSeenAt, now, proposalCount, stuckCount } = args
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

  if (proposalCount > 0 || stuckCount > MAX_AUTO_PROPOSALS_PER_TICK) {
    lines.push('')
    if (proposalCount > 0) {
      lines.push(
        `🛟 Auto-proposals posted: **${proposalCount}** (react ✅/❌ on each above).`,
      )
    }
    if (stuckCount > proposalCount) {
      lines.push(
        `_…and ${stuckCount - proposalCount} more stuck ${stuckCount - proposalCount === 1 ? 'item' : 'items'} not auto-proposed (cap: ${MAX_AUTO_PROPOSALS_PER_TICK}/tick)._`,
      )
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
