import pino from 'pino'
import { getConnector, type ProjectKey } from '@/config/projects.js'
import type { OrderKind, PendingReadingItem } from '@/shared/connectors/types.js'

const log = pino({ name: 'ensure-stuck' })

/**
 * "Stuck" = paid order still without a reading N minutes after createdAt.
 * ensureReading is triggered for every stuck item unconditionally; the
 * backend returns already-running / already-ready when a job is in flight
 * or done, so repeated triggers are cheap.
 */
export const STUCK_MINUTES = 30

/**
 * Cap for how many auto-regenerated rows to render per project in a
 * Discord report. ensureReading still fires for *all* stuck items — this
 * only prevents a big batch from blowing past Discord's 2000-char limit.
 */
export const MAX_REGEN_ROWS_PER_PROJECT = 15

export interface StuckCandidate {
  project: ProjectKey
  item: PendingReadingItem
  ageMin: number
}

export interface RegenResult {
  project: ProjectKey
  ref: string
  ageMin: number
  ok: boolean
  status?: 'already_ready' | 'pending' | 'running'
  jobId?: string
  error?: string
  /**
   * Set by a follow-up poller (see `pollAndEditReport`) once the job the
   * kick produced has resolved. Renderer prefers this over `status` so an
   * item that started as "queued" can end up as "✅ ready".
   */
  finalStatus?: 'done' | 'failed' | 'timeout'
  finalError?: string
}

/**
 * Fire `ensureReading` for every stuck candidate in parallel. Called from
 * both the monitor tick and the one-shot `!fix-pending` handler.
 */
export async function autoRegenerateStuck(
  candidates: StuckCandidate[],
): Promise<RegenResult[]> {
  if (candidates.length === 0) return []
  return Promise.all(
    candidates.map(async (cand): Promise<RegenResult> => {
      const connector = getConnector(cand.project)
      try {
        const res = await connector.ensureReading(
          cand.item.ref,
          cand.item.kind as OrderKind,
          { regenerate: false },
        )
        return {
          project: cand.project,
          ref: cand.item.ref,
          ageMin: cand.ageMin,
          ok: true,
          status: res.status,
          jobId: res.jobId,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.error(
          { err, ref: cand.item.ref, project: cand.project },
          'auto ensure-reading failed',
        )
        return {
          project: cand.project,
          ref: cand.item.ref,
          ageMin: cand.ageMin,
          ok: false,
          error: msg,
        }
      }
    }),
  )
}

export function formatRegenStatus(r: RegenResult): string {
  if (!r.ok) return `❌ ${r.error ?? 'error'}`
  if (r.finalStatus === 'done') return '✅ ready'
  if (r.finalStatus === 'failed') return `❌ job failed: ${r.finalError ?? 'unknown'}`
  if (r.finalStatus === 'timeout') {
    return `⏱️ still running (timeout${r.jobId ? `, job \`${r.jobId}\`` : ''})`
  }
  switch (r.status) {
    case 'already_ready':
      return '✅ already ready'
    case 'running':
      return `⏳ running${r.jobId ? ` (job \`${r.jobId}\`)` : ''}`
    case 'pending':
      return `🔄 queued${r.jobId ? ` (job \`${r.jobId}\`)` : ''}`
    default:
      return r.status ?? 'ok'
  }
}
