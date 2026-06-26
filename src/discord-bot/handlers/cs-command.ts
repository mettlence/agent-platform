import type { Message } from 'discord.js'
import { runCsRecovery } from '@/agents/cs-recovery/index.js'
import { createThreadFromMessage, sendToThread } from '@/shared/connectors/discord.js'
import { attachDiscordMessageId } from '@/shared/state/approvals.js'
import { getOrderByReceipt } from '@/shared/connectors/clickbank.js'
import { projectFromVendor } from '@/config/env.js'

type Project = 'asksabrina' | 'astroloversketch'
const VALID_PROJECTS: readonly Project[] = ['asksabrina', 'astroloversketch']

/**
 * Usage: !cs <ticket-id> email=jane@example.com [project=asksabrina]
 *                       [receipt=ABCD1234] [order=ORD123]
 *                       [complaint="text in quotes"]
 *
 * Creates a Discord thread for the ticket, runs the agent, and posts either
 * a draft for ✅/❌ approval or an escalation note.
 */
export async function handleCsCommand(message: Message, args: string[]): Promise<void> {
  const ticketId = args[0]
  if (!ticketId) {
    await message.reply('Usage: `!cs <ticket-id> email=customer@example.com [project=asksabrina]`')
    return
  }

  const kv = parseKeyValueArgs(args.slice(1))
  const email = kv.email

  if (!email) {
    await message.reply(
      `Need customer email. Run: \`!cs ${ticketId} email=customer@example.com receipt=ABCD1234\``,
    )
    return
  }

  const projectResolution = await resolveProject(kv)
  if (!projectResolution.ok) {
    await message.reply(projectResolution.error)
    return
  }
  const { project, source } = projectResolution

  const thread = await createThreadFromMessage(message, `${ticketId} · cs-recovery`)
  await sendToThread(
    thread,
    `🤖 Investigating ticket **${ticketId}** for **${email}** (project: ${project} · via ${source})...`,
  )

  const result = await runCsRecovery({
    thread_id: thread.id,
    ticket_id: ticketId,
    project,
    customer_email: email,
    order_id: kv.order,
    clickbank_receipt: kv.receipt,
    complaint_text: kv.complaint,
    trigger_user_id: message.author.id,
  })

  if (result.status === 'drafted' && result.draft && result.approval_id) {
    const draftMessage = await sendToThread(thread, formatDraft(result.draft))
    await attachDiscordMessageId(result.approval_id, draftMessage.id)
    await draftMessage.react('✅')
    await draftMessage.react('❌')
  } else if (result.status === 'escalated' && result.escalation) {
    await sendToThread(
      thread,
      [
        `⚠️ **Escalating to human**`,
        `**Reason:** ${result.escalation.reason}`,
        '',
        result.escalation.summary,
        result.escalation.suggested_next_step
          ? `\n**Suggested next step:**\n${result.escalation.suggested_next_step}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
  } else if (result.status === 'noop' && result.noop_message) {
    await sendToThread(thread, [`ℹ️ **No action needed**`, '', result.noop_message].join('\n'))
  } else if (result.status === 'error') {
    await sendToThread(thread, `❌ Error: \`${result.error}\``)
  }
}

type ProjectResolution =
  | { ok: true; project: Project; source: 'flag' | 'receipt' }
  | { ok: false; error: string }

/**
 * Resolve which project a ticket belongs to. Explicit `project=` flag always
 * wins. Otherwise derive from the ClickBank receipt vendor, since we run one
 * global CS channel for all products. We deliberately do NOT default — a wrong
 * default silently sends astroloversketch tickets to asksabrina.
 */
async function resolveProject(kv: Record<string, string>): Promise<ProjectResolution> {
  if (kv.project) {
    const p = kv.project.toLowerCase()
    if (!VALID_PROJECTS.includes(p as Project)) {
      return { ok: false, error: `Unknown project \`${kv.project}\`. Valid: ${VALID_PROJECTS.join(', ')}.` }
    }
    return { ok: true, project: p as Project, source: 'flag' }
  }

  if (kv.receipt) {
    let order
    try {
      order = await getOrderByReceipt(kv.receipt)
    } catch (err) {
      return {
        ok: false,
        error: `ClickBank lookup failed for receipt \`${kv.receipt}\`: ${err instanceof Error ? err.message : String(err)}. Pass \`project=\` explicitly.`,
      }
    }
    if (!order) {
      return {
        ok: false,
        error: `Receipt \`${kv.receipt}\` not found in ClickBank. Double-check the receipt or pass \`project=\` explicitly.`,
      }
    }
    const project = projectFromVendor(order.vendor)
    if (!project) {
      return {
        ok: false,
        error: `Vendor \`${order.vendor}\` does not map to a known project. Pass \`project=\` explicitly.`,
      }
    }
    return { ok: true, project: project as Project, source: 'receipt' }
  }

  return {
    ok: false,
    error:
      'Cannot determine project. Pass `receipt=ABCD1234` for auto-detect, or `project=asksabrina|astroloversketch` explicitly.',
  }
}

function parseKeyValueArgs(args: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  // Re-join then re-split to handle quoted values like complaint="multi word"
  const joined = args.join(' ')
  const re = /(\w+)=(?:"([^"]*)"|(\S+))/g
  let match: RegExpExecArray | null
  while ((match = re.exec(joined)) !== null) {
    out[match[1]!] = match[2] ?? match[3] ?? ''
  }
  return out
}

function formatDraft(draft: Record<string, unknown>): string {
  return [
    '📝 **Proposed action**',
    '```json',
    JSON.stringify(draft, null, 2),
    '```',
    'React ✅ to execute, ❌ to skip.',
  ].join('\n')
}
