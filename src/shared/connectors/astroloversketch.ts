// Stub: implemented once first project (asksabrina) is proven.
// Mirror the asksabrina.ts shape — adapt to astroloversketch API conventions.

export interface AstroLoverOrder {
  _id: string
  orderId: string
  email: string
  paymentStatus: 0 | 1
  // ... project-specific fields
}

export async function findOrdersByEmail(_email: string): Promise<AstroLoverOrder[]> {
  throw new Error('astroloversketch connector not implemented')
}

export async function markOrderPaid(
  _orderId: string,
  _paymentMeta: Record<string, unknown>,
): Promise<void> {
  throw new Error('astroloversketch connector not implemented')
}

export async function ensureReading(_ref: string): Promise<{ reading_link: string }> {
  throw new Error('astroloversketch connector not implemented')
}
