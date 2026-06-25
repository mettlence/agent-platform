import type { ClickBankOrder } from '@/shared/connectors/clickbank.js'
import { projectFromVendor } from '@/config/env.js'

export interface PaymentGateInput {
  order: ClickBankOrder | null
  expected_email: string
  /**
   * Optional. When provided AND it matches `order.customer_id` (from ClickBank
   * vendor variable `cId`), an email mismatch is no longer a gate failure.
   * Use this when identity has been resolved via the vendor variable bridge
   * (resolve_customer_identity tool) — the payment email and optin email may
   * legitimately differ for the same customer.
   */
  expected_customer_id?: string
  expected_project: string
  min_amount?: number              // default 0.01
}

export interface PaymentGateResult {
  passed: boolean
  failures: string[]
  warnings: string[]
  details: {
    order_found: boolean
    transaction_type_ok?: boolean
    email_matches?: boolean
    customer_id_bridge_matched?: boolean
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
  const warnings: string[] = []
  const details: PaymentGateResult['details'] = {
    order_found: !!input.order,
  }

  if (!input.order) {
    failures.push('no ClickBank order provided')
    return { passed: false, failures, warnings, details }
  }

  const o = input.order

  // Transaction type must be a real sale or recurring bill — never a refund / chargeback / test.
  const okTypes: ClickBankOrder['transaction_type'][] = ['SALE', 'BILL']
  details.transaction_type_ok = okTypes.includes(o.transaction_type)
  if (!details.transaction_type_ok) {
    failures.push(`transaction type is "${o.transaction_type}", expected SALE or BILL`)
  }

  // Identity check: either email matches, OR a resolved customer_id bridges
  // a legitimate email mismatch (payment email != optin email is common when
  // customers pay with a different provider than the one they signed up with).
  const expectedEmail = input.expected_email.toLowerCase().trim()
  const emailMatches = o.email === expectedEmail
  const customerIdBridge =
    !!input.expected_customer_id &&
    !!o.customer_id &&
    o.customer_id === input.expected_customer_id

  details.email_matches = emailMatches
  details.customer_id_bridge_matched = customerIdBridge

  if (!emailMatches && !customerIdBridge) {
    failures.push(
      `receipt email "${o.email}" does not match expected "${expectedEmail}"` +
        (input.expected_customer_id
          ? ` (customer_id bridge also did not match: order.customer_id="${o.customer_id ?? 'unset'}" vs expected "${input.expected_customer_id}")`
          : ' and no customer_id bridge was provided'),
    )
  } else if (!emailMatches && customerIdBridge) {
    warnings.push(
      `payment email "${o.email}" differs from optin email "${expectedEmail}" — identity verified via customer_id="${o.customer_id}"`,
    )
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

  return { passed: failures.length === 0, failures, warnings, details }
}
