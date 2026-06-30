import { getDb } from '@/shared/db/mongo.js'
import type { Message } from '@/shared/llm/client.js'

/**
 * Persisted RunInput minus thread_id — what continueCsRecovery needs to
 * reconstruct ctx for a follow-up turn without the human re-supplying
 * email / receipt. Stored once when the thread is created.
 */
export interface ThreadInitCtx {
  customer_email: string
  clickbank_receipt?: string
  order_id?: string
  complaint_text?: string
  trigger_user_id: string
}

export interface AgentThread {
  _id: string                  // discord thread id
  ticket_id: string
  project: string
  agent: string
  status: 'active' | 'busy' | 'completed' | 'archived'
  messages: Message[]
  /** Present on threads created via mention/cs-command since the multi-turn
   *  refactor. Older threads predate this and won't have it — continuation
   *  on those should bail or ask the user to re-supply identifiers. */
  init_ctx?: ThreadInitCtx
  created_at: Date
  last_active_at: Date
}

const collection = () => getDb().collection<AgentThread>('agent_threads')

export async function getThread(threadId: string): Promise<AgentThread | null> {
  return collection().findOne({ _id: threadId })
}

export async function createThread(
  thread: Omit<AgentThread, 'created_at' | 'last_active_at' | 'status' | 'messages'> & {
    status?: AgentThread['status']
    messages?: Message[]
  },
): Promise<void> {
  const now = new Date()
  await collection().insertOne({
    ...thread,
    status: thread.status ?? 'active',
    messages: thread.messages ?? [],
    created_at: now,
    last_active_at: now,
  })
}

export async function appendMessage(threadId: string, message: Message): Promise<void> {
  await collection().updateOne(
    { _id: threadId },
    {
      $push: { messages: message },
      $set: { last_active_at: new Date() },
    },
  )
}

export async function setStatus(threadId: string, status: AgentThread['status']): Promise<void> {
  await collection().updateOne(
    { _id: threadId },
    { $set: { status, last_active_at: new Date() } },
  )
}

/**
 * Atomic busy-flip. Returns true if we claimed the lock, false if another run
 * is already in flight for this thread. The caller MUST call clearBusy in a
 * finally — otherwise the thread stays locked until the next setStatus call.
 */
export async function tryMarkBusy(threadId: string): Promise<boolean> {
  const r = await collection().updateOne(
    { _id: threadId, status: { $ne: 'busy' } },
    { $set: { status: 'busy', last_active_at: new Date() } },
  )
  return r.modifiedCount === 1
}

export async function clearBusy(threadId: string): Promise<void> {
  await collection().updateOne(
    { _id: threadId, status: 'busy' },
    { $set: { status: 'active', last_active_at: new Date() } },
  )
}
