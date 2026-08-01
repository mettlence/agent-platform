import type { Message } from 'discord.js'
import pino from 'pino'
import {
  autoRegenerateStuck,
  formatRegenStatus,
  MAX_REGEN_ROWS_PER_PROJECT,
  STUCK_MINUTES,
  type RegenResult,
  type StuckCandidate,
} from '@/agents/pending-monitor/ensure-stuck.js'
import { getConnector, PROJECT_KEYS, PROJECTS, type ProjectKey } from '@/config/projects.js'
import { sendToThread, type PostTarget } from '@/shared/connectors/discord.js'
import type { PendingReadingItem } from '@/shared/connectors/types.js'

const log = pino({ name: 'fix-pending-command' })

const FIX_INTENT = /\b(fix|repair|kick|heal|regen(?:erate)?|perbaiki)\b/i
// Requires the literal "pending" — deliberately narrower than the monitor
// parser so cs-recovery mentions like "@bot fix this order ABC123" still
// route to the ticket flow, not to a one-shot pending scan.
const PENDING_INTENT = /\bpending\b/i

/**
 * One-shot "scan + auto-regenerate stuck" — no monitor row, no schedule, no
 * approval prompt. Handler for `@bot fix pending orders <project>` and
 * `@bot fix pending orders <project>`. Idempotent because ensureReading is idempotent
 * on the backend; safe to run any time.
 */
export function looksLikeFixPendingRequest(text: string): boolean {
  return FIX_INTENT.test(text) && PENDING_INTENT.test(text)
}

export async function handleFixPendingRequest(
  message: Message,
  text: string,
): Promise<void> {
  const projects = extractProjects(text)
  if (projects.length === 0) {
    await message.reply(
      [
        `Which project? Name one of: ${PROJECT_KEYS.join(', ')}, or say "both"/"semua".`,
        '',
        'Examples:',
        '`@bot fix pending orders astroloversketch`',
        '`@bot fix pending reading asksabrina`',
        '`@bot fix pending both`',
      ].join('\n'),
    )
    return
  }

  const target = message.channel as PostTarget
  await sendToThread(
    target,
    `🔎 Scanning pending orders for **${projects.join(', ')}** — will auto-regenerate anything stuck >${STUCK_MINUTES}min.`,
  )

  const perProject = await Promise.all(projects.map(scanAndFixOneProject))
  const pollables = collectPollables(perProject)
  const initialReport = formatFixReport(perProject, { hasPending: pollables.length > 0 })

  // If the report is single-message, keep a handle so we can edit it as
  // jobs finish. If it chunked, editing only the last chunk would be
  // misleading — skip polling and add a footer telling the operator to
  // recheck manually.
  const willEdit = initialReport.length <= 1900 && pollables.length > 0
  const reportMessage = await sendToThread(target, initialReport)

  log.info(
    {
      projects,
      willEdit,
      pollableCount: pollables.length,
      results: perProject.map((r) => ({
        project: r.project,
        ok: r.ok,
        total: r.totalPending,
        stuck: r.stuck.length,
      })),
    },
    'fix-pending scan complete',
  )

  if (willEdit) {
    // Fire-and-forget: the handler returns immediately; the message keeps
    // getting edited in-place as each waitForJob resolves. Errors are
    // logged but don't crash the bot — the initial report is already up.
    void pollAndEditReport({ reportMessage, perProject, pollables }).catch((err) => {
      log.error({ err, messageId: reportMessage.id }, 'pollAndEditReport threw')
    })
  }
}

interface Pollable {
  project: ProjectKey
  jobId: string
  regen: RegenResult
}

function collectPollables(perProject: ProjectFixResult[]): Pollable[] {
  const out: Pollable[] = []
  for (const r of perProject) {
    if (!r.ok) continue
    for (const s of r.stuck) {
      const g = s.regen
      if (!g || !g.ok || !g.jobId) continue
      if (g.status === 'pending' || g.status === 'running') {
        out.push({ project: r.project, jobId: g.jobId, regen: g })
      }
    }
  }
  return out
}

const POLL_TIMEOUT_MS = 5 * 60 * 1000 // 5min per job — same cap as connector default
const POLL_INTERVAL_MS = 5000

/**
 * Wait for every kicked job to reach a terminal state, mutating the
 * associated RegenResult and re-rendering the Discord message after each
 * resolution. One Discord edit per completed job; jobs run in parallel so
 * ordering is by finish time.
 */
async function pollAndEditReport(args: {
  reportMessage: Message
  perProject: ProjectFixResult[]
  pollables: Pollable[]
}): Promise<void> {
  const { reportMessage, perProject, pollables } = args
  let pending = pollables.length

  const editNow = async (): Promise<void> => {
    const rendered = formatFixReport(perProject, { hasPending: pending > 0 })
    if (rendered.length > 1900) return
    try {
      await reportMessage.edit(rendered)
    } catch (err) {
      log.warn({ err, messageId: reportMessage.id }, 'edit report failed')
    }
  }

  await Promise.all(
    pollables.map(async (p) => {
      const connector = getConnector(p.project)
      try {
        const finalJob = await connector.waitForJob(p.jobId, {
          timeoutMs: POLL_TIMEOUT_MS,
          intervalMs: POLL_INTERVAL_MS,
        })
        if (!finalJob) {
          p.regen.finalStatus = 'timeout'
        } else if (finalJob.status === 'done') {
          p.regen.finalStatus = 'done'
        } else if (finalJob.status === 'failed') {
          p.regen.finalStatus = 'failed'
          p.regen.finalError = finalJob.lastError ?? 'job failed'
        } else {
          // Still pending/running after timeoutMs — treat as timeout.
          p.regen.finalStatus = 'timeout'
        }
      } catch (err) {
        log.error({ err, jobId: p.jobId, project: p.project }, 'waitForJob threw')
        p.regen.finalStatus = 'timeout'
      } finally {
        pending -= 1
        await editNow()
      }
    }),
  )
}

interface ScannedStuck {
  item: PendingReadingItem
  ageMin: number
  regen: RegenResult | undefined
}

interface ProjectFixResult {
  project: ProjectKey
  ok: boolean
  error?: string
  totalPending: number
  stuck: ScannedStuck[]
}

async function scanAndFixOneProject(project: ProjectKey): Promise<ProjectFixResult> {
  const connector = getConnector(project)
  const now = new Date()
  let items: PendingReadingItem[]
  try {
    const res = await connector.listPendingReadings({ kind: 'all', limit: 200 })
    items = res.items
  } catch (err) {
    log.error({ err, project }, 'fix-pending scan failed')
    return {
      project,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      totalPending: 0,
      stuck: [],
    }
  }

  const stuckCandidates: StuckCandidate[] = []
  for (const item of items) {
    const ageMin = ageMinutes(item.createdAt, now)
    if (ageMin >= STUCK_MINUTES) {
      stuckCandidates.push({ project, item, ageMin })
    }
  }
  stuckCandidates.sort((a, b) => b.ageMin - a.ageMin)

  const regens = await autoRegenerateStuck(stuckCandidates)
  const regenByRef = new Map(regens.map((r) => [r.ref, r]))

  return {
    project,
    ok: true,
    totalPending: items.length,
    stuck: stuckCandidates.map((c) => ({
      item: c.item,
      ageMin: c.ageMin,
      regen: regenByRef.get(c.item.ref),
    })),
  }
}

function formatFixReport(
  results: ProjectFixResult[],
  opts: { hasPending: boolean } = { hasPending: false },
): string {
  const lines: string[] = []
  lines.push(`🛟 **Fix pending orders** · one-shot scan`)

  for (const r of results) {
    lines.push('')
    lines.push(`**${r.project}**`)
    if (!r.ok) {
      lines.push(`❌ Fetch failed: \`${r.error}\``)
      continue
    }
    const failed = r.stuck.filter(
      (x) => x.regen && (!x.regen.ok || x.regen.finalStatus === 'failed'),
    ).length
    lines.push(
      `Total pending: **${r.totalPending}** · stuck (>${STUCK_MINUTES}min): **${r.stuck.length}**${failed ? ` · ❌ ${failed} failed` : ''}`,
    )
    if (r.stuck.length === 0) {
      lines.push('_Nothing stuck — no action taken._')
      continue
    }
    const shown = r.stuck.slice(0, MAX_REGEN_ROWS_PER_PROJECT)
    for (const { item, ageMin, regen } of shown) {
      const status = regen ? formatRegenStatus(regen) : '(no result)'
      lines.push(
        `- ${item.kind} \`${item.ref}\` · ${item.customerEmail ?? '?'} · ${formatAge(ageMin)} · ${status}`,
      )
    }
    if (r.stuck.length > shown.length) {
      lines.push(`- …and ${r.stuck.length - shown.length} more (all triggered)`)
    }
  }

  lines.push('')
  lines.push(
    opts.hasPending
      ? '_⏳ Waiting for jobs to finish — this message will update as each completes._'
      : '_✅ All done._',
  )
  return lines.join('\n')
}

function extractProjects(text: string): ProjectKey[] {
  const lower = text.toLowerCase()
  const hits = new Set<ProjectKey>()
  if (/\bboth\b|\bsemua\b|\ball\b/.test(lower)) {
    for (const k of PROJECT_KEYS) hits.add(k)
    return [...hits]
  }
  for (const entry of Object.values(PROJECTS)) {
    for (const kw of entry.keywords) {
      if (new RegExp(`\\b${escape(kw)}\\b`, 'i').test(lower)) {
        hits.add(entry.key)
        break
      }
    }
    if (new RegExp(`\\b${escape(entry.key)}\\b`, 'i').test(lower)) hits.add(entry.key)
  }
  return [...hits]
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function ageMinutes(iso: string, now: Date): number {
  if (!iso) return 0
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 0
  return Math.max(0, Math.floor((now.getTime() - then) / 60_000))
}

function formatAge(min: number): string {
  if (min < 60) return `${min}min`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m ? `${h}h${m}m` : `${h}h`
}
