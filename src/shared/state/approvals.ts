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
