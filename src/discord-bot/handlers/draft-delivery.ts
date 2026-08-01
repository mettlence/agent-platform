import type { ObjectId } from 'mongodb'
import { sendDM } from '@/shared/connectors/discord.js'
import { attachApprovalDelivery } from '@/shared/state/approvals.js'
import type { ThreadRelayCtx } from '@/shared/state/threads.js'

/**
 * Shared draft delivery for relayed tickets, used by both the first turn
 * (mention-command) and every follow-up turn (thread-continue).
 *
 * It lives here rather than in one handler because a relayed ticket that
 * loses the DM route on its second turn silently downgrades to "anyone in the
 * channel can approve" — the approval discipline has to survive follow-ups,
 * not just the opening message.
 */
export function formatDraft(draft: Record<string, unknown>): string {
  return [
    '📝 **Proposed action**',
    '```json',
    JSON.stringify(draft, null, 2),
    '```',
    'React ✅ to execute, ❌ to skip.',
  ].join('\n')
}

/**
 * DM the draft to the approver and record where the approval lives.
 *
 * Returns false when Discord refuses the DM, so the caller can fall back to
 * posting in-thread. A bounced DM must never leave the ticket waiting on an
 * approval that was never delivered.
 */
export async function deliverDraftByDM(opts: {
  relay: ThreadRelayCtx
  approvalId: ObjectId
  draft: Record<string, unknown>
  ticketId: string
  email: string
  project: string
  /** Only present on the threaded path; relayed tickets have no thread. */
  threadUrl?: string
  /** Marks a draft produced by a follow-up turn rather than the opening one. */
  followUp?: boolean
}): Promise<boolean> {
  const body = [
    `🔐 **Approval needed** — relayed ticket **${opts.ticketId}**${
      opts.followUp ? ' (follow-up)' : ''
    }`,
    `· customer: **${opts.email}**`,
    `· project: **${opts.project}**`,
    ...(opts.threadUrl ? [`· full investigation: ${opts.threadUrl}`] : []),
    '',
    formatDraft(opts.draft),
    '',
    'The requesting channel is waiting; I post the outcome there either way.',
  ].join('\n')

  const dm = await sendDM(opts.relay.approver_user_id, body)
  if (!dm) return false

  await attachApprovalDelivery(opts.approvalId, {
    discord_message_id: dm.id,
    approval_channel: 'dm',
    approver_user_id: opts.relay.approver_user_id,
    origin_channel_id: opts.relay.origin_channel_id,
    requested_by: opts.relay.requested_by,
    notify_user_ids: opts.relay.notify_user_ids,
  })
  await dm.react('✅')
  await dm.react('❌')
  return true
}
