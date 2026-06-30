/**
 * Unified connector surface — what cs-recovery (and any future agent) expects
 * from a project's agent API, regardless of brand. Per-project connector
 * modules (asksabrina.ts, astroloversketch.ts, …) keep their original shapes
 * for ergonomics; the project registry adapts them to this surface.
 *
 * Type policy: the unified shape is the LCD. Brand-specific extensions
 * (asksabrina's subscription, engineVersion) are surfaced as optional fields
 * so existing code that reads them keeps working — but downstream consumers
 * should feature-detect rather than assume.
 */

export type OrderKind = 'main' | 'oto1' | 'oto2' | 'subscription'

export interface UnifiedProduct {
  kind: OrderKind
  ref: string
  orderId: string | null
  orderIdClickBank: string | null
  paymentDate?: string | null
  readingReady: boolean
  downloadUrl?: string | null
  readingUrl?: string | null
  /** Asksabrina-only. Other brands omit. */
  engineVersion?: 'v1' | 'v2'
  activeJob?: UnifiedJob | null
}

export interface UnifiedSubscription {
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
    activeJob?: UnifiedJob | null
  }>
}

export interface UnifiedCustomerView {
  matchedVia: string
  customer: {
    id: string
    email: string
    firstName?: string
    lastName?: string
  }
  mainOrders: UnifiedProduct[]
  oto1Orders: UnifiedProduct[]
  oto2Orders: UnifiedProduct[]
  /** Brands without subscriptions return null. */
  subscription: UnifiedSubscription | null
}

export interface UnifiedJob {
  id: string
  status: 'pending' | 'running' | 'done' | 'failed'
  attempts: number
  lastError?: string | null
  startedAt?: string | null
  finishedAt?: string | null
}

export interface EnsureReadingResponse {
  status: 'already_ready' | 'pending' | 'running'
  jobId?: string
  pollUrl?: string
  readingUrl?: string
  downloadUrl?: string
}

export interface PaymentMeta {
  clickbankReceipt: string
  amount: number
  currency: string
  transactionDate: string
  vendor: string
  productSku?: string
}

export interface MarkOrderPaidInput {
  ref: string
  kind: OrderKind
  paymentMeta: PaymentMeta
}

export interface MarkOrderPaidResponse {
  ok: true
  ref: string
  kind: OrderKind
  before: Record<string, unknown>
  after: Record<string, unknown>
}

export interface CreateOrderInput {
  customerId: string
  kind: OrderKind
  paymentMeta: PaymentMeta & { productSku: string }
  /** Required by backend for oto1 / oto2 / subscription. Omit for kind=main. */
  mainOrderId?: string
  billingEmail?: string
  /** Main-only, asksabrina-only. Other brands ignore. */
  engineVersion?: 'v1' | 'v2'
  /** Main-only, asksabrina-only. */
  question?: string[]
}

export interface CreateOrderResponse {
  ok: true
  ref: string
  kind: OrderKind
  before: null
  after: Record<string, unknown>
}

export interface UpdateCustomerProfileInput {
  customerId: string
  /**
   * Per-project whitelisted field → new value. Each backend rejects keys
   * not in its allowed set with a 400 naming the offender, so callers
   * don't need to know the whitelist in advance.
   */
  patch: Record<string, unknown>
  reason?: string
}

export interface UpdateCustomerProfileResponse {
  ok: true
  customerId: string
  before: Record<string, unknown>
  after: Record<string, unknown>
}

/**
 * The full surface every project's connector must satisfy. New brands wire in
 * by implementing this and registering in src/config/projects.ts.
 *
 * `supportsSubscription` lets the executor reject subscription paths upfront
 * for brands without that product, instead of getting a backend 400.
 */
export interface ProjectConnector {
  supportsSubscription: boolean
  lookupCustomer(q: string): Promise<UnifiedCustomerView | null>
  ensureReading(
    ref: string,
    kind: OrderKind,
    opts?: { regenerate?: boolean },
  ): Promise<EnsureReadingResponse>
  getJob(jobId: string): Promise<UnifiedJob | null>
  waitForJob(
    jobId: string,
    opts?: { timeoutMs?: number; intervalMs?: number },
  ): Promise<UnifiedJob | null>
  markOrderPaid(input: MarkOrderPaidInput): Promise<MarkOrderPaidResponse>
  createOrder(input: CreateOrderInput): Promise<CreateOrderResponse>
  updateCustomerProfile(input: UpdateCustomerProfileInput): Promise<UpdateCustomerProfileResponse>
}
