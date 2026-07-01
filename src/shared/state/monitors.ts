import { ObjectId } from 'mongodb'
import { getDb } from '@/shared/db/mongo.js'
import type { ProjectKey } from '@/config/projects.js'

/**
 * Scheduled pending-order monitor. One row per active schedule. Ticks fire
 * from an in-process loop (see agents/pending-monitor/loop.ts); each tick
 * calls listPendingReadings on the target projects, diffs against
 * `last_snapshot`, and posts a report to `thread_id`.
 *
 * `expires_at` is the hard stop. Once `next_run_at > expires_at`, the loop
 * marks the row as 'expired' and posts a closing message. A grace TTL keeps
 * expired rows for a week so operators can inspect what ran.
 */
export interface PendingMonitor {
  _id?: ObjectId
  thread_id: string
  projects: ProjectKey[]
  interval_hours: number
  duration_hours: number
  started_at: Date
  expires_at: Date
  next_run_at: Date
  last_run_at: Date | null
  /** Per-project snapshot of refs seen at the last tick. Used for diffing. */
  last_snapshot: Partial<Record<ProjectKey, string[]>>
  /** Per-project { ref → firstSeenAt } — lets us report age of stuck items. */
  first_seen_at: Partial<Record<ProjectKey, Record<string, string>>>
  tick_count: number
  status: 'active' | 'expired' | 'stopped'
  created_by_user_id: string
  created_by_approval_id?: ObjectId
  /** TTL cleanup: kept N days past expires_at so operators can inspect. */
  ttl_at: Date
}

const collection = () => getDb().collection<PendingMonitor>('pending_monitors')

const GRACE_DAYS = 7

export async function createMonitor(input: {
  thread_id: string
  projects: ProjectKey[]
  interval_hours: number
  duration_hours: number
  created_by_user_id: string
  created_by_approval_id?: ObjectId
}): Promise<PendingMonitor> {
  const now = new Date()
  const expires = new Date(now.getTime() + input.duration_hours * 3600_000)
  const ttl = new Date(expires.getTime() + GRACE_DAYS * 86_400_000)
  const doc: PendingMonitor = {
    thread_id: input.thread_id,
    projects: input.projects,
    interval_hours: input.interval_hours,
    duration_hours: input.duration_hours,
    started_at: now,
    expires_at: expires,
    // Fire the first tick immediately so the user sees value on ✅.
    next_run_at: now,
    last_run_at: null,
    last_snapshot: {},
    first_seen_at: {},
    tick_count: 0,
    status: 'active',
    created_by_user_id: input.created_by_user_id,
    created_by_approval_id: input.created_by_approval_id,
    ttl_at: ttl,
  }
  const r = await collection().insertOne(doc)
  return { ...doc, _id: r.insertedId }
}

export async function findActiveByThread(threadId: string): Promise<PendingMonitor | null> {
  return collection().findOne({ thread_id: threadId, status: 'active' })
}

/**
 * One-shot "give me monitors due to tick" query, ordered by next_run_at so
 * the oldest-due fires first. `active` status is the atomic gate — the tick
 * loop should also perform its own idempotency check per monitor.
 */
export async function findDueMonitors(now: Date, limit = 20): Promise<PendingMonitor[]> {
  return collection()
    .find({ status: 'active', next_run_at: { $lte: now } })
    .sort({ next_run_at: 1 })
    .limit(limit)
    .toArray()
}

/**
 * Atomically claim a monitor for a tick. Advances `next_run_at` and bumps
 * `tick_count`. Returns the pre-update doc when we claimed, or null when
 * another worker beat us or the monitor is no longer active.
 */
export async function claimTick(
  monitorId: ObjectId,
  now: Date,
  intervalHours: number,
): Promise<PendingMonitor | null> {
  const nextRun = new Date(now.getTime() + intervalHours * 3600_000)
  const result = await collection().findOneAndUpdate(
    { _id: monitorId, status: 'active', next_run_at: { $lte: now } },
    { $set: { last_run_at: now, next_run_at: nextRun }, $inc: { tick_count: 1 } },
    { returnDocument: 'before' },
  )
  return result
}

export async function recordSnapshot(
  monitorId: ObjectId,
  snapshot: PendingMonitor['last_snapshot'],
  firstSeen: PendingMonitor['first_seen_at'],
): Promise<void> {
  await collection().updateOne(
    { _id: monitorId },
    { $set: { last_snapshot: snapshot, first_seen_at: firstSeen } },
  )
}

export async function markExpired(monitorId: ObjectId): Promise<void> {
  await collection().updateOne(
    { _id: monitorId, status: 'active' },
    { $set: { status: 'expired' } },
  )
}

export async function stopMonitor(threadId: string, by: string): Promise<PendingMonitor | null> {
  const result = await collection().findOneAndUpdate(
    { thread_id: threadId, status: 'active' },
    { $set: { status: 'stopped', ttl_at: new Date(Date.now() + GRACE_DAYS * 86_400_000) } },
    { returnDocument: 'after' },
  )
  if (result) {
    // Cheap audit — who stopped it — stored inline so we don't need a second collection.
    await collection().updateOne({ _id: result._id }, { $set: { stopped_by: by } as never })
  }
  return result
}
