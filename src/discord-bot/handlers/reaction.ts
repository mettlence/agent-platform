import type { MessageReaction, PartialMessageReaction, User, PartialUser } from 'discord.js'
import pino from 'pino'
import { findByMessageId, resolveApproval } from '@/shared/state/approvals.js'
import { executeApprovedAction, type DraftAction } from '@/agents/cs-recovery/executor.js'
import { postToThread } from '@/shared/connectors/discord.js'

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

  try {
    const draft = approval.drafted_action as unknown as DraftAction
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

