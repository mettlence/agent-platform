import { ObjectId } from 'mongodb'
import * as clickbank from '@/shared/connectors/clickbank.js'
import * as asksabrina from '@/shared/connectors/asksabrina.js'
import { verifyPaymentGate } from '@/shared/gates/payment-verify.js'
import { claim as claimIdempotency } from '@/shared/state/idempotency.js'
import { recordAction } from '@/shared/state/actions.js'
import type { Project } from './index.js'

export interface ExecuteInput {
  draft: DraftAction
  thread_id: string
  ticket_id: string
  project: Project
  customer_email: string
  approved_by: string                  // discord user id
}

export interface DraftAction {
  action_type: 'update_order' | 'regenerate' | 'create_order'
  project: Project
  ref: string
  order_kind: 'main' | 'oto1' | 'oto2' | 'subscription'
  payment_meta?: {
    clickbankReceipt: string
    amount: number
    currency: string
    transactionDate: string
    vendor: string
    productSku?: string
  }
  before?: Record<string, unknown>
  after?: Record<string, unknown>
  reasoning: string
  gates_passed: string[]
}

export interface ExecuteOutput {
  ok: boolean
  action_id?: ObjectId
  result?: {
    before: Record<string, unknown>
    after: Record<string, unknown>
    reading_link?: string
    job_id?: string
  }
  error?: string
  gate_failures?: string[]
}

/**
 * Execute an approved draft action. Re-runs the payment gate immediately
 * before any DB mutation — never trust the gate state captured at draft
 * time, since the world may have changed (refund issued, receipt revoked).
 */
export async function executeApprovedAction(input: ExecuteInput): Promise<ExecuteOutput> {
  const { draft } = input

  switch (draft.action_type) {
    case 'update_order':
      return executeUpdateOrder(input)
    case 'regenerate':
      return executeRegenerate(input)
    case 'create_order':
      // create_order is too high-risk for the trial period; force escalation.
      return {
        ok: false,
        error: 'create_order is not auto-executable in MVP — must be done manually',
      }
    default:
      return { ok: false, error: `unknown action_type: ${(draft as DraftAction).action_type}` }
  }
}

async function executeUpdateOrder(input: ExecuteInput): Promise<ExecuteOutput> {
  const { draft, thread_id, ticket_id, project, customer_email, approved_by } = input

  if (!draft.payment_meta) {
    return { ok: false, error: 'update_order requires payment_meta' }
  }

  // Re-verify ClickBank receipt at execution time.
  const order = await clickbank.getOrderByReceipt(draft.payment_meta.clickbankReceipt)
  const gate = verifyPaymentGate({
    order,
    expected_email: customer_email,
    expected_project: project,
  })
  if (!gate.passed) {
    await recordAction({
      thread_id,
      ticket_id,
      project,
      agent: 'cs-recovery',
      action_type: 'update_order',
      before: null,
      after: null,
      reasoning: 'GATE FAILED at execution time',
      gates_passed: [],
      approved_by,
      approved_at: new Date(),
      executed_at: new Date(),
      result: 'failure',
      error: `gate failed: ${gate.failures.join('; ')}`,
    })
    return { ok: false, error: 'gate failed at execution', gate_failures: gate.failures }
  }

  // Idempotency: prevent double-execute.
  const idemKey = `${project}:${ticket_id}:update_order:${draft.ref}`
  const placeholderId = new ObjectId()
  const claimed = await claimIdempotency(idemKey, thread_id, placeholderId)
  if (!claimed) {
    return { ok: false, error: 'idempotency: this action already executed' }
  }

  try {
    const result = await asksabrina.markOrderPaid({
      ref: draft.ref,
      kind: draft.order_kind,
      paymentMeta: draft.payment_meta,
    })

    // Chain regenerate immediately after mark-paid (the whole point of the action).
    const ensureRes = await asksabrina.ensureReading(draft.ref, draft.order_kind)
    let readingLink: string | undefined
    let jobId: string | undefined

    if (ensureRes.status === 'already_ready') {
      readingLink = ensureRes.readingUrl ?? ensureRes.downloadUrl
    } else if (ensureRes.jobId) {
      jobId = ensureRes.jobId
      const finalJob = await asksabrina.waitForJob(ensureRes.jobId, { timeoutMs: 5 * 60 * 1000 })
      if (finalJob?.status === 'done') {
        const view = await asksabrina.lookupCustomer(customer_email)
        readingLink = findReadingLink(view, draft.ref, draft.order_kind) ?? undefined
      }
    }

    const actionId = await recordAction({
      thread_id,
      ticket_id,
      project,
      agent: 'cs-recovery',
      action_type: 'update_order',
      before: result.before,
      after: result.after,
      reasoning: draft.reasoning,
      gates_passed: draft.gates_passed,
      approved_by,
      approved_at: new Date(),
      executed_at: new Date(),
      result: 'success',
      result_meta: { reading_link: readingLink, job_id: jobId },
    })

    return {
      ok: true,
      action_id: actionId,
      result: { before: result.before, after: result.after, reading_link: readingLink, job_id: jobId },
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await recordAction({
      thread_id,
      ticket_id,
      project,
      agent: 'cs-recovery',
      action_type: 'update_order',
      before: null,
      after: null,
      reasoning: draft.reasoning,
      gates_passed: draft.gates_passed,
      approved_by,
      approved_at: new Date(),
      executed_at: new Date(),
      result: 'failure',
      error: msg,
    })
    return { ok: false, error: msg }
  }
}

async function executeRegenerate(input: ExecuteInput): Promise<ExecuteOutput> {
  const { draft, thread_id, ticket_id, project, customer_email, approved_by } = input

  const idemKey = `${project}:${ticket_id}:regenerate:${draft.ref}`
  const placeholderId = new ObjectId()
  const claimed = await claimIdempotency(idemKey, thread_id, placeholderId)
  if (!claimed) {
    return { ok: false, error: 'idempotency: regenerate already executed' }
  }

  try {
    const ensureRes = await asksabrina.ensureReading(draft.ref, draft.order_kind)
    let readingLink: string | undefined
    let jobId: string | undefined

    if (ensureRes.status === 'already_ready') {
      readingLink = ensureRes.readingUrl ?? ensureRes.downloadUrl
    } else if (ensureRes.jobId) {
      jobId = ensureRes.jobId
      const finalJob = await asksabrina.waitForJob(ensureRes.jobId, { timeoutMs: 5 * 60 * 1000 })
      if (finalJob?.status === 'done') {
        const view = await asksabrina.lookupCustomer(customer_email)
        readingLink = findReadingLink(view, draft.ref, draft.order_kind) ?? undefined
      }
    }

    const actionId = await recordAction({
      thread_id,
      ticket_id,
      project,
      agent: 'cs-recovery',
      action_type: 'regenerate',
      before: null,
      after: { regenerated: true },
      reasoning: draft.reasoning,
      gates_passed: draft.gates_passed,
      approved_by,
      approved_at: new Date(),
      executed_at: new Date(),
      result: 'success',
      result_meta: { reading_link: readingLink, job_id: jobId },
    })

    return {
      ok: true,
      action_id: actionId,
      result: { before: {}, after: { regenerated: true }, reading_link: readingLink, job_id: jobId },
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  }
}

function findReadingLink(
  view: asksabrina.AsksabrinaCustomerView | null,
  ref: string,
  kind: asksabrina.OrderKind,
): string | null {
  if (!view) return null
  const buckets: asksabrina.AsksabrinaProduct[] =
    kind === 'main' ? view.mainOrders : kind === 'oto1' ? view.oto1Orders : kind === 'oto2' ? view.oto2Orders : []
  const match = buckets.find((p) => p.ref === ref)
  return match?.readingUrl ?? match?.downloadUrl ?? null
}
