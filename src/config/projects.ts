/**
 * Brand registry — single source of truth for routing CS tickets to the right
 * project. Adding a new brand = one entry here + a connector module + the
 * matching env vars. The Discord mention parser and the multi-brand email
 * lookup both iterate this map, so no other code needs to know which brands
 * exist.
 *
 * Why this lives alongside (not replacing) VENDOR_PROJECT_MAP in env.ts:
 *   env.ts has zero runtime imports — it's read at boot before anything else.
 *   This registry needs to import connectors, which transitively depend on
 *   env. Keeping them split avoids a circular boot dependency.
 */
import * as asksabrina from '@/shared/connectors/asksabrina.js'
import * as astroloversketch from '@/shared/connectors/astroloversketch.js'

export type ProjectKey = 'asksabrina' | 'astroloversketch'

export interface ProjectEntry {
  key: ProjectKey
  /** ClickBank vendor (account nickname) — the receipt's `vendor` field. */
  vendor: string
  /** Free-text aliases the mention parser will recognize in human messages. */
  keywords: readonly string[]
  /**
   * Shared connector surface — every project must expose at least these so the
   * mention handler can do email→customer lookups uniformly. Specific projects
   * may export more (e.g. subscription on asksabrina); callers that need those
   * should narrow via the key.
   */
  connector: {
    lookupCustomer: (q: string) => Promise<unknown | null>
  }
}

export const PROJECTS: Record<ProjectKey, ProjectEntry> = {
  asksabrina: {
    key: 'asksabrina',
    vendor: 'sabrinapsy',
    keywords: ['asksabrina', 'sabrina', 'sabrinapsy', 'asksab'],
    connector: { lookupCustomer: asksabrina.lookupCustomer },
  },
  astroloversketch: {
    key: 'astroloversketch',
    vendor: 'astrosketc',
    keywords: ['astroloversketch', 'astrolover', 'astrosketc', 'astrolovers', 'sketch'],
    connector: { lookupCustomer: astroloversketch.lookupCustomer },
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
