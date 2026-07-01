import { PROJECT_KEYS, PROJECTS, type ProjectKey } from '@/config/projects.js'

/**
 * Parse a natural-language monitor request into { projects, interval_hours,
 * duration_hours }. Kept intentionally forgiving — CS types things like
 * "monitor pending order asksabrina every 4h for 24h" or Indonesian
 * "cronjob check pending asksabrina dan astrolover per 4 jam selama 24 jam".
 *
 * Bounds are conservative — mostly to catch typos and prevent someone from
 * accidentally scheduling a 30-day monitor. Adjust as real usage justifies.
 */
export interface MonitorRequest {
  projects: ProjectKey[]
  interval_hours: number
  duration_hours: number
}

export type MonitorParseResult =
  | { ok: true; request: MonitorRequest }
  | { ok: false; error: string }

// The tick loop polls every 60s, so 1 minute is the smallest interval that
// makes practical sense. Sub-hour intervals exist mainly for testing —
// operators using it for real should stay at hours-scale.
const MIN_INTERVAL_H = 1 / 60 // 1 minute
const MAX_INTERVAL_H = 24
const MIN_DURATION_H = 1 / 60 // 1 minute
const MAX_DURATION_H = 168 // 7 days

const INTENT_PATTERNS = [
  /\bmonitor\b/i,
  /\bcron\s*job\b/i,
  /\bcronjob\b/i,
  /\bcheck\s+pending\b/i,
  /\bpending\s+(order|reading|generation)/i,
  /\bpantau\b/i, // Indonesian: monitor
]

export function looksLikeMonitorRequest(text: string): boolean {
  return INTENT_PATTERNS.some((re) => re.test(text))
}

export function parseMonitorRequest(text: string): MonitorParseResult {
  const projects = extractProjects(text)
  if (projects.length === 0) {
    return {
      ok: false,
      error: `Which project? Name at least one of: ${PROJECT_KEYS.join(', ')}, or say "both".`,
    }
  }

  const intervalRaw = extractInterval(text)
  if (intervalRaw == null) {
    return {
      ok: false,
      error:
        'Interval missing. Say e.g. `every 4h`, `per 4 jam`, `every 30m` — how often to check.',
    }
  }
  if (intervalRaw < MIN_INTERVAL_H) {
    return { ok: false, error: `Interval too small (min ${MIN_INTERVAL_H}h).` }
  }
  if (intervalRaw > MAX_INTERVAL_H) {
    return { ok: false, error: `Interval too large (max ${MAX_INTERVAL_H}h).` }
  }

  const durationRaw = extractDuration(text)
  if (durationRaw == null) {
    return {
      ok: false,
      error:
        'Duration missing. Say e.g. `for 24h`, `selama 24 jam` — how long to keep monitoring.',
    }
  }
  if (durationRaw < MIN_DURATION_H) {
    return { ok: false, error: `Duration too small (min ${MIN_DURATION_H}h).` }
  }
  if (durationRaw > MAX_DURATION_H) {
    return { ok: false, error: `Duration too large (max ${MAX_DURATION_H}h / 7d).` }
  }
  if (durationRaw < intervalRaw) {
    return {
      ok: false,
      error: `Duration (${durationRaw}h) must be at least one interval (${intervalRaw}h).`,
    }
  }

  return {
    ok: true,
    request: {
      projects,
      interval_hours: intervalRaw,
      duration_hours: durationRaw,
    },
  }
}

function extractProjects(text: string): ProjectKey[] {
  const lower = text.toLowerCase()
  const hits = new Set<ProjectKey>()
  if (/\bboth\b|\bsemua\b|\ball\b/.test(lower)) {
    for (const k of PROJECT_KEYS) hits.add(k)
    return [...hits]
  }
  for (const entry of Object.values(PROJECTS)) {
    for (const kw of entry.keywords) {
      if (new RegExp(`\\b${escape(kw)}\\b`, 'i').test(lower)) {
        hits.add(entry.key)
        break
      }
    }
    if (new RegExp(`\\b${escape(entry.key)}\\b`, 'i').test(lower)) hits.add(entry.key)
  }
  return [...hits]
}

/**
 * "every 4h", "per 4 jam", "each 30m", "tiap 2 hours". Returns hours as a
 * float — a 30m interval becomes 0.5. Downstream code multiplies by 3600_000
 * without caring.
 */
function extractInterval(text: string): number | null {
  const patterns = [
    /(?:every|per|each|tiap|setiap)\s+(\d+(?:\.\d+)?)\s*(h|hour|hours|jam)\b/i,
    /(?:every|per|each|tiap|setiap)\s+(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|menit)\b/i,
    /\britme\s+(?:per\s+)?(\d+(?:\.\d+)?)\s*(h|hour|hours|jam)\b/i,
  ]
  for (const re of patterns) {
    const m = text.match(re)
    if (m) {
      const n = Number(m[1])
      const unit = m[2]!.toLowerCase()
      return isMinutes(unit) ? n / 60 : n
    }
  }
  return null
}

/**
 * "for 24h", "selama 24 jam", "over 12 hours". Requires an explicit
 * duration keyword — bare "24h" alone is ambiguous with interval.
 */
function extractDuration(text: string): number | null {
  const patterns = [
    /(?:for|selama|over|during|untuk|dalam)\s+(\d+(?:\.\d+)?)\s*(h|hour|hours|jam)\b/i,
    /(?:for|selama|over|during|untuk|dalam)\s+(\d+(?:\.\d+)?)\s*(d|day|days|hari)\b/i,
    /(?:for|selama|over|during|untuk|dalam)\s+(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|menit)\b/i,
    /(\d+(?:\.\d+)?)\s*(h|hour|hours|jam)\s+kedepan\b/i,
    /(?:next|berikutnya)\s+(\d+(?:\.\d+)?)\s*(h|hour|hours|jam)\b/i,
  ]
  for (const re of patterns) {
    const m = text.match(re)
    if (m) {
      const n = Number(m[1])
      const unit = m[2]!.toLowerCase()
      if (isMinutes(unit)) return n / 60
      if (isDays(unit)) return n * 24
      return n
    }
  }
  return null
}

const isMinutes = (u: string): boolean =>
  ['m', 'min', 'mins', 'minute', 'minutes', 'menit'].includes(u)
const isDays = (u: string): boolean => ['d', 'day', 'days', 'hari'].includes(u)

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
