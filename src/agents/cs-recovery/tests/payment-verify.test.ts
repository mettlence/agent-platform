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
