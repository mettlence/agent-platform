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
  discord_message_id: string
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

/**
 * Dedup lookup for monitor auto-proposals. Returns a still-pending approval
 * that targets the same {thread, project, ref, kind}, so we don't re-post
 * the same "recover this order?" prompt on every tick while the operator
 * has yet to react. Scans `drafted_action.*` — pending_approvals is small
 * and short-lived (7d TTL) so this is fine without a compound index.
 */
export async function findPendingByRef(
  thread_id: string,
  project: string,
  ref: string,
  kind: string,
): Promise<PendingApproval | null> {
  return collection().findOne({
    thread_id,
    status: 'pending',
    'drafted_action.action_type': 'ensure_reading_from_monitor',
    'drafted_action.project': project,
    'drafted_action.ref': ref,
    'drafted_action.kind': kind,
  })
}
