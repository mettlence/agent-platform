import type { MessageReaction, PartialMessageReaction, User, PartialUser } from 'discord.js'
import { ObjectId } from 'mongodb'
import pino from 'pino'
import { findByMessageId, resolveApproval } from '@/shared/state/approvals.js'
import { executeApprovedAction, type DraftAction } from '@/agents/cs-recovery/executor.js'
import { postToThread } from '@/shared/connectors/discord.js'
import { createMonitor } from '@/shared/state/monitors.js'
import { kickPendingMonitorLoop } from '@/agents/pending-monitor/loop.js'
import { getConnector, type ProjectKey } from '@/config/projects.js'
import type { OrderKind } from '@/shared/connectors/types.js'

const log = pino({ name: 'reaction-handler' })

const APPROVE = '✅'
const REJECT = '❌'

/**
 * Handle ✅ / ❌ reactions on draft messages.
 * Looks up the pending approval by message ID; if found and pending,
 * either executes the action (✅) or marks it rejected (❌).
 */
export async function handleReactionAdd(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
): Promise<void> {
  if (user.bot) return

  // Reactions may arrive as partials; fetch full state.
  if (reaction.partial) {
    try { await reaction.fetch() } catch (err) { log.warn({ err }, 'reaction fetch failed'); return }
  }
  if (reaction.message.partial) {
    try { await reaction.message.fetch() } catch (err) { log.warn({ err }, 'message fetch failed'); return }
  }

  const emoji = reaction.emoji.name
  if (emoji !== APPROVE && emoji !== REJECT) return

  const messageId = reaction.message.id
  const approval = await findByMessageId(messageId)
  if (!approval) return                        // not a tracked draft message
  if (approval.status !== 'pending') return    // already resolved

  const userId = user.id

  if (emoji === REJECT) {
    await resolveApproval(messageId, 'rejected', userId)
    await postToThread(approval.thread_id, `❌ Action skipped by <@${userId}>.`)
    return
  }

  // Approve flow.
  const resolved = await resolveApproval(messageId, 'approved', userId)
  if (!resolved) return                        // race — already resolved

  await postToThread(approval.thread_id, `✅ Approved by <@${userId}>. Executing...`)

  const draftedAction = approval.drafted_action as { action_type?: string } & Record<string, unknown>

  // pending-monitor auto-proposal — approve = call ensureReading for one
  // specific ref. Doesn't go through the cs-recovery executor because it
  // doesn't touch payment fields; it just kicks generation.
  if (draftedAction.action_type === 'ensure_reading_from_monitor') {
    try {
      const project = draftedAction.project as ProjectKey
      const ref = String(draftedAction.ref)
      const kind = draftedAction.kind as OrderKind
      const email = String(draftedAction.customer_email ?? '')
      const connector = getConnector(project)
      const res = await connector.ensureReading(ref, kind, { regenerate: false })
      const lines: string[] = [
        `📚 ensure-reading called for \`${ref}\` (${kind}, ${project}).`,
        `- Status: **${res.status}**`,
      ]
      if (res.jobId) lines.push(`- Job id: \`${res.jobId}\``)
      if (res.readingUrl) lines.push(`- Reading: ${res.readingUrl}`)
      if (res.downloadUrl) lines.push(`- Download: ${res.downloadUrl}`)
      if (res.status === 'already_ready') {
        lines.push('_Was already generated — surfaced above._')
      } else if (res.status === 'pending' || res.status === 'running') {
        lines.push(`_Generation is in flight. Reading URL will populate when the job finishes._`)
      }
      if (email) lines.push(`_Customer email on record: ${email}._`)
      await postToThread(approval.thread_id, lines.join('\n'))
    } catch (err) {
      log.error({ err, messageId, draftedAction }, 'ensure_reading_from_monitor failed')
      await postToThread(
        approval.thread_id,
        `❌ ensure-reading failed: \`${err instanceof Error ? err.message : String(err)}\``,
      )
    }
    return
  }

  // pending-monitor schedules skip the cs-recovery executor entirely — no
  // customer mutation, just a Mongo insert plus a friendly confirmation.
  if (draftedAction.action_type === 'schedule_pending_monitor') {
    try {
      const projects = draftedAction.projects as ProjectKey[]
      const intervalHours = Number(draftedAction.interval_hours)
      const durationHours = Number(draftedAction.duration_hours)
      const monitor = await createMonitor({
        thread_id: approval.thread_id,
        projects,
        interval_hours: intervalHours,
        duration_hours: durationHours,
        created_by_user_id: userId,
        created_by_approval_id: approval._id as ObjectId,
      })
      await postToThread(
        approval.thread_id,
        [
          `📡 Monitor scheduled.`,
          `- Projects: **${projects.join(', ')}**`,
          `- Interval: every ${humanizeDurationH(intervalHours)}`,
          `- Ticks: **${monitor.expected_ticks}** over ${humanizeDurationH(durationHours)}`,
          `- Expires: <t:${Math.floor(monitor.expires_at.getTime() / 1000)}:R>`,
          '- First tick fires within seconds.',
        ].join('\n'),
      )
      // Kick the loop so tick 1 lands promptly instead of waiting up to 60s.
      kickPendingMonitorLoop()
    } catch (err) {
      log.error({ err, messageId }, 'schedule pending-monitor failed')
      await postToThread(
        approval.thread_id,
        `❌ Failed to schedule monitor: \`${err instanceof Error ? err.message : String(err)}\``,
      )
    }
    return
  }

  try {
    const draft = draftedAction as unknown as DraftAction
    const result = await executeApprovedAction({
      draft,
      thread_id: approval.thread_id,
      ticket_id: approval.ticket_id,
      project: approval.project as 'asksabrina' | 'astroloversketch',
      customer_email: approval.customer_email,
      approved_by: userId,
    })

    if (result.ok) {
      const r = result.result ?? ({} as NonNullable<typeof result.result>)
      const lines: string[] = [
        `✅ Done.`,
        `- Action ID: \`${result.action_id?.toString() ?? '?'}\``,
      ]
      // Surface links by kind. Subscription has no reading job — its primary
      // link is the question page where the customer asks new questions.
      // Main / OTO have reading + download URLs; if the generation job is
      // still pending, tell CS to check back rather than imply failure.
      if (r.kind === 'subscription') {
        if (r.question_page_url) lines.push(`- Question page: ${r.question_page_url}`)
        if (r.download_link) lines.push(`- Download: ${r.download_link}`)
        if (!r.question_page_url && !r.download_link) {
          lines.push('- (no question page resolved — confirm subscription row was created on the correct main order)')
        }
      } else {
        if (r.reading_link) lines.push(`- Reading: ${r.reading_link}`)
        if (r.download_link) lines.push(`- Download: ${r.download_link}`)
        if (r.job_pending && r.job_id) {
          lines.push(`- (reading generation still running — job \`${r.job_id}\`. Re-run \`!cs <ticket>\` in a few minutes to fetch the link.)`)
        } else if (!r.reading_link && !r.download_link) {
          lines.push('- (no link resolved — check asksabrina admin for this order ref)')
        }
      }
      lines.push('', 'Send to customer or paste into LiveAgent reply.')
      await postToThread(approval.thread_id, lines.join('\n'))
    } else {
      const lines = [
        `❌ Execution failed.`,
        `Error: \`${result.error}\``,
        result.gate_failures?.length ? `Gate failures:\n${result.gate_failures.map((f) => `- ${f}`).join('\n')}` : '',
      ].filter(Boolean)
      await postToThread(approval.thread_id, lines.join('\n'))
    }
  } catch (err) {
    log.error({ err, messageId }, 'execution threw')
    await postToThread(
      approval.thread_id,
      `❌ Execution threw: \`${err instanceof Error ? err.message : String(err)}\``,
    )
  }
}

function humanizeDurationH(h: number): string {
  if (h >= 1) return `${h % 1 === 0 ? h : h.toFixed(1)}h`
  return `${Math.round(h * 60)}m`
}

