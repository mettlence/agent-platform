import type { Message, ThreadChannel } from 'discord.js'
import { continueCsRecovery } from '@/agents/cs-recovery/index.js'
import { sendToThread, startTyping } from '@/shared/connectors/discord.js'
import { attachDiscordMessageId } from '@/shared/state/approvals.js'
import { extractFreeText, stripDiscordMentions } from '@/discord-bot/extractors.js'

/**
 * Continue an existing cs-recovery thread. Called when the bot is mentioned
 * inside a thread that already has an agent_threads record (created by an
 * earlier @bot mention or !cs command).
 *
 * The user's new message becomes the next turn in the conversation. If they
 * gave us just identifiers (a receipt, an email) we forward those; otherwise
 * the natural-language part of the mention is what the agent sees. Either
 * way it lands on top of the persisted history so the model can pick up
 * where it left off.
 */
export async function handleThreadContinuation(message: Message): Promise<void> {
  const thread = message.channel as ThreadChannel

  const freeText = extractFreeText(message.content)
  const fullText = stripDiscordMentions(message.content).replace(/\s+/g, ' ').trim()
  const userText = freeText || fullText
  if (!userText) {
    await message.reply('I see you mentioned me, but no follow-up text. Tell me what to look at next.')
    return
  }

  const stopTyping = startTyping(thread)
  try {
    const result = await continueCsRecovery(thread.id, userText)

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
      await sendToThread(thread, [`ℹ️ ${result.noop_message}`].join('\n'))
    } else if (result.status === 'error') {
      await sendToThread(thread, `❌ \`${result.error}\``)
    }
  } finally {
    stopTyping()
  }
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
