/**
 * One-shot: create all Mongo indexes the platform depends on. Idempotent —
 * MongoDB no-ops if an equivalent index already exists. Safe to re-run.
 *
 * Reads MONGODB_URI + MONGODB_DB directly rather than through src/config/env
 * so it works even when non-Mongo env vars are stale locally.
 *
 * Usage: tsx --env-file=.env scripts/create-indexes.ts
 */
import { MongoClient, type CreateIndexesOptions, type IndexSpecification } from 'mongodb'

type Spec = [collection: string, key: IndexSpecification, opts?: CreateIndexesOptions]

const SPECS: Spec[] = [
  ['agent_threads', { ticket_id: 1, project: 1 }],
  ['agent_threads', { last_active_at: 1 }, { expireAfterSeconds: 2_592_000 }],
  ['agent_actions', { ticket_id: 1 }],
  ['agent_actions', { executed_at: -1 }],
  ['agent_actions', { thread_id: 1 }],
  ['pending_approvals', { discord_message_id: 1 }],
  ['pending_approvals', { status: 1, expires_at: 1 }],
  ['idempotency_keys', { ttl_at: 1 }, { expireAfterSeconds: 0 }],
  ['agent_lessons', { project: 1, agent: 1, active: 1 }],
  ['pending_monitors', { status: 1, next_run_at: 1 }],
  ['pending_monitors', { thread_id: 1, status: 1 }],
  ['pending_monitors', { ttl_at: 1 }, { expireAfterSeconds: 0 }],
]

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI
  const dbName = process.env.MONGODB_DB ?? 'agent_platform'
  if (!uri) {
    console.error('MONGODB_URI not set (--env-file=.env)')
    process.exit(1)
  }
  const client = new MongoClient(uri)
  await client.connect()
  const db = client.db(dbName)
  console.log(`Connected to db: ${dbName}`)
  for (const [name, spec, opts] of SPECS) {
    const idxName = await db.collection(name).createIndex(spec, opts)
    console.log(`  ✓ ${name.padEnd(20)} ${idxName}`)
  }
  await client.close()
  console.log('done')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
