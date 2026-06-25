import { getDb } from '@/shared/db/mongo.js'
import type { Message } from '@/shared/llm/client.js'

export interface AgentThread {
  _id: string                  // discord thread id
  ticket_id: string
  project: string
  agent: string
  status: 'active' | 'completed' | 'archived'
  messages: Message[]
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
