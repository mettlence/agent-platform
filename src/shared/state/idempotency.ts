import { getDb } from '@/shared/db/mongo.js'
import type { ObjectId } from 'mongodb'

export interface IdempotencyKey {
  _id: string                  // e.g. "asksabrina:TZJ-...:update_order"
  thread_id: string
  action_id: ObjectId
  created_at: Date
  ttl_at: Date                 // TTL index target
}

const collection = () => getDb().collection<IdempotencyKey>('idempotency_keys')

/**
 * Try to claim an idempotency key. Returns true if claimed, false if already exists.
 * Caller should reject duplicate execution when this returns false.
 */
export async function claim(
  key: string,
  threadId: string,
  actionId: ObjectId,
  ttlHours = 24,
): Promise<boolean> {
  try {
    await collection().insertOne({
      _id: key,
      thread_id: threadId,
      action_id: actionId,
      created_at: new Date(),
      ttl_at: new Date(Date.now() + ttlHours * 3600 * 1000),
    })
    return true
  } catch (err) {
    // duplicate key
    if (err instanceof Error && err.message.includes('E11000')) return false
    throw err
  }
}

export async function findKey(key: string): Promise<IdempotencyKey | null> {
  return collection().findOne({ _id: key })
}
