import { env } from '@/config/env.js'

/**
 * astroloversketch agent API connector. Mirrors the asksabrina shape (modulo
 * the parts astrolover doesn't have: no subscription kind, no engineVersion,
 * no question[] field). Server contract lives in:
 *   astroloversketch.com/api/src/routers/agent-router.js
 */

export type OrderKind = 'main' | 'oto1' | 'oto2'

export interface AstroloversketchProduct {
  kind: OrderKind
  ref: string
  orderId: string | null
  orderIdClickBank: string | null
  paymentDate?: string | null
  readingReady: boolean
  downloadUrl?: string | null
  readingUrl?: string | null
  activeJob?: AstroloversketchJob | null
}

export interface AstroloversketchCustomerView {
  matchedVia: string
  customer: {
    id: string
    email: string
    firstName?: string
    lastName?: string
  }
  mainOrders: AstroloversketchProduct[]
  oto1Orders: AstroloversketchProduct[]
  oto2Orders: AstroloversketchProduct[]
}

export interface AstroloversketchJob {
  id: string
  status: 'pending' | 'running' | 'done' | 'failed'
  attempts: number
  lastError?: string | null
  startedAt?: string | null
  finishedAt?: string | null
}

const baseUrl = (): string => {
  const v = env.ASTROLOVERSKETCH_API_BASE
  if (!v) throw new Error('ASTROLOVERSKETCH_API_BASE is not configured')
  return v
}

const headers = () => {
  const key = env.ASTROLOVERSKETCH_AGENT_KEY
  if (!key) throw new Error('ASTROLOVERSKETCH_AGENT_KEY is not configured')
  return {
    'X-API-Key': key,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
}

export async function lookupCustomer(q: string): Promise<AstroloversketchCustomerView | null> {
  const url = new URL(`${baseUrl()}/lookup`)
  url.searchParams.set('q', q)
  const res = await fetch(url, { headers: headers() })
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`astroloversketch lookup failed: ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as AstroloversketchCustomerView
}

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
  const res = await fetch(`${baseUrl()}/ensure-reading`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ ref, kind, ...(opts.regenerate ? { regenerate: true } : {}) }),
  })
  if (!res.ok) {
    throw new Error(`astroloversketch ensureReading failed: ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as EnsureReadingResponse
}

export async function getJob(jobId: string): Promise<AstroloversketchJob | null> {
  const res = await fetch(`${baseUrl()}/jobs/${encodeURIComponent(jobId)}`, {
    headers: headers(),
  })
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`astroloversketch getJob failed: ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as AstroloversketchJob
}

export async function waitForJob(
  jobId: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<AstroloversketchJob | null> {
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
  const res = await fetch(`${baseUrl()}/mark-paid`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    throw new Error(`astroloversketch markOrderPaid failed: ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as MarkOrderPaidResponse
}

export interface CreateOrderInput {
  customerId: string
  kind: OrderKind
  paymentMeta: {
    clickbankReceipt: string
    amount: number
    currency: string
    transactionDate: string
    vendor: string
    productSku: string
  }
  /** REQUIRED by backend for oto1 / oto2. Omit only for kind=main. */
  mainOrderId?: string
  billingEmail?: string
}

export interface CreateOrderResponse {
  ok: true
  ref: string
  kind: OrderKind
  before: null
  after: Record<string, unknown>
}

export async function createOrder(input: CreateOrderInput): Promise<CreateOrderResponse> {
  const res = await fetch(`${baseUrl()}/create-order`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(input),
  })
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { existing_ref?: string; error?: string }
    throw new Error(
      `astroloversketch createOrder: receipt already has an order${
        body.existing_ref ? ` (ref=${body.existing_ref})` : ''
      }`,
    )
  }
  if (!res.ok) {
    throw new Error(`astroloversketch createOrder failed: ${res.status} ${await res.text()}`)
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
  const res = await fetch(`${baseUrl()}/customer/${encodeURIComponent(input.customerId)}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify({
      patch: input.patch,
      ...(input.reason ? { reason: input.reason } : {}),
    }),
  })
  if (!res.ok) {
    throw new Error(`astroloversketch updateCustomerProfile failed: ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as UpdateCustomerProfileResponse
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
