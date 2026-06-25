import type { Message } from 'discord.js'
import { runCsRecovery } from '@/agents/cs-recovery/index.js'
import { createThreadFromMessage } from '@/shared/connectors/discord.js'
import { attachDiscordMessageId } from '@/shared/state/approvals.js'

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
  const project = (kv.project ?? 'asksabrina') as 'asksabrina' | 'astroloversketch'
  const email = kv.email

  if (!email) {
    await message.reply(
      `Need customer email. Run: \`!cs ${ticketId} email=customer@example.com project=${project}\``,
    )
    return
  }

  const thread = await createThreadFromMessage(message, `${ticketId} · cs-recovery`)
  await thread.send(`🤖 Investigating ticket **${ticketId}** for **${email}** (project: ${project})...`)

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
    const draftMessage = await thread.send(formatDraft(result.draft))
    await attachDiscordMessageId(result.approval_id, draftMessage.id)
    await draftMessage.react('✅')
    await draftMessage.react('❌')
  } else if (result.status === 'escalated' && result.escalation) {
    await thread.send(
      [
        `⚠️ **Escalating to human**`,
        `Reason: ${result.escalation.reason}`,
        result.escalation.summary,
        result.escalation.suggested_next_step ? `\nSuggested next step: ${result.escalation.suggested_next_step}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
  } else if (result.status === 'error') {
    await thread.send(`❌ Error: \`${result.error}\``)
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
