import { ObjectId } from 'mongodb'
import { getDb } from '@/shared/db/mongo.js'

export interface AgentAction {
  _id?: ObjectId
  thread_id: string
  ticket_id: string
  project: string
  agent: string
  action_type: 'update_order' | 'regenerate' | 'create_order' | 'escalate'
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  reasoning: string
  gates_passed: string[]
  approved_by: string | null      // discord user id, or null if auto
  approved_at: Date | null
  executed_at: Date
  result: 'success' | 'failure'
  error?: string
  result_meta?: Record<string, unknown>  // e.g., { reading_link }
  llm_meta?: {
    model: string
    input_tokens: number
    output_tokens: number
  }
  parent_action_id?: ObjectId    // for corrections referencing earlier action
}

const collection = () => getDb().collection<AgentAction>('agent_actions')

export async function recordAction(action: Omit<AgentAction, '_id'>): Promise<ObjectId> {
  const result = await collection().insertOne(action as AgentAction)
  return result.insertedId
}

export async function findByTicket(ticketId: string, project: string): Promise<AgentAction[]> {
  return collection()
    .find({ ticket_id: ticketId, project })
    .sort({ executed_at: -1 })
    .toArray()
}

export async function findByThread(threadId: string): Promise<AgentAction[]> {
  return collection().find({ thread_id: threadId }).sort({ executed_at: -1 }).toArray()
}
