import type { Message } from 'discord.js'
import { env } from '@/config/env.js'
import { getDiscordClient } from '@/shared/connectors/discord.js'
import { handleCsCommand } from './handlers/cs-command.js'
import { handleMentionCommand } from './handlers/mention-command.js'

const PREFIX = '!'

export async function routeMessage(message: Message): Promise<void> {
  // Allowlist: only respond inside configured guild(s) + channel(s). A thread
  // counts when its parent channel is allowlisted, so approval flows in threads
  // started from a CS channel keep working.
  if (!message.guildId || !env.DISCORD_GUILD_IDS.includes(message.guildId)) return
  const channelId = message.channelId
  const parentId = 'parentId' in message.channel ? message.channel.parentId : null
  const allowed = env.DISCORD_CS_CHANNEL_IDS
  if (!allowed.includes(channelId) && !(parentId && allowed.includes(parentId))) return

  // Mention path: natural-language trigger. Beats the `!` prefix path so a
  // message that includes both still routes here — mentions are deliberate.
  if (isBotMentioned(message)) {
    await handleMentionCommand(message)
    return
  }

  if (!message.content.startsWith(PREFIX)) return
  const [cmd, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/)

  switch (cmd) {
    case 'cs':
      await handleCsCommand(message, args)
      return
    case 'help':
      await message.reply(
        [
          '**agent-platform commands**',
          '`@bot <receipt> [email] [brand]` — natural mention. Any combination works:',
          '  `@bot ABC12345`     → receipt drives brand + email',
          '  `@bot jane@x.com`   → email-only; picks brand if customer exists in only one',
          '  `@bot fix this`     (as a reply) — pulls context from the referenced message + thread history',
          '',
          '`!cs <ticket-id> email=... [receipt=...] [project=asksabrina|astroloversketch] [complaint="..."]` — explicit form. Project auto-detected from receipt.',
          '`!help` — show this',
        ].join('\n'),
      )
      return
    default:
      // ignore unknown commands silently
      return
  }
}

function isBotMentioned(message: Message): boolean {
  const selfId = getDiscordClient().user?.id
  if (!selfId) return false
  return message.mentions.users.has(selfId)
}
