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
 * `!fix-pending <project>`. Idempotent because ensureReading is idempotent
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
  const report = formatFixReport(perProject)
  await sendToThread(target, report)

  log.info(
    { projects, results: perProject.map((r) => ({ project: r.project, ok: r.ok, total: r.totalPending, stuck: r.stuck.length })) },
    'fix-pending scan complete',
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

function formatFixReport(results: ProjectFixResult[]): string {
  const lines: string[] = []
  lines.push(`🛟 **Fix pending orders** · one-shot scan`)

  for (const r of results) {
    lines.push('')
    lines.push(`**${r.project}**`)
    if (!r.ok) {
      lines.push(`❌ Fetch failed: \`${r.error}\``)
      continue
    }
    const failed = r.stuck.filter((x) => x.regen && !x.regen.ok).length
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
