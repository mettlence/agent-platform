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
  /**
   * Optional. When true, the caller asserts that `expected_customer_id` was
   * obtained by looking up the receipt's billing email (`order.email`) in the
   * project DB. The gate accepts this as a 3rd identity bridge — even when
   * `vendorVariables.cId` is absent and `expected_email` (ticket/optin) does
   * not match `order.email`. Requires `expected_customer_id` to be set.
   *
   * Trust chain: the agent resolves the customer by receipt billing email
   * (resolve_customer_identity → matched_via='payment_email'); the human
   * approving the draft sees the email discrepancy spelled out in the
   * reasoning; the executor re-runs this gate at mutation time.
   *
   * Use only when neither email nor cId can bridge identity — never as the
   * default. The gate emits a warning that names both emails plus the
   * resolved customer_id so the audit log captures the trust chain.
   */
  identity_via_receipt_email?: boolean
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
    receipt_email_bridge_used?: boolean
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

  // Identity check: pass on any of three signals, in priority order —
  //   1. ticket/optin email matches the receipt billing email
  //   2. cId vendor variable matches the resolved customer_id
  //   3. caller asserts the customer_id was resolved by looking up the
  //      receipt email in the project DB (last-resort bridge for CB orders
  //      that carry no cId vendor variable — common on OTO funnels)
  // Bridges 2 and 3 produce a warning so the trust chain is visible in
  // the audit log and the approval message.
  const expectedEmail = input.expected_email.toLowerCase().trim()
  const emailMatches = o.email === expectedEmail
  const customerIdBridge =
    !!input.expected_customer_id &&
    !!o.customer_id &&
    o.customer_id === input.expected_customer_id
  // Receipt-email bridge only engages when the cheaper bridges are unavailable:
  // not an email match, and either no cId in vendor variables or it didn't
  // match. The cId path is strictly preferred when both signals exist.
  const receiptEmailBridge =
    !!input.identity_via_receipt_email &&
    !!input.expected_customer_id &&
    !emailMatches &&
    !customerIdBridge

  details.email_matches = emailMatches
  details.customer_id_bridge_matched = customerIdBridge
  details.receipt_email_bridge_used = receiptEmailBridge

  if (!emailMatches && !customerIdBridge && !receiptEmailBridge) {
    let msg = `receipt email "${o.email}" does not match expected "${expectedEmail}"`
    if (input.expected_customer_id) {
      msg += ` (customer_id bridge also did not match: order.customer_id="${o.customer_id ?? 'unset'}" vs expected "${input.expected_customer_id}")`
    } else if (input.identity_via_receipt_email) {
      msg += ' (receipt-email bridge requires expected_customer_id, which was not provided)'
    } else {
      msg += ' and no customer_id bridge was provided'
    }
    failures.push(msg)
  } else if (!emailMatches && customerIdBridge) {
    warnings.push(
      `payment email "${o.email}" differs from optin email "${expectedEmail}" — identity verified via customer_id="${o.customer_id}"`,
    )
  } else if (receiptEmailBridge) {
    warnings.push(
      `ticket/optin email "${expectedEmail}" differs from receipt billing email "${o.email}" and ClickBank carries no cId vendor variable — identity established by resolving "${o.email}" against the project DB to customer_id="${input.expected_customer_id}". Approver should confirm this is the correct customer.`,
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
