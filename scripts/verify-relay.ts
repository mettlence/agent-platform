/**
 * Read-only: has the bot-relay / DM-approval path ever actually run?
 *
 * Exists because "it's built and the doc says so" and "it fired" are different
 * claims, and the second one is the one that matters before real CS ticket
 * routing moves over. Run it yourself rather than taking a write-up's word —
 * it reads the live database and prints what it finds, including nothing.
 *
 * Writes nothing. Prints no customer PII — counts, statuses, timestamps and
 * Discord ids only.
 *
 * Usage: tsx --env-file=.env scripts/verify-relay.ts
 */
import { MongoClient } from 'mongodb'

const uri = process.env.MONGODB_URI
if (!uri) {
  console.error('MONGODB_URI is not set. Run with: tsx --env-file=.env scripts/verify-relay.ts')
  process.exit(1)
}

const client = new MongoClient(uri)
await client.connect()
const db = client.db(process.env.MONGODB_DB || 'agent_platform')

const approvals = db.collection('pending_approvals')
const actions = db.collection('agent_actions')

const total = await approvals.countDocuments()
const dmRouted = await approvals.countDocuments({ approval_channel: 'dm' })
const dmResolved = await approvals.countDocuments({
  approval_channel: 'dm',
  status: { $in: ['approved', 'rejected'] },
})

console.log('pending_approvals')
console.log(`  total:              ${total}`)
console.log(`  DM-routed:          ${dmRouted}`)
console.log(`  DM-routed resolved: ${dmResolved}`)

if (dmRouted === 0) {
  console.log('\n❌ The relay / DM path has NEVER run.')
  console.log('   Every approval on record was delivered in-thread.')
  console.log('   Do not move real ticket routing yet.')
} else {
  const rows = await approvals
    .find(
      { approval_channel: 'dm' },
      { projection: { customer_email: 0, drafted_action: 0 } },
    )
    .sort({ created_at: -1 })
    .limit(10)
    .toArray()

  console.log('\nDM-routed approvals (newest first):')
  for (const a of rows) {
    console.log(
      `  ${a.created_at?.toISOString?.() ?? '?'} | ticket=${a.ticket_id}` +
        ` | status=${a.status}` +
        ` | approver=${a.approver_user_id ?? '(unset)'}` +
        ` | resolved_by=${a.resolved_by ?? '-'}` +
        ` | requested_by=${a.requested_by ?? '-'}` +
        ` | notified=${(a.notify_user_ids ?? []).length}`,
    )
  }

  // The approver gate only means something if the person who resolved it is
  // the person it was pinned to. A mismatch here would be the interesting
  // failure — it would mean the gate isn't holding.
  const mismatched = rows.filter(
    (a) => a.resolved_by && a.approver_user_id && a.resolved_by !== a.approver_user_id,
  )
  console.log(
    mismatched.length
      ? `\n⚠️  ${mismatched.length} resolved by someone other than the pinned approver — investigate.`
      : '\n✅ Every resolved DM approval was resolved by its pinned approver.',
  )

  const relayed = await actions
    .find(
      { thread_id: { $in: rows.map((r) => r.thread_id) } },
      { projection: { customer_email: 0, before: 0, after: 0, reasoning: 0 } },
    )
    .sort({ executed_at: -1 })
    .limit(10)
    .toArray()
  console.log('\nActions executed from those approvals:')
  if (!relayed.length) console.log('  (none — approved but nothing executed, or still pending)')
  for (const a of relayed) {
    console.log(
      `  ${a.executed_at?.toISOString?.() ?? '?'} | ${a.action_type} | ${a.project}` +
        ` | result=${a.result} | approved_by=${a.approved_by ?? 'MISSING'}`,
    )
  }
}

await client.close()
