import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SKILL_PATH = join(__dirname, 'skill.md')

let cachedSkill: string | null = null

async function loadSkill(): Promise<string> {
  if (cachedSkill) return cachedSkill
  cachedSkill = await readFile(SKILL_PATH, 'utf-8')
  return cachedSkill
}

export interface SystemPromptOptions {
  project: string
  ticket_id: string
  customer_email: string
  order_id?: string
  clickbank_receipt?: string
  complaint_text?: string
  lessons?: string[]
}

export async function buildSystemPrompt(opts: SystemPromptOptions): Promise<string> {
  const skill = await loadSkill()
  const lessons = opts.lessons?.length
    ? `\n\n## Active lessons (read carefully)\n${opts.lessons.map((l) => `- ${l}`).join('\n')}`
    : ''

  return `${skill}${lessons}

---

## Current ticket context

- Project: ${opts.project}
- Ticket ID: ${opts.ticket_id}
- Customer email: ${opts.customer_email}
- Order ID: ${opts.order_id ?? '(not provided — search if needed)'}
- ClickBank receipt: ${opts.clickbank_receipt ?? '(not provided — search by email if needed)'}
- Complaint context:
${opts.complaint_text ?? '(none)'}

Begin investigation. Use the tools provided. Draft your action and wait for approval before executing anything that mutates DB state.`
}
