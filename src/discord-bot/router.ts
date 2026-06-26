import type { Message } from 'discord.js'
import { env } from '@/config/env.js'
import { handleCsCommand } from './handlers/cs-command.js'

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
          '`!cs <ticket-id> email=... [receipt=...] [order=...] [project=asksabrina|astroloversketch] [complaint="..."]` — start a CS recovery flow. Project is auto-detected from `receipt=`; pass `project=` only when no receipt is available.',
          '`!help` — show this',
        ].join('\n'),
      )
      return
    default:
      // ignore unknown commands silently
      return
  }
}
