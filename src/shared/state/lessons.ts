import { ObjectId } from 'mongodb'
import { getDb } from '@/shared/db/mongo.js'

export interface AgentLesson {
  _id?: ObjectId
  key: string                          // human-readable slug, unique per project
  project: string                      // e.g. 'asksabrina' — or '*' for cross-project
  agent: string                        // e.g. 'cs-recovery'
  pattern: string                      // 1-line what happens
  rule: string                         // 1-line what to do about it
  active: boolean
  source?: string                      // ticket id / thread id where this was learned
  added_by?: string                    // discord user id or 'system'
  created_at: Date
  updated_at: Date
}

const collection = () => getDb().collection<AgentLesson>('agent_lessons')

/**
 * Load active lessons for a project (and cross-project lessons marked '*').
 * Cheap query — keep results small (lessons are 1-2 lines).
 */
export async function loadActiveLessons(
  project: string,
  agent = 'cs-recovery',
): Promise<AgentLesson[]> {
  return collection()
    .find({
      agent,
      active: true,
      $or: [{ project }, { project: '*' }],
    })
    .sort({ created_at: -1 })
    .toArray()
}

export async function addLesson(
  lesson: Omit<AgentLesson, '_id' | 'created_at' | 'updated_at' | 'active'> & { active?: boolean },
): Promise<ObjectId> {
  const now = new Date()
  const result = await collection().insertOne({
    ...lesson,
    active: lesson.active ?? true,
    created_at: now,
    updated_at: now,
  } as AgentLesson)
  return result.insertedId
}

export async function deactivateLesson(key: string, project: string): Promise<void> {
  await collection().updateOne(
    { key, project },
    { $set: { active: false, updated_at: new Date() } },
  )
}
