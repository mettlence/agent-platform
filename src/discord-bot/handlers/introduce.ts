import type { Message } from 'discord.js'
import { AttachmentBuilder } from 'discord.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import pino from 'pino'

const log = pino({ name: 'introduce-handler' })

const INTRO_PATTERNS = [
  /introduce\s+your\s*self/i,
  /who\s+are\s+you\b/i,
  /what\s+are\s+you\b/i,
  /what\s+do\s+you\s+do\b/i,
  /how\s+do\s+you\s+work\b/i,
  /how\s+do\s+i\s+use\s+you\b/i,
  /\bhelp\s+me\b/i,
  /^\s*help\s*$/i,
  /\bdocs?\b/i,
  /\bdocumentation\b/i,
  /\babout\s+your\s*self\b/i,
  /\bkamu\s+siapa\b/i,
  /\bapa\s+fungsinya\b/i,
]

const INTRO_TEXT = [
  "👋 I'm the **cs-recovery bot**. CS pings me when a customer paid but didn't get access.",
  '',
  '**What I do**',
  '1. Verify the ClickBank receipt',
  '2. Find the right customer record (even across email mismatches / fragmented records)',
  '3. Draft the fix in this thread — no writes yet',
  '4. Wait for your ✅ before touching the project DB',
  '5. On ✅, mark paid + regenerate + post the access link here',
  '',
  '**How to use me — recovery**',
  '`@me ABC12345` — receipt drives brand + email',
  '`@me jane@example.com` — email-only; I pick the brand if only one matches',
  '`@me ABC12345 jane@example.com` — both',
  '`@me fix this` (as a reply) — I read the message you replied to',
  '`!cs <ticket> email=... [receipt=...] [project=...]` — explicit form',
  '',
  '**Monitoring pending orders**',
  '`@me monitor pending both every 4h for 24h` — natural mention',
  '`!monitor both every 4h for 24h` — explicit form',
  '`!stop-monitor` (inside the monitor thread) — stop early',
  '',
  '**I will never**',
  '- Message the customer directly',
  '- Issue refunds',
  '- Execute anything without a ✅',
  '- Act on tickets older than 60 days',
  '',
  'Full guide attached as `usage.md` — the file below. `!help` for the short command reference.',
].join('\n')

const USAGE_PATH = join(process.cwd(), 'docs/USAGE.md')

let cachedUsage: Buffer | null = null

async function loadUsage(): Promise<Buffer | null> {
  if (cachedUsage) return cachedUsage
  try {
    cachedUsage = await readFile(USAGE_PATH)
    return cachedUsage
  } catch (err) {
    log.warn({ err, path: USAGE_PATH }, 'usage.md not found — replying without attachment')
    return null
  }
}

export function isIntroRequest(text: string): boolean {
  return INTRO_PATTERNS.some((re) => re.test(text))
}

export async function sendIntroReply(message: Message): Promise<void> {
  const buf = await loadUsage()
  const files = buf
    ? [new AttachmentBuilder(buf, { name: 'usage.md' })]
    : []
  await message.reply({ content: INTRO_TEXT, files })
}
