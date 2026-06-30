import { ObjectId } from 'mongodb'
import * as clickbank from '@/shared/connectors/clickbank.js'
import { getConnector } from '@/config/projects.js'
import type { OrderKind, UnifiedCustomerView, UnifiedProduct } from '@/shared/connectors/types.js'
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
  /**
   * Required for `update_order` and `regenerate` — the existing order's mongo _id.
   * Omitted for `create_order` (no row to reference yet); use `customer_id` instead.
   */
  ref?: string
  order_kind: 'main' | 'oto1' | 'oto2' | 'subscription'
  payment_meta?: {
    clickbankReceipt: string
    amount: number
    currency: string
    transactionDate: string
    vendor: string
    productSku?: string
  }
  /**
   * The asksabrina customer.id this action targets. Required for `create_order`
   * (identifies which customer record to create the order on). For `update_order`
   * it is optional and acts as an identity bridge: when set, the gate tolerates a
   * payment-email vs optin-email mismatch as long as ClickBank's `vendorVariables.cId`
   * matches this value (cId bridge), OR `identity_via_receipt_email` is also set
   * (receipt-email bridge). The executor re-verifies the bridge at execution
   * time — never trusted from the draft alone.
   */
  customer_id?: string
  /**
   * When true, the gate accepts the receipt's billing email → DB customer
   * lookup as the identity bridge. Set by the agent only when (a) no cId is
   * present in ClickBank vendor variables and (b) `customer_id` was resolved
   * by looking up the receipt billing email in the project DB. Re-applied at
   * execute-time gate; the audit log captures it for review.
   */
  identity_via_receipt_email?: boolean
  /**
   * Required for `create_order` with kind oto1 / oto2 / subscription — the
   * mongo _id of the main Order this row links to. Backend rejects with 400
   * if missing. Ignored when kind is `main`.
   */
  main_order_id?: string
  /** Optional snapshot for create_order audit; backend falls back to customer.email. */
  billing_email?: string
  /** create_order kind=main only. Backend default 'v2'. */
  engine_version?: 'v1' | 'v2'
  /** create_order kind=main only. Customer's intake questions. */
  question?: string[]
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
    /**
     * Best link to surface to CS. For main/oto: the reading viewer.
     * For subscription: the question page where the customer asks a new
     * question. Undefined when not yet available (e.g. main reading job
     * is still running past the 5-min wait window).
     */
    reading_link?: string
    /** Order-area / download link (always v1 or v2 download page). */
    download_link?: string
    /** Subscription-only: page to ask a new question + view answer history. */
    question_page_url?: string
    /** Kind the action operated on — drives message formatting. */
    kind?: 'main' | 'oto1' | 'oto2' | 'subscription'
    job_id?: string
    /**
     * True when the executor returned before the reading generation job
     * finished. The message formatter should tell CS to check back later
     * rather than imply the link is missing forever.
     */
    job_pending?: boolean
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
      return executeCreateOrder(input)
    default:
      return { ok: false, error: `unknown action_type: ${(draft as DraftAction).action_type}` }
  }
}

async function executeUpdateOrder(input: ExecuteInput): Promise<ExecuteOutput> {
  const { draft, thread_id, ticket_id, project, customer_email, approved_by } = input

  if (!draft.payment_meta) {
    return { ok: false, error: 'update_order requires payment_meta' }
  }
  if (!draft.ref) {
    return { ok: false, error: 'update_order requires ref' }
  }

  // Re-verify ClickBank receipt at execution time.
  const order = await clickbank.getOrderByReceipt(draft.payment_meta.clickbankReceipt)
  const gate = verifyPaymentGate({
    order,
    expected_email: customer_email,
    expected_customer_id: draft.customer_id,
    identity_via_receipt_email: draft.identity_via_receipt_email,
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

  const conn = getConnector(project)

  try {
    const result = await conn.markOrderPaid({
      ref: draft.ref,
      kind: draft.order_kind,
      paymentMeta: draft.payment_meta,
    })

    // Chain regenerate immediately after mark-paid (the whole point of the action).
    const ensureRes = await conn.ensureReading(draft.ref, draft.order_kind)
    let jobId: string | undefined
    let jobPending = false

    if (ensureRes.status !== 'already_ready' && ensureRes.jobId) {
      jobId = ensureRes.jobId
      const finalJob = await conn.waitForJob(ensureRes.jobId, { timeoutMs: 5 * 60 * 1000 })
      if (finalJob?.status !== 'done') jobPending = true
    }

    const urls = await resolveActionUrls({
      project,
      customer_email,
      ref: draft.ref,
      kind: draft.order_kind,
    })

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
      result_meta: { ...urls, job_id: jobId },
    })

    return {
      ok: true,
      action_id: actionId,
      result: {
        before: result.before,
        after: result.after,
        ...urls,
        kind: draft.order_kind,
        job_id: jobId,
        job_pending: jobPending,
      },
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

  if (!draft.ref) {
    return { ok: false, error: 'regenerate requires ref' }
  }

  const idemKey = `${project}:${ticket_id}:regenerate:${draft.ref}`
  const placeholderId = new ObjectId()
  const claimed = await claimIdempotency(idemKey, thread_id, placeholderId)
  if (!claimed) {
    return { ok: false, error: 'idempotency: regenerate already executed' }
  }

  const conn = getConnector(project)

  try {
    const ensureRes = await conn.ensureReading(draft.ref, draft.order_kind)
    let jobId: string | undefined
    let jobPending = false

    if (ensureRes.status !== 'already_ready' && ensureRes.jobId) {
      jobId = ensureRes.jobId
      const finalJob = await conn.waitForJob(ensureRes.jobId, { timeoutMs: 5 * 60 * 1000 })
      if (finalJob?.status !== 'done') jobPending = true
    }

    const urls = await resolveActionUrls({
      project,
      customer_email,
      ref: draft.ref,
      kind: draft.order_kind,
    })

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
      result_meta: { ...urls, job_id: jobId },
    })

    return {
      ok: true,
      action_id: actionId,
      result: {
        before: {},
        after: { regenerated: true },
        ...urls,
        kind: draft.order_kind,
        job_id: jobId,
        job_pending: jobPending,
      },
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  }
}

async function executeCreateOrder(input: ExecuteInput): Promise<ExecuteOutput> {
  const { draft, thread_id, ticket_id, project, customer_email, approved_by } = input

  if (!draft.payment_meta) {
    return { ok: false, error: 'create_order requires payment_meta' }
  }
  if (!draft.customer_id) {
    return {
      ok: false,
      error:
        'create_order requires customer_id (the target customer.id from resolve_customer_identity / find_all_customer_records)',
    }
  }
  if (draft.order_kind !== 'main' && !draft.main_order_id) {
    return {
      ok: false,
      error: `create_order kind=${draft.order_kind} requires main_order_id (the mongo _id of the parent main Order). Backend rejects without it.`,
    }
  }

  const conn = getConnector(project)
  if (draft.order_kind === 'subscription' && !conn.supportsSubscription) {
    return {
      ok: false,
      error: `create_order kind=subscription is not supported on project ${project}.`,
    }
  }

  // Re-verify ClickBank receipt at execution time. Bridge identity via
  // customer_id so a payment/optin email mismatch is tolerated — either via
  // the cId vendor variable or, when no cId is present, via the receipt
  // billing email → DB customer lookup the agent already performed.
  const order = await clickbank.getOrderByReceipt(draft.payment_meta.clickbankReceipt)
  const gate = verifyPaymentGate({
    order,
    expected_email: customer_email,
    expected_customer_id: draft.customer_id,
    identity_via_receipt_email: draft.identity_via_receipt_email,
    expected_project: project,
  })
  if (!gate.passed) {
    await recordAction({
      thread_id,
      ticket_id,
      project,
      agent: 'cs-recovery',
      action_type: 'create_order',
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

  // For subscriptions, ensure the transaction type already verified by the
  // payment gate is one that represents an active billing (SALE for the
  // initial purchase, BILL for a recurring rebill). RFND/CGBK/CANCEL-REBILL
  // would have been blocked by the gate above; this is a defense-in-depth
  // re-check against the freshly fetched order.
  //
  // Earlier versions also called HEAD /orders2/<receipt> as an "is sub still
  // active" probe, but ClickBank returns 404 for order-bump child receipts
  // (e.g. SPR-OB1) even when the order is valid and refundable — the HEAD
  // endpoint only resolves the parent subscription receipt. Trusting the
  // 404 produced false negatives that blocked legitimate recoveries.
  if (draft.order_kind === 'subscription') {
    if (!order || (order.transaction_type !== 'SALE' && order.transaction_type !== 'BILL')) {
      await recordAction({
        thread_id,
        ticket_id,
        project,
        agent: 'cs-recovery',
        action_type: 'create_order',
        before: null,
        after: null,
        reasoning: `subscription transaction type is "${order?.transaction_type ?? 'unknown'}" at execution time`,
        gates_passed: draft.gates_passed,
        approved_by,
        approved_at: new Date(),
        executed_at: new Date(),
        result: 'failure',
        error: `subscription transaction type is "${order?.transaction_type ?? 'unknown'}" — expected SALE or BILL`,
      })
      return {
        ok: false,
        error: `subscription transaction type is "${order?.transaction_type ?? 'unknown'}" — expected SALE or BILL`,
      }
    }
  }

  // Idempotency by receipt — a single ClickBank receipt should only produce
  // one asksabrina order, regardless of how many tickets get filed against it.
  const idemKey = `${project}:create_order:${draft.payment_meta.clickbankReceipt}`
  const placeholderId = new ObjectId()
  const claimed = await claimIdempotency(idemKey, thread_id, placeholderId)
  if (!claimed) {
    return { ok: false, error: 'idempotency: this receipt already produced an order' }
  }

  try {
    const created = await conn.createOrder({
      customerId: draft.customer_id,
      kind: draft.order_kind,
      paymentMeta: { ...draft.payment_meta, productSku: draft.payment_meta.productSku ?? '' },
      ...(draft.main_order_id ? { mainOrderId: draft.main_order_id } : {}),
      ...(draft.billing_email ? { billingEmail: draft.billing_email } : {}),
      ...(draft.engine_version ? { engineVersion: draft.engine_version } : {}),
      ...(draft.question ? { question: draft.question } : {}),
    })

    // Chain delivery for main/oto only. Subscription readings are per-question
    // and filled in later by the customer — server creates an empty record.
    let jobId: string | undefined
    let jobPending = false

    if (draft.order_kind !== 'subscription') {
      const ensureRes = await conn.ensureReading(created.ref, draft.order_kind)
      if (ensureRes.status !== 'already_ready' && ensureRes.jobId) {
        jobId = ensureRes.jobId
        const finalJob = await conn.waitForJob(ensureRes.jobId, { timeoutMs: 5 * 60 * 1000 })
        if (finalJob?.status !== 'done') jobPending = true
      }
    }

    const urls = await resolveActionUrls({
      project,
      customer_email,
      ref: created.ref,
      kind: draft.order_kind,
    })

    const actionId = await recordAction({
      thread_id,
      ticket_id,
      project,
      agent: 'cs-recovery',
      action_type: 'create_order',
      before: null,
      after: created.after,
      reasoning: draft.reasoning,
      gates_passed: draft.gates_passed,
      approved_by,
      approved_at: new Date(),
      executed_at: new Date(),
      result: 'success',
      result_meta: { ...urls, job_id: jobId, created_ref: created.ref },
    })

    return {
      ok: true,
      action_id: actionId,
      result: {
        before: {},
        after: created.after,
        ...urls,
        kind: draft.order_kind,
        job_id: jobId,
        job_pending: jobPending,
      },
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await recordAction({
      thread_id,
      ticket_id,
      project,
      agent: 'cs-recovery',
      action_type: 'create_order',
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

/**
 * Pull every URL CS might want to paste, based on what kind of action just
 * succeeded. Main/oto/oto2 surface the reading viewer + download page;
 * subscription surfaces the question page (where the customer asks new
 * questions) + the parent main order's download page.
 */
async function resolveActionUrls(opts: {
  project: Project
  customer_email: string
  ref: string
  kind: OrderKind
}): Promise<{
  reading_link?: string
  download_link?: string
  question_page_url?: string
}> {
  const view = await getConnector(opts.project).lookupCustomer(opts.customer_email).catch(() => null)
  if (!view) return {}

  if (opts.kind === 'subscription') {
    return {
      question_page_url: view.subscription?.questionPageUrl ?? undefined,
      // The download/order-area link for a subscription customer is the
      // main order's downloadUrl — same page they got at purchase time.
      download_link: view.mainOrders[0]?.downloadUrl ?? undefined,
    }
  }

  const buckets: UnifiedProduct[] =
    opts.kind === 'main'
      ? view.mainOrders
      : opts.kind === 'oto1'
        ? view.oto1Orders
        : view.oto2Orders
  const match = buckets.find((p) => p.ref === opts.ref)
  return {
    reading_link: match?.readingUrl ?? undefined,
    download_link: match?.downloadUrl ?? undefined,
  }
}
