import { env } from '@/config/env.js'
import type { ClickBankOrder } from '@/shared/connectors/clickbank.js'

/**
 * Read-only Maropost contact lookup. Bridges the `contact_id` that Maropost
 * email funnels put in ClickBank vendor_variables (instead of a cId) back to
 * the project customer record.
 *
 * Each brand backend writes its own customer _id onto the contact at opt-in
 * as a custom field named `<project>_customer_id`
 * (e.g. `astroloversketch_customer_id`), so the field is as trustworthy as
 * the cId vendor variable: neither the buyer nor the agent can set it.
 */

const BASE = 'https://api.maropost.com/accounts'

export interface MaropostContact {
  id: string
  email: string | null
  /** project key → customer _id, from the `<project>_customer_id` fields. */
  customer_ids: Record<string, string>
}

export const isConfigured = (): boolean =>
  !!env.MAROPOST_ACCOUNT_ID && !!env.MAROPOST_API_KEY

/**
 * GET /accounts/{id}/contacts/{contact_id}.json
 * Returns null on 404. Throws on other non-2xx or when not configured.
 */
export async function getContact(contactId: string): Promise<MaropostContact | null> {
  if (!isConfigured()) throw new Error('MAROPOST_ACCOUNT_ID / MAROPOST_API_KEY are not configured')
  const url = new URL(
    `${BASE}/${env.MAROPOST_ACCOUNT_ID}/contacts/${encodeURIComponent(contactId)}.json`,
  )
  url.searchParams.set('auth_token', env.MAROPOST_API_KEY as string)
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`maropost getContact failed: ${res.status} ${await res.text()}`)
  }
  const raw = (await res.json()) as Record<string, unknown>

  const customerIds: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    const project = /^(.+)_customer_id$/.exec(k)?.[1]
    if (project && typeof v === 'string' && v.trim()) customerIds[project] = v.trim()
  }

  return {
    id: String(raw.id ?? contactId),
    email: typeof raw.email === 'string' ? raw.email.toLowerCase().trim() : null,
    customer_ids: customerIds,
  }
}

/**
 * The project customer _id Maropost holds for a contact, or undefined when
 * Maropost isn't configured, the contact has none, or the lookup fails.
 * Never throws — callers use it as an optional identity signal.
 */
export async function customerIdForContact(
  contactId: string,
  project: string,
): Promise<string | undefined> {
  if (!isConfigured()) return undefined
  try {
    const contact = await getContact(contactId)
    return contact?.customer_ids[project]
  } catch (err) {
    console.warn('[maropost] customerIdForContact failed', { contact_id: contactId, err })
    return undefined
  }
}

/** customerIdForContact for the receipt's `contact_id` vendor variable. */
export async function customerIdForOrder(
  order: ClickBankOrder | null,
  project: string,
): Promise<string | undefined> {
  return order?.contact_id ? customerIdForContact(order.contact_id, project) : undefined
}
