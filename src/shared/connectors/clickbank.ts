import { env } from '@/config/env.js'

const BASE = 'https://api.clickbank.com/rest/1.3'

const headers = () => ({
  Authorization: env.CLICKBANK_API_KEY,
  Accept: 'application/json',
})

/**
 * Normalized order record. Maps ClickBank's verbose response into the shape
 * the rest of the platform uses. Fields not present in the raw response are
 * left undefined.
 *
 * The ClickBank Orders API returns transactions; one "purchase" may have
 * multiple line items (SALE + upsells) under the same receipt.
 */
export interface ClickBankOrder {
  receipt: string
  vendor: string                       // account nickname (e.g. "sabrinapsy")
  affiliate?: string
  email: string
  amount: number
  currency: string
  product_sku: string                  // primary item SKU
  product_title?: string
  transaction_type: 'SALE' | 'RFND' | 'CGBK' | 'FEE' | 'BILL' | 'TEST_SALE' | 'TEST_BILL' | 'TEST_RFND' | 'TEST_FEE'
  transaction_date: string             // ISO-like
  raw: unknown                         // keep raw for debugging / audit
}

/**
 * Look up a single order by receipt number.
 * GET /1.3/orders2/{receipt}
 * Returns null on 404. Throws on other non-2xx.
 */
export async function getOrderByReceipt(receipt: string): Promise<ClickBankOrder | null> {
  const res = await fetch(`${BASE}/orders2/${encodeURIComponent(receipt)}`, {
    headers: headers(),
  })
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`clickbank getOrderByReceipt failed: ${res.status} ${await res.text()}`)
  }
  const raw = (await res.json()) as unknown
  return mapOrder(raw)
}

/**
 * Check if a subscription is still active for a given receipt.
 * HEAD /1.3/orders2/{receipt} → 204 active, 403 inactive/not-found.
 */
export async function isSubscriptionActive(receipt: string): Promise<boolean> {
  const res = await fetch(`${BASE}/orders2/${encodeURIComponent(receipt)}`, {
    method: 'HEAD',
    headers: headers(),
  })
  return res.status === 204
}

/**
 * Search orders for a customer email under a specific vendor account.
 * GET /1.3/orders2/list?vendor=<vendor>&email=<email>
 *
 * vendor is required because a single ClickBank API key may span multiple
 * accounts; without it the search returns nothing useful.
 */
export async function findOrdersByEmail(
  email: string,
  vendor: string,
  opts: { type?: 'SALE' | 'BILL' | 'RFND' | 'CGBK' } = {},
): Promise<ClickBankOrder[]> {
  const url = new URL(`${BASE}/orders2/list`)
  url.searchParams.set('vendor', vendor)
  url.searchParams.set('email', email)
  if (opts.type) url.searchParams.set('type', opts.type)

  const res = await fetch(url, { headers: headers() })
  if (!res.ok) {
    throw new Error(`clickbank findOrdersByEmail failed: ${res.status} ${await res.text()}`)
  }
  const raw = (await res.json()) as unknown
  return extractOrderList(raw)
}

// ─── mappers ──────────────────────────────────────────────────────────────

function mapOrder(raw: unknown): ClickBankOrder | null {
  if (!raw || typeof raw !== 'object') return null

  // ClickBank JSON wraps single-order results in different shapes depending on
  // endpoint. Common roots: {orderData: {...}} or direct {receipt, ...}.
  const inner = (raw as { orderData?: unknown }).orderData ?? raw
  if (!inner || typeof inner !== 'object') return null
  const o = inner as Record<string, unknown>

  const receipt = pickString(o, ['receipt', 'receiptNo'])
  const email = pickString(o, ['email', 'customer.email'])?.toLowerCase().trim()
  const vendor = pickString(o, ['vendor', 'site'])
  if (!receipt || !email || !vendor) return null

  return {
    receipt,
    vendor: vendor.toLowerCase(),
    affiliate: pickString(o, ['affiliate']) ?? undefined,
    email,
    amount: pickNumber(o, ['amount', 'totalAmount', 'purchaseAmount']) ?? 0,
    currency: pickString(o, ['currency', 'transactionCurrency']) ?? 'USD',
    product_sku: pickString(o, ['productSku', 'sku', 'productId']) ?? '',
    product_title: pickString(o, ['productTitle', 'title']) ?? undefined,
    transaction_type:
      (pickString(o, ['transactionType', 'type']) as ClickBankOrder['transaction_type']) ?? 'SALE',
    transaction_date: pickString(o, ['transactionDate', 'orderDate']) ?? '',
    raw,
  }
}

function extractOrderList(raw: unknown): ClickBankOrder[] {
  if (!raw || typeof raw !== 'object') return []
  const wrapper = raw as { orderData?: unknown }
  const list = Array.isArray(wrapper.orderData)
    ? wrapper.orderData
    : Array.isArray(raw)
      ? raw
      : []
  return list
    .map(mapOrder)
    .filter((o): o is ClickBankOrder => o !== null)
}

function pickString(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

function pickNumber(o: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.length > 0 && !Number.isNaN(Number(v))) return Number(v)
  }
  return undefined
}
