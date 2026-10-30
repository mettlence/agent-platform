import type { MessageReaction, PartialMessageReaction, User, PartialUser } from 'discord.js'
import { ObjectId } from 'mongodb'
import pino from 'pino'
import { findByMessageId, resolveApproval, type PendingApproval } from '@/shared/state/approvals.js'
import { executeApprovedAction, type DraftAction } from '@/agents/cs-recovery/executor.js'
import { postToThread, sendDM } from '@/shared/connectors/discord.js'
import { createMonitor } from '@/shared/state/monitors.js'
import { kickPendingMonitorLoop } from '@/agents/pending-monitor/loop.js'
import type { ProjectKey } from '@/config/projects.js'

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

  // Approvals routed to a specific person (the DM relay route) may only be
  // resolved by that person. Rows without the field keep the original
  // behaviour where anyone in the channel can react.
  if (approval.approver_user_id && userId !== approval.approver_user_id) {
    log.warn(
      { messageId, userId, expected: approval.approver_user_id },
      'reaction ignored: not the designated approver',
    )
    return
  }

  if (emoji === REJECT) {
    await resolveApproval(messageId, 'rejected', userId)
    await announce(
      approval,
      `❌ Action skipped by <@${userId}>.`,
      `❌ <@${userId}> rejected the change for **${approval.ticket_id}** — nothing was modified.`,
    )
    return
  }

  // Approve flow.
  const resolved = await resolveApproval(messageId, 'approved', userId)
  if (!resolved) return                        // race — already resolved

  // Progress note goes to wherever the detail lives — the thread, or the DM
  // for relayed tickets. The origin channel gets one combined message after
  // the work finishes, not an "executing" line followed by a result line.
  if (approval.approval_channel === 'dm' && approval.approver_user_id) {
    await sendDM(approval.approver_user_id, `✅ Approved. Executing…`)
  } else {
    await postToThread(approval.thread_id, `✅ Approved by <@${userId}>. Executing...`)
  }

  const draftedAction = approval.drafted_action as { action_type?: string } & Record<string, unknown>

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
          lines.push(`- (reading generation still running — job \`${r.job_id}\`. Re-mention the bot with the same receipt in a few minutes to fetch the link.)`)
        } else if (!r.reading_link && !r.download_link) {
          lines.push('- (no link resolved — check asksabrina admin for this order ref)')
        }
        for (const f of r.followups ?? []) {
          const note =
            f.status === 'skipped_main_pending'
              ? 'skipped: the main reading was still generating, regenerate it once that is done'
              : f.status
          lines.push(`- ${f.kind} \`${f.ref}\` regenerated: ${note}`)
        }
      }
      lines.push('', 'Send to customer or paste into LiveAgent reply.')
      // Channel summary drops the action id and the internal instruction —
      // the requester only needs "approved, done, here's the link".
      const summary = [`✅ <@${userId}> approved — **${approval.ticket_id}** is done.`]
      if (r.question_page_url) summary.push(`- Question page: ${r.question_page_url}`)
      if (r.reading_link) summary.push(`- Reading: ${r.reading_link}`)
      if (r.download_link) summary.push(`- Download: ${r.download_link}`)
      if (r.job_pending) summary.push('- Reading is still generating — the link will work shortly.')
      await announce(approval, lines.join('\n'), summary.join('\n'))
    } else {
      const lines = [
        `❌ Execution failed.`,
        `Error: \`${result.error}\``,
        result.gate_failures?.length ? `Gate failures:\n${result.gate_failures.map((f) => `- ${f}`).join('\n')}` : '',
      ].filter(Boolean)
      await announce(
        approval,
        lines.join('\n'),
        `❌ <@${userId}> approved **${approval.ticket_id}** but execution failed: \`${result.error}\`. Nothing was changed.`,
      )
    }
  } catch (err) {
    log.error({ err, messageId }, 'execution threw')
    const msg = err instanceof Error ? err.message : String(err)
    await announce(
      approval,
      `❌ Execution threw: \`${msg}\``,
      `❌ **${approval.ticket_id}** failed during execution: \`${msg}\``,
    )
  }
}

/**
 * Post the detailed outcome to the agent thread, and — when the request was
 * relayed in from somewhere else — a short summary back to that channel.
 *
 * On the DM route the two land in different places: the thread keeps the full
 * audit trail, while the requesting channel gets the one line it's waiting on.
 * Same-target approvals post once, since origin equals thread.
 */
async function announce(
  approval: PendingApproval,
  detail: string,
  channelSummary?: string,
): Promise<void> {
  // Relayed tickets have no thread — their thread_id is the triggering
  // message id, which won't resolve as a channel. Their detail belongs in the
  // approver's DM anyway, which is where they just reacted.
  if (approval.approval_channel === 'dm' && approval.approver_user_id) {
    await sendDM(approval.approver_user_id, detail)
  } else {
    await postToThread(approval.thread_id, detail)
  }
  const origin = approval.origin_channel_id
  if (origin && origin !== approval.thread_id && channelSummary) {
    // Ping the humans the relaying bot tagged — usually the CS rep who owns
    // the ticket and has to paste the link into the customer reply. Without
    // this they'd have to be watching the channel to notice it landed.
    const notify = (approval.notify_user_ids ?? []).map((id) => `<@${id}>`).join(' ')
    await postToThread(origin, notify ? `${notify}\n${channelSummary}` : channelSummary)
  }
}

function humanizeDurationH(h: number): string {
  if (h >= 1) return `${h % 1 === 0 ? h : h.toFixed(1)}h`
  return `${Math.round(h * 60)}m`
}

