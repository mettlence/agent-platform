/**
 * Draft-time checks for `update_customer_profile`. They run when the agent
 * calls propose_action, so a patch the backend would reject never reaches a
 * human for approval. Before these existed, a wrong key only surfaced as a
 * 400 after someone had already reacted ✅.
 */

const ORDER_KINDS = ['main', 'oto1', 'oto2', 'subscription'] as const
type Kind = (typeof ORDER_KINDS)[number]

export interface ProfileDraftInput {
  project?: string
  customer_id?: string
  patch?: Record<string, unknown>
  regen_ref?: string
  regen_kind?: string
  reroll_location?: boolean
  followup_regens?: Array<{ ref?: string; kind?: string }>
}

// astroloversketch keeps location inside nested objects. asksabrina has flat
// `city` / `country`, which is how the agent ends up sending them here.
const ALS_FLAT_LOCATION_KEYS = ['city', 'state', 'country']
const ALS_PLACE_OBJECTS = ['currentResidence', 'birthPlace']

const nonEmpty = (v: unknown) => typeof v === 'string' && v.trim() !== ''

/** Returns an error message for the agent, or null when the draft is fine. */
export function validateProfileDraft(draft: ProfileDraftInput): string | null {
  if (!draft.customer_id) {
    return 'update_customer_profile requires customer_id (from customer_view.customer.id)'
  }
  const patch = draft.patch
  if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) {
    return 'update_customer_profile requires patch (object of customer-field → new value). See tool description for whitelist per project.'
  }
  if (draft.regen_ref && !draft.regen_kind) {
    return 'update_customer_profile: regen_ref requires regen_kind'
  }

  if (draft.project === 'astroloversketch') {
    const flat = ALS_FLAT_LOCATION_KEYS.filter((k) => k in patch)
    if (flat.length) {
      return `astroloversketch has no top-level ${flat.join('/')}. The customer's location lives in currentResidence: { city, state, country } (birthplace in birthPlace). Send the whole object, copying the parts that stay the same from customer_view.`
    }
    for (const key of ALS_PLACE_OBJECTS) {
      if (!(key in patch)) continue
      const place = patch[key] as Record<string, unknown> | null
      // The backend $sets the object whole, so a partial one wipes the
      // fields it leaves out.
      if (!place || typeof place !== 'object' || !nonEmpty(place.city) || !nonEmpty(place.country)) {
        return `patch.${key} replaces the whole object, so it needs city and country (and state when known). Copy the unchanged parts from customer_view.`
      }
    }
  }

  if (draft.reroll_location) {
    if (draft.project !== 'astroloversketch') {
      return 'reroll_location only applies to astroloversketch (the predicted meeting place)'
    }
    if (!draft.regen_ref || draft.regen_kind !== 'main') {
      return 'reroll_location requires regen_ref + regen_kind="main": the meeting place is stored on the main order'
    }
  }

  if (draft.followup_regens?.length) {
    if (!draft.regen_ref) {
      return 'followup_regens run after the regen_ref job, so they need regen_ref + regen_kind'
    }
    for (const f of draft.followup_regens) {
      if (!f?.ref || !ORDER_KINDS.includes(f.kind as Kind)) {
        return 'each followup_regens entry needs { ref, kind } with kind one of main, oto1, oto2, subscription'
      }
    }
  }

  return null
}
