import { ObjectId } from 'mongodb'
import { getDb } from '@/shared/db/mongo.js'

export interface PendingApproval {
  _id?: ObjectId
  thread_id: string
  ticket_id: string
  project: string
  agent: string
  customer_email: string               // captured at draft time, used by executor
  drafted_action: Record<string, unknown>
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  /**
   * The message carrying the ✅ / ❌ reactions. Note this is NOT necessarily
   * in `thread_id` — on the DM route it's a message in the approver's DM
   * channel. The reaction handler keys off this id alone, which is what
   * makes approving from a DM work without touching the executor.
   */
  discord_message_id: string
  /**
   * Where the draft was posted for approval. 'thread' (default, and the only
   * value on rows written before the DM route existed) means in-thread; 'dm'
   * means it went to `approver_user_id` privately.
   */
  approval_channel?: 'thread' | 'dm'
  /**
   * When set, ONLY this Discord user may resolve the approval. Left unset on
   * the in-thread route, which preserves the historical behaviour of any
   * human in the channel being able to react.
   */
  approver_user_id?: string
  /**
   * Channel the request came from, when it isn't `thread_id` — used to report
   * the outcome back where the requester can see it. Set on the DM route so a
   * relaying bot gets its answer in the channel it asked in.
   */
  origin_channel_id?: string
  /** Discord user/bot id that asked for this action. Audit + reply addressing. */
  requested_by?: string
  created_at: Date
  expires_at: Date
  resolved_at?: Date
  resolved_by?: string
}

export async function attachDiscordMessageId(
  approvalId: ObjectId,
  messageId: string,
): Promise<void> {
  await collection().updateOne(
    { _id: approvalId },
    { $set: { discord_message_id: messageId } },
  )
}

/**
 * Attach the approval message id together with its routing metadata, for
 * drafts delivered somewhere other than the agent thread. One update rather
 * than an id-then-routing pair, so a reaction can never find a row that knows
 * its message id but not yet who is allowed to resolve it.
 */
export async function attachApprovalDelivery(
  approvalId: ObjectId,
  delivery: {
    discord_message_id: string
    approval_channel: 'thread' | 'dm'
    approver_user_id?: string
    origin_channel_id?: string
    requested_by?: string
  },
): Promise<void> {
  await collection().updateOne({ _id: approvalId }, { $set: delivery })
}

const collection = () => getDb().collection<PendingApproval>('pending_approvals')

export async function createApproval(
  approval: Omit<PendingApproval, '_id' | 'status' | 'created_at'>,
): Promise<ObjectId> {
  const result = await collection().insertOne({
    ...approval,
    status: 'pending',
    created_at: new Date(),
  } as PendingApproval)
  return result.insertedId
}

export async function resolveApproval(
  messageId: string,
  status: 'approved' | 'rejected',
  by: string,
): Promise<PendingApproval | null> {
  const result = await collection().findOneAndUpdate(
    { discord_message_id: messageId, status: 'pending' },
    { $set: { status, resolved_at: new Date(), resolved_by: by } },
    { returnDocument: 'after' },
  )
  return result
}

export async function findByMessageId(messageId: string): Promise<PendingApproval | null> {
  return collection().findOne({ discord_message_id: messageId })
}
