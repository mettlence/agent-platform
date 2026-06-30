import { env } from '@/config/env.js'

export type OrderKind = 'main' | 'oto1' | 'oto2' | 'subscription'

/**
 * Normalized "thing the agent can act on". Maps over the customer-view shape
 * returned by the existing asksabrina /lookup endpoint.
 */
export interface AsksabrinaProduct {
  kind: OrderKind
  ref: string                          // Mongo _id — pass back to ensure-reading / mark-paid
  orderId: string | null
  orderIdClickBank: string | null
  engineVersion?: 'v1' | 'v2'
  paymentDate?: string | null
  readingReady: boolean
  downloadUrl?: string | null
  readingUrl?: string | null
  activeJob?: AsksabrinaJob | null
}

export interface AsksabrinaCustomerView {
  matchedVia: string
  customer: {
    id: string
    email: string
    firstName?: string
    lastName?: string
  }
  mainOrders: AsksabrinaProduct[]
  oto1Orders: AsksabrinaProduct[]
  oto2Orders: AsksabrinaProduct[]
  subscription?: {
    kind: 'subscription'
    ref: string
    status?: string
    orderIdClickBank?: string
    paymentDate?: string
    lastPaymentDate?: string
    questionPageUrl?: string | null
    questions: Array<{
      ref: string
      orderId: string
      question: string
      answer?: string
      readingReady: boolean
      completed: boolean
      createdAt: string
      activeJob?: AsksabrinaJob | null
    }>
  } | null
}

export interface AsksabrinaJob {
  id: string
  status: 'pending' | 'running' | 'done' | 'failed'
  attempts: number
  lastError?: string | null
  startedAt?: string | null
  finishedAt?: string | null
}

const headers = () => ({
  'X-API-Key': env.ASKSABRINA_AGENT_KEY,
  'Content-Type': 'application/json',
  Accept: 'application/json',
})

/**
 * Fuzzy customer lookup. Accepts email, ClickBank receipt, internal orderId, or Mongo _id.
 * Returns the full customer view (all products + download/reading URLs) or null.
 */
export async function lookupCustomer(q: string): Promise<AsksabrinaCustomerView | null> {
  const url = new URL(`${env.ASKSABRINA_API_BASE}/lookup`)
  url.searchParams.set('q', q)
  const res = await fetch(url, { headers: headers() })
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`asksabrina lookup failed: ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as AsksabrinaCustomerView
}

/**
 * Trigger reading regeneration. Returns { status, jobId, pollUrl } when async,
 * or { status: 'already_ready', readingUrl, downloadUrl } when already done.
 */
export interface EnsureReadingResponse {
  status: 'already_ready' | 'pending' | 'running'
  jobId?: string
  pollUrl?: string
  readingUrl?: string
  downloadUrl?: string
}

export async function ensureReading(
  ref: string,
  kind: OrderKind,
  opts: { regenerate?: boolean } = {},
): Promise<EnsureReadingResponse> {
  const res = await fetch(`${env.ASKSABRINA_API_BASE}/ensure-reading`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ ref, kind, ...(opts.regenerate ? { regenerate: true } : {}) }),
  })
  if (!res.ok) {
    throw new Error(`asksabrina ensureReading failed: ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as EnsureReadingResponse
}

export async function getJob(jobId: string): Promise<AsksabrinaJob | null> {
  const res = await fetch(`${env.ASKSABRINA_API_BASE}/jobs/${encodeURIComponent(jobId)}`, {
    headers: headers(),
  })
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`asksabrina getJob failed: ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as AsksabrinaJob
}

/**
 * Poll a generation job until it reaches a terminal state or times out.
 * Returns the final job state. Caller decides what to do with it.
 */
export async function waitForJob(
  jobId: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<AsksabrinaJob | null> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000
  const intervalMs = opts.intervalMs ?? 5000
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const job = await getJob(jobId)
    if (!job) return null
    if (job.status === 'done' || job.status === 'failed') return job
    await sleep(intervalMs)
  }
  return getJob(jobId)
}

/**
 * Mark an order as paid + attach payment metadata. Payment-touching write.
 * NEVER call without re-verifying the gate immediately before.
 *
 * Calls POST /mark-paid on the asksabrina agent API. See server-side handler
 * docs/agent-mark-paid.md (added alongside this connector).
 */
export interface MarkOrderPaidInput {
  ref: string
  kind: OrderKind
  paymentMeta: {
    clickbankReceipt: string
    amount: number
    currency: string
    transactionDate: string
    vendor: string
    productSku?: string
  }
}

export interface MarkOrderPaidResponse {
  ok: true
  ref: string
  kind: OrderKind
  before: Record<string, unknown>
  after: Record<string, unknown>
}

export async function markOrderPaid(input: MarkOrderPaidInput): Promise<MarkOrderPaidResponse> {
  const res = await fetch(`${env.ASKSABRINA_API_BASE}/mark-paid`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    throw new Error(`asksabrina markOrderPaid failed: ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as MarkOrderPaidResponse
}

/**
 * Create a missing order on an existing customer record. Used when a valid
 * ClickBank receipt exists but the corresponding order row was never written
 * to asksabrina's DB (funnel handler dropped it / race condition).
 *
 * Server contract (POST /create-order):
 *  - Idempotent on `paymentMeta.clickbankReceipt` — same receipt twice
 *    returns 409 with `{ existing_ref }` and is treated as failure here so
 *    callers can compare against their idempotency_keys table.
 *  - Validates customerId exists; 404 if not.
 *  - For `kind: 'subscription'`, creates an active subscription record with
 *    `questions: []` (customer fills them later).
 *  - For `kind: 'main' | 'oto1' | 'oto2'`, creates the order row only;
 *    caller is expected to chain `ensureReading(ref, kind)` for delivery.
 *  - Returns `{ ok, ref, kind, before: null, after: <created> }`.
 */
export interface CreateOrderInput {
  customerId: string
  kind: OrderKind
  paymentMeta: {
    clickbankReceipt: string
    amount: number
    currency: string
    transactionDate: string
    vendor: string
    productSku?: string
  }
  /** REQUIRED by backend for oto1 / oto2 / subscription. Omit only for kind=main. */
  mainOrderId?: string
  /** Optional snapshot for audit; backend falls back to customer.email when omitted. */
  billingEmail?: string
  /** Main only. Defaults to 'v2' server-side when omitted. */
  engineVersion?: 'v1' | 'v2'
  /** Main only. Customer's intake questions (from Maropost contact when funnel skipped optin). */
  question?: string[]
}

export interface CreateOrderResponse {
  ok: true
  ref: string
  kind: OrderKind
  before: null
  after: Record<string, unknown>
}

export async function createOrder(input: CreateOrderInput): Promise<CreateOrderResponse> {
  const res = await fetch(`${env.ASKSABRINA_API_BASE}/create-order`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(input),
  })
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { existing_ref?: string; error?: string }
    throw new Error(
      `asksabrina createOrder: receipt already has an order${
        body.existing_ref ? ` (ref=${body.existing_ref})` : ''
      }`,
    )
  }
  if (!res.ok) {
    throw new Error(`asksabrina createOrder failed: ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as CreateOrderResponse
}

export interface UpdateCustomerProfileInput {
  customerId: string
  patch: Record<string, unknown>
  reason?: string
}

export interface UpdateCustomerProfileResponse {
  ok: true
  customerId: string
  before: Record<string, unknown>
  after: Record<string, unknown>
}

export async function updateCustomerProfile(
  input: UpdateCustomerProfileInput,
): Promise<UpdateCustomerProfileResponse> {
  const res = await fetch(`${env.ASKSABRINA_API_BASE}/customer/${encodeURIComponent(input.customerId)}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify({
      patch: input.patch,
      ...(input.reason ? { reason: input.reason } : {}),
    }),
  })
  if (!res.ok) {
    throw new Error(`asksabrina updateCustomerProfile failed: ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as UpdateCustomerProfileResponse
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
