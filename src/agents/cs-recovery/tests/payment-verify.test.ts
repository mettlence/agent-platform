import { describe, it, expect } from 'vitest'
import { verifyPaymentGate } from '@/shared/gates/payment-verify.js'
import type { ClickBankOrder } from '@/shared/connectors/clickbank.js'

function makeOrder(overrides: Partial<ClickBankOrder> = {}): ClickBankOrder {
  return {
    receipt: 'ABCD1234',
    vendor: 'sabrinapsy',
    email: 'jane@example.com',
    amount: 47,
    currency: 'USD',
    product_sku: 'abdt-advanced',
    transaction_type: 'SALE',
    transaction_date: '2026-06-15',
    vendor_variables: {},
    raw: {},
    ...overrides,
  }
}

describe('verifyPaymentGate', () => {
  it('passes for a clean SALE from the expected vendor and email', () => {
    const result = verifyPaymentGate({
      order: makeOrder(),
      expected_email: 'jane@example.com',
      expected_project: 'asksabrina',
    })
    expect(result.passed).toBe(true)
    expect(result.failures).toEqual([])
  })

  it('passes for a BILL (recurring) transaction', () => {
    const result = verifyPaymentGate({
      order: makeOrder({ transaction_type: 'BILL' }),
      expected_email: 'jane@example.com',
      expected_project: 'asksabrina',
    })
    expect(result.passed).toBe(true)
  })

  it('fails when ClickBank returns null (no order)', () => {
    const result = verifyPaymentGate({
      order: null,
      expected_email: 'jane@example.com',
      expected_project: 'asksabrina',
    })
    expect(result.passed).toBe(false)
    expect(result.failures[0]).toMatch(/no ClickBank order/i)
  })

  it('fails for a refund transaction', () => {
    const result = verifyPaymentGate({
      order: makeOrder({ transaction_type: 'RFND' }),
      expected_email: 'jane@example.com',
      expected_project: 'asksabrina',
    })
    expect(result.passed).toBe(false)
    expect(result.failures.some((f) => f.includes('RFND'))).toBe(true)
  })

  it('fails for a chargeback', () => {
    const result = verifyPaymentGate({
      order: makeOrder({ transaction_type: 'CGBK' }),
      expected_email: 'jane@example.com',
      expected_project: 'asksabrina',
    })
    expect(result.passed).toBe(false)
  })

  it('fails for a test transaction', () => {
    const result = verifyPaymentGate({
      order: makeOrder({ transaction_type: 'TEST_SALE' }),
      expected_email: 'jane@example.com',
      expected_project: 'asksabrina',
    })
    expect(result.passed).toBe(false)
  })

  it('fails when email does not match (case is normalized but content differs)', () => {
    const result = verifyPaymentGate({
      order: makeOrder({ email: 'someone-else@example.com' }),
      expected_email: 'jane@example.com',
      expected_project: 'asksabrina',
    })
    expect(result.passed).toBe(false)
    expect(result.failures.some((f) => f.includes('email'))).toBe(true)
  })

  it('passes when email differs only in case + whitespace', () => {
    const result = verifyPaymentGate({
      order: makeOrder({ email: 'jane@example.com' }),
      expected_email: '  JANE@EXAMPLE.COM  ',
      expected_project: 'asksabrina',
    })
    expect(result.passed).toBe(true)
  })

  it('fails when amount is below the minimum', () => {
    const result = verifyPaymentGate({
      order: makeOrder({ amount: 0 }),
      expected_email: 'jane@example.com',
      expected_project: 'asksabrina',
    })
    expect(result.passed).toBe(false)
    expect(result.failures.some((f) => f.includes('amount'))).toBe(true)
  })

  it('fails when vendor maps to a different project', () => {
    const result = verifyPaymentGate({
      order: makeOrder({ vendor: 'astrosketc' }),
      expected_email: 'jane@example.com',
      expected_project: 'asksabrina',
    })
    expect(result.passed).toBe(false)
    expect(result.failures.some((f) => f.includes('vendor'))).toBe(true)
    expect(result.details.resolved_project).toBe('astroloversketch')
  })

  it('fails when vendor is unknown (defensive)', () => {
    const result = verifyPaymentGate({
      order: makeOrder({ vendor: 'unrelated-account' }),
      expected_email: 'jane@example.com',
      expected_project: 'asksabrina',
    })
    expect(result.passed).toBe(false)
    expect(result.details.resolved_project).toBeNull()
  })

  it('bridges an email mismatch when expected_customer_id matches order.customer_id', () => {
    const result = verifyPaymentGate({
      order: makeOrder({
        email: 'paypal-alt@example.com',
        customer_id: 'cust_42',
      }),
      expected_email: 'jane@example.com',
      expected_customer_id: 'cust_42',
      expected_project: 'asksabrina',
    })
    expect(result.passed).toBe(true)
    expect(result.failures).toEqual([])
    expect(result.details.email_matches).toBe(false)
    expect(result.details.customer_id_bridge_matched).toBe(true)
    expect(result.warnings.length).toBe(1)
    expect(result.warnings[0]).toMatch(/identity verified via customer_id="cust_42"/)
  })

  it('still fails when expected_customer_id is provided but does not match', () => {
    const result = verifyPaymentGate({
      order: makeOrder({
        email: 'paypal-alt@example.com',
        customer_id: 'cust_42',
      }),
      expected_email: 'jane@example.com',
      expected_customer_id: 'cust_OTHER',
      expected_project: 'asksabrina',
    })
    expect(result.passed).toBe(false)
    expect(result.failures.some((f) => f.includes('customer_id bridge also did not match'))).toBe(true)
  })

  it('still fails when expected_customer_id is provided but order has no customer_id', () => {
    const result = verifyPaymentGate({
      order: makeOrder({
        email: 'paypal-alt@example.com',
        // customer_id intentionally missing
      }),
      expected_email: 'jane@example.com',
      expected_customer_id: 'cust_42',
      expected_project: 'asksabrina',
    })
    expect(result.passed).toBe(false)
    expect(result.details.customer_id_bridge_matched).toBe(false)
  })

  it('bridges via receipt-email when cId is missing but expected_customer_id is provided', () => {
    const result = verifyPaymentGate({
      order: makeOrder({
        email: 'paid-with-this@example.com',
        // customer_id intentionally absent — common on OTO funnel receipts
      }),
      expected_email: 'ticket-says-this@example.com',
      expected_customer_id: 'cust_kathryn',
      identity_via_receipt_email: true,
      expected_project: 'asksabrina',
    })
    expect(result.passed).toBe(true)
    expect(result.failures).toEqual([])
    expect(result.details.email_matches).toBe(false)
    expect(result.details.customer_id_bridge_matched).toBe(false)
    expect(result.details.receipt_email_bridge_used).toBe(true)
    expect(result.warnings.length).toBe(1)
    expect(result.warnings[0]).toMatch(/paid-with-this@example\.com/)
    expect(result.warnings[0]).toMatch(/ticket-says-this@example\.com/)
    expect(result.warnings[0]).toMatch(/cust_kathryn/)
  })

  it('prefers cId bridge over receipt-email bridge when both signals are present', () => {
    const result = verifyPaymentGate({
      order: makeOrder({
        email: 'paid-with-this@example.com',
        customer_id: 'cust_kathryn',
      }),
      expected_email: 'ticket-says-this@example.com',
      expected_customer_id: 'cust_kathryn',
      identity_via_receipt_email: true,
      expected_project: 'asksabrina',
    })
    expect(result.passed).toBe(true)
    expect(result.details.customer_id_bridge_matched).toBe(true)
    expect(result.details.receipt_email_bridge_used).toBe(false)
    expect(result.warnings[0]).toMatch(/identity verified via customer_id="cust_kathryn"/)
  })

  it('does not engage the receipt-email bridge when expected_customer_id is missing', () => {
    const result = verifyPaymentGate({
      order: makeOrder({ email: 'paid-with-this@example.com' }),
      expected_email: 'ticket-says-this@example.com',
      identity_via_receipt_email: true,
      expected_project: 'asksabrina',
    })
    expect(result.passed).toBe(false)
    expect(result.details.receipt_email_bridge_used).toBe(false)
    expect(result.failures[0]).toMatch(/receipt-email bridge requires expected_customer_id/)
  })

  it('does not engage the receipt-email bridge when ticket email already matches', () => {
    const result = verifyPaymentGate({
      order: makeOrder({ email: 'same@example.com' }),
      expected_email: 'same@example.com',
      expected_customer_id: 'cust_42',
      identity_via_receipt_email: true,
      expected_project: 'asksabrina',
    })
    expect(result.passed).toBe(true)
    expect(result.details.email_matches).toBe(true)
    expect(result.details.receipt_email_bridge_used).toBe(false)
    expect(result.warnings).toEqual([])
  })

  it('reports multiple failures at once', () => {
    const result = verifyPaymentGate({
      order: makeOrder({
        transaction_type: 'RFND',
        email: 'wrong@example.com',
        amount: 0,
        vendor: 'unrelated-account',
      }),
      expected_email: 'jane@example.com',
      expected_project: 'asksabrina',
    })
    expect(result.passed).toBe(false)
    expect(result.failures.length).toBeGreaterThanOrEqual(4)
  })
})
