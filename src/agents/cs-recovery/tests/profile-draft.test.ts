import { describe, it, expect } from 'vitest'
import { validateProfileDraft } from '../profile-draft.js'

const base = { project: 'astroloversketch', customer_id: '6ae2719fb580d111a3ef9940' }
const residence = { city: 'Sault Ste Marie', state: 'Ontario', country: 'Canada' }

describe('validateProfileDraft', () => {
  it('rejects a top-level city on astroloversketch, naming currentResidence', () => {
    const err = validateProfileDraft({ ...base, patch: { city: 'Sault Ste Marie' } })
    expect(err).toMatch(/currentResidence/)
  })

  it('still allows a flat city on asksabrina', () => {
    expect(validateProfileDraft({ ...base, project: 'asksabrina', patch: { city: 'Austin' } })).toBeNull()
  })

  it('rejects a partial currentResidence, which would wipe state and country', () => {
    const err = validateProfileDraft({ ...base, patch: { currentResidence: { city: 'Sault Ste Marie' } } })
    expect(err).toMatch(/whole object/)
  })

  it('accepts the full city correction with reroll and upsell follow-ups', () => {
    expect(
      validateProfileDraft({
        ...base,
        patch: { currentResidence: residence },
        regen_ref: 'main-ref',
        regen_kind: 'main',
        reroll_location: true,
        followup_regens: [
          { ref: 'oto1-ref', kind: 'oto1' },
          { ref: 'oto2-ref', kind: 'oto2' },
        ],
      }),
    ).toBeNull()
  })

  it('only rerolls the location from the main order', () => {
    const err = validateProfileDraft({
      ...base,
      patch: { currentResidence: residence },
      regen_ref: 'oto1-ref',
      regen_kind: 'oto1',
      reroll_location: true,
    })
    expect(err).toMatch(/main/)
  })

  it('rejects reroll_location outside astroloversketch', () => {
    const err = validateProfileDraft({
      ...base,
      project: 'asksabrina',
      patch: { city: 'Austin' },
      regen_ref: 'main-ref',
      regen_kind: 'main',
      reroll_location: true,
    })
    expect(err).toMatch(/astroloversketch/)
  })

  it('needs a regen_ref before follow-ups and a valid kind on each', () => {
    expect(
      validateProfileDraft({ ...base, patch: { currentResidence: residence }, followup_regens: [{ ref: 'x', kind: 'oto1' }] }),
    ).toMatch(/regen_ref/)
    expect(
      validateProfileDraft({
        ...base,
        patch: { currentResidence: residence },
        regen_ref: 'main-ref',
        regen_kind: 'main',
        followup_regens: [{ ref: 'x', kind: 'upsell' }],
      }),
    ).toMatch(/kind/)
  })

  it('keeps the original required-field checks', () => {
    expect(validateProfileDraft({ project: 'astroloversketch', patch: { age: 40 } })).toMatch(/customer_id/)
    expect(validateProfileDraft({ ...base, patch: {} })).toMatch(/patch/)
    expect(validateProfileDraft({ ...base, patch: { age: 40 }, regen_ref: 'x' })).toMatch(/regen_kind/)
  })
})
