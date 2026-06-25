import type { ClickBankOrder } from '@/shared/connectors/clickbank.js'
import { projectFromVendor } from '@/config/env.js'

export interface PaymentGateInput {
  order: ClickBankOrder | null
  expected_email: string
  expected_project: string
  min_amount?: number              // default 0.01
}

export interface PaymentGateResult {
  passed: boolean
  failures: string[]
  details: {
    order_found: boolean
    transaction_type_ok?: boolean
    email_matches?: boolean
    amount_ok?: boolean
    vendor_project_matches?: boolean
    resolved_project?: string | null
  }
}

/**
 * Verify a ClickBank order satisfies all conditions to mark our internal
 * order paid. Pure function — no side effects. Call this immediately before
 * any mark-paid action, and re-call it inside the executor before actually
 * mutating DB state.
 */
export function verifyPaymentGate(input: PaymentGateInput): PaymentGateResult {
  const failures: string[] = []
  const details: PaymentGateResult['details'] = {
    order_found: !!input.order,
  }

  if (!input.order) {
    failures.push('no ClickBank order provided')
    return { passed: false, failures, details }
  }

  const o = input.order

  // Transaction type must be a real sale or recurring bill — never a refund / chargeback / test.
  const okTypes: ClickBankOrder['transaction_type'][] = ['SALE', 'BILL']
  details.transaction_type_ok = okTypes.includes(o.transaction_type)
  if (!details.transaction_type_ok) {
    failures.push(`transaction type is "${o.transaction_type}", expected SALE or BILL`)
  }

  // Email match (case-insensitive, trimmed).
  const expectedEmail = input.expected_email.toLowerCase().trim()
  details.email_matches = o.email === expectedEmail
  if (!details.email_matches) {
    failures.push(`receipt email "${o.email}" does not match expected "${expectedEmail}"`)
  }

  // Amount > 0 (defensive — refunds may have amount 0 or negative).
  const minAmount = input.min_amount ?? 0.01
  details.amount_ok = o.amount >= minAmount
  if (!details.amount_ok) {
    failures.push(`amount ${o.amount} below minimum ${minAmount}`)
  }

  // Vendor → project mapping.
  const resolvedProject = projectFromVendor(o.vendor)
  details.resolved_project = resolvedProject
  details.vendor_project_matches = resolvedProject === input.expected_project
  if (!details.vendor_project_matches) {
    failures.push(
      `vendor "${o.vendor}" maps to "${resolvedProject ?? 'unknown'}", not "${input.expected_project}"`,
    )
  }

  return { passed: failures.length === 0, failures, details }
}
