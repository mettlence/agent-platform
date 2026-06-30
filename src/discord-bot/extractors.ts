/**
 * Pure text extractors for the @mention command parser. No I/O — every input
 * is a plain string, every output is a deterministic structure. Unit-testable.
 *
 * The parser is intentionally loose: a CS rep can drop any combination of
 * receipt / email / project keyword into the message and we'll pick out
 * whatever is recognizable. False positives matter more than misses here —
 * an unrecognized token gets routed through "ask user", not silent guessing.
 */
import { ALL_PROJECT_KEYWORDS, type ProjectKey } from '@/config/projects.js'

export interface ExtractedTokens {
  emails: string[]
  receipts: string[]
  projects: ProjectKey[]
  ticketOverride: string | null
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

// ClickBank receipts are uppercase alphanumeric, 6-16 chars, must mix letters
// and digits (so "RECEIPT" alone or "12345" alone won't match). Rebill
// variants append -L\d+ and/or -B\d+ — we accept those as part of the same
// receipt token so users can paste exactly what they see in the email.
//
// Word-boundary anchors + the mixed-class requirement filter out random caps
// words ("ASKSABRINA", "HELP") and pure numbers.
const RECEIPT_CORE_RE = /\b[A-Z0-9]{6,16}(?:-[LB]\d{1,4}){0,2}\b/g

const TICKET_OVERRIDE_RE = /\bticket\s*=\s*([A-Za-z0-9_-]+)/i

// Discord auto-converts <@123> mentions for everyone but us. Strip role/user/
// channel mention syntax before pattern-matching so we don't get phantom
// receipts out of snowflake ids.
const DISCORD_MENTION_RE = /<[@#&!:][^>]*>/g

export function stripDiscordMentions(text: string): string {
  return text.replace(DISCORD_MENTION_RE, ' ')
}

export function extractEmails(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(EMAIL_RE)) {
    out.add(m[0].toLowerCase())
  }
  return [...out]
}

export function extractReceipts(text: string): string[] {
  const out = new Set<string>()
  const cleaned = text
    .replace(EMAIL_RE, ' ')
    .replace(/[Tt]icket\s*=\s*[A-Za-z0-9_-]+/g, ' ')
  for (const m of cleaned.matchAll(RECEIPT_CORE_RE)) {
    const tok = m[0]
    if (!/[A-Z]/.test(tok)) continue
    if (/\d/.test(tok)) {
      // Mixed letters+digits — almost always a CB receipt. Accept.
      out.add(tok)
      continue
    }
    // All-letter tokens: ClickBank does issue pure-letter receipts (e.g.
    // "QYGSMSJE"). They're random-looking so vowel density is very low;
    // real English words almost always have ≥2 vowels in 6-char-plus
    // tokens (URGENT, PROBLEM, PAYMENT, REFUND). Accept only when the token
    // has 0 or 1 vowel — false positives like RHYTHM / SYMPTOM are rare
    // enough in CS messages to be acceptable.
    const vowels = (tok.match(/[AEIOU]/g) || []).length
    if (vowels < 2) out.add(tok)
  }
  return [...out]
}

export function extractProjectHints(text: string): ProjectKey[] {
  const seen = new Set<ProjectKey>()
  const lower = text.toLowerCase()
  for (const [kw, project] of ALL_PROJECT_KEYWORDS) {
    const re = new RegExp(`\\b${escapeRegex(kw)}\\b`, 'i')
    if (re.test(lower)) seen.add(project)
  }
  return [...seen]
}

export function extractTicketOverride(text: string): string | null {
  const m = TICKET_OVERRIDE_RE.exec(text)
  return m && m[1] ? m[1] : null
}

export function extractAll(text: string): ExtractedTokens {
  const cleaned = stripDiscordMentions(text)
  return {
    emails: extractEmails(cleaned),
    receipts: extractReceipts(cleaned),
    projects: extractProjectHints(cleaned),
    ticketOverride: extractTicketOverride(cleaned),
  }
}

/**
 * Pull the natural-language request out of a mention by stripping the
 * structural tokens we already parsed (emails, receipts, ticket= override,
 * project keywords, discord mentions). What's left is the free-text intent
 * — "regenerate the reading", "customer didn't get email", etc — which the
 * agent LLM needs to decide whether/how to act. Empty string when the user
 * gave us nothing beyond identifiers.
 */
export function extractFreeText(text: string): string {
  let s = stripDiscordMentions(text)
  s = s.replace(EMAIL_RE, ' ')
  s = s.replace(/[Tt]icket\s*=\s*[A-Za-z0-9_-]+/g, ' ')
  s = s.replace(RECEIPT_CORE_RE, (tok) => {
    if (!/[A-Z]/.test(tok)) return tok
    if (/\d/.test(tok)) return ' '
    const vowels = (tok.match(/[AEIOU]/g) || []).length
    return vowels < 2 ? ' ' : tok
  })
  for (const kw of ALL_PROJECT_KEYWORDS.keys()) {
    s = s.replace(new RegExp(`\\b${escapeForReplace(kw)}\\b`, 'gi'), ' ')
  }
  return s.replace(/\s+/g, ' ').trim()
}

function escapeForReplace(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function mergeTokens(a: ExtractedTokens, b: ExtractedTokens): ExtractedTokens {
  return {
    emails: dedupe([...a.emails, ...b.emails]),
    receipts: dedupe([...a.receipts, ...b.receipts]),
    projects: dedupe([...a.projects, ...b.projects]),
    ticketOverride: a.ticketOverride ?? b.ticketOverride,
  }
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)]
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
