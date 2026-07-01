/**
 * Brand registry — single source of truth for routing CS tickets to the right
 * project. Adding a new brand:
 *   1. Implement a connector module exporting the asksabrina shape
 *   2. Add an entry below with vendor + keywords + a wrapper that conforms
 *      to the ProjectConnector interface
 *   3. Add env vars per the connector's expectations
 *
 * Every other layer (executor, tool dispatcher, mention parser) only sees the
 * unified ProjectConnector — no brand-specific branches.
 */
import * as asksabrina from '@/shared/connectors/asksabrina.js'
import * as astroloversketch from '@/shared/connectors/astroloversketch.js'
import type {
  ProjectConnector,
  UnifiedCustomerView,
  UnifiedProduct,
} from '@/shared/connectors/types.js'

export type ProjectKey = 'asksabrina' | 'astroloversketch'

export interface ProjectEntry {
  key: ProjectKey
  /** ClickBank vendor (account nickname) — the receipt's `vendor` field. */
  vendor: string
  /** Free-text aliases the mention parser will recognize in human messages. */
  keywords: readonly string[]
  connector: ProjectConnector
}

// ─── adapters ────────────────────────────────────────────────────────────

const asksabrinaConnector: ProjectConnector = {
  supportsSubscription: true,
  lookupCustomer: async (q) => {
    const v = await asksabrina.lookupCustomer(q)
    if (!v) return null
    return {
      matchedVia: v.matchedVia,
      customer: v.customer,
      mainOrders: v.mainOrders as UnifiedProduct[],
      oto1Orders: v.oto1Orders as UnifiedProduct[],
      oto2Orders: v.oto2Orders as UnifiedProduct[],
      subscription: v.subscription ?? null,
    }
  },
  ensureReading: (ref, kind, opts) => asksabrina.ensureReading(ref, kind, opts),
  getJob: (id) => asksabrina.getJob(id),
  waitForJob: (id, opts) => asksabrina.waitForJob(id, opts),
  markOrderPaid: (input) => asksabrina.markOrderPaid(input),
  createOrder: (input) =>
    asksabrina.createOrder({
      ...input,
      paymentMeta: input.paymentMeta,
    }),
  updateCustomerProfile: (input) => asksabrina.updateCustomerProfile(input),
  listPendingReadings: (opts) =>
    asksabrina.listPendingReadings(opts as { kind?: 'all' | UnifiedProduct['kind']; limit?: number }),
}

const astroSubscriptionRejection = () => {
  throw new Error('astroloversketch has no subscription product')
}

const astroloversketchConnector: ProjectConnector = {
  supportsSubscription: false,
  lookupCustomer: async (q) => {
    const v = await astroloversketch.lookupCustomer(q)
    if (!v) return null
    return {
      matchedVia: v.matchedVia,
      customer: v.customer,
      mainOrders: v.mainOrders as UnifiedProduct[],
      oto1Orders: v.oto1Orders as UnifiedProduct[],
      oto2Orders: v.oto2Orders as UnifiedProduct[],
      subscription: null,
    }
  },
  ensureReading: (ref, kind, opts) => {
    if (kind === 'subscription') return astroSubscriptionRejection()
    return astroloversketch.ensureReading(ref, kind, opts)
  },
  getJob: (id) => astroloversketch.getJob(id),
  waitForJob: (id, opts) => astroloversketch.waitForJob(id, opts),
  markOrderPaid: (input) => {
    if (input.kind === 'subscription') astroSubscriptionRejection()
    return astroloversketch.markOrderPaid({ ...input, kind: input.kind as 'main' | 'oto1' | 'oto2' })
  },
  createOrder: (input) => {
    if (input.kind === 'subscription') astroSubscriptionRejection()
    return astroloversketch.createOrder({
      customerId: input.customerId,
      kind: input.kind as 'main' | 'oto1' | 'oto2',
      paymentMeta: input.paymentMeta,
      ...(input.mainOrderId ? { mainOrderId: input.mainOrderId } : {}),
      ...(input.billingEmail ? { billingEmail: input.billingEmail } : {}),
    })
  },
  updateCustomerProfile: (input) => astroloversketch.updateCustomerProfile(input),
  listPendingReadings: async (opts) => {
    // Astrolover doesn't support subscription kind — coerce to 'all' upstream if
    // caller asks for it, since the backend will reject it.
    if (opts?.kind === 'subscription') {
      return { kind: 'subscription', count: 0, items: [] }
    }
    return astroloversketch.listPendingReadings(
      opts as { kind?: 'all' | 'main' | 'oto1' | 'oto2'; limit?: number },
    )
  },
}

// ─── registry ────────────────────────────────────────────────────────────

export const PROJECTS: Record<ProjectKey, ProjectEntry> = {
  asksabrina: {
    key: 'asksabrina',
    vendor: 'sabrinapsy',
    keywords: ['asksabrina', 'sabrina', 'sabrinapsy', 'asksab'],
    connector: asksabrinaConnector,
  },
  astroloversketch: {
    key: 'astroloversketch',
    vendor: 'astrosketc',
    keywords: ['astroloversketch', 'astrolover', 'astrosketc', 'astrolovers', 'sketch'],
    connector: astroloversketchConnector,
  },
}

export const PROJECT_KEYS: readonly ProjectKey[] = Object.keys(PROJECTS) as ProjectKey[]

export const ALL_PROJECT_KEYWORDS: ReadonlyMap<string, ProjectKey> = (() => {
  const m = new Map<string, ProjectKey>()
  for (const entry of Object.values(PROJECTS)) {
    for (const kw of entry.keywords) m.set(kw.toLowerCase(), entry.key)
    m.set(entry.key.toLowerCase(), entry.key)
    m.set(entry.vendor.toLowerCase(), entry.key)
  }
  return m
})()

/**
 * Unified connector accessor. Use this everywhere downstream of project
 * resolution — never import the per-brand modules directly outside of this
 * file (the registry is the boundary).
 */
export function getConnector(project: ProjectKey): ProjectConnector {
  const entry = PROJECTS[project]
  if (!entry) throw new Error(`Unknown project: ${project}`)
  return entry.connector
}

/** Convenience: map a vendor string back to its project key, via the registry. */
export function projectFromVendor(vendor: string): ProjectKey | null {
  const v = vendor.toLowerCase().trim()
  for (const entry of Object.values(PROJECTS)) {
    if (entry.vendor.toLowerCase() === v) return entry.key
  }
  return null
}

/** Convenience: get the vendor string for a project. */
export function vendorOf(project: ProjectKey): string {
  return PROJECTS[project].vendor
}

export type { UnifiedCustomerView, UnifiedProduct }
