import type { Message } from 'discord.js'
import pino from 'pino'
import { env } from '@/config/env.js'
import { getDiscordClient } from '@/shared/connectors/discord.js'
import { getThread } from '@/shared/state/threads.js'
import { handleCsCommand } from './handlers/cs-command.js'
import { handleMentionCommand } from './handlers/mention-command.js'
import { handleThreadContinuation } from './handlers/thread-continue.js'
import { sendIntroReply } from './handlers/introduce.js'

const log = pino({ name: 'router' })
const PREFIX = '!'

export async function routeMessage(message: Message): Promise<void> {
  // Allowlist: only respond inside configured guild(s) + channel(s). A thread
  // counts when its parent channel is allowlisted, so approval flows in threads
  // started from a CS channel keep working. When a mention is dropped by the
  // allowlist we log the reason once so operators can tell "bot ignored me"
  // apart from "bot never saw me" (missing intent / missing permission).
  const selfId = getDiscordClient().user?.id
  const mentioned = !!selfId && message.mentions.users.has(selfId)

  if (!message.guildId || !env.DISCORD_GUILD_IDS.includes(message.guildId)) {
    if (mentioned) {
      log.warn(
        { guildId: message.guildId, channelId: message.channelId },
        'mention dropped: guild not in DISCORD_GUILD_IDS',
      )
    }
    return
  }
  const channelId = message.channelId
  const parentId = 'parentId' in message.channel ? message.channel.parentId : null
  const allowed = env.DISCORD_CS_CHANNEL_IDS
  if (!allowed.includes(channelId) && !(parentId && allowed.includes(parentId))) {
    if (mentioned) {
      log.warn(
        { guildId: message.guildId, channelId, parentId, allowed },
        'mention dropped: channel + parent not in DISCORD_CS_CHANNEL_IDS',
      )
    }
    return
  }

  if (isBotMentioned(message)) {
    // Continuation path: mentioned inside an existing cs-recovery thread.
    // We know the thread is ours when there's an agent_threads record for it.
    // Anywhere else (main CS channel, or a thread we don't own), treat as a
    // fresh investigation.
    if (message.channel.isThread()) {
      const existing = await getThread(message.channel.id)
      if (existing) {
        await handleThreadContinuation(message)
        return
      }
    }
    await handleMentionCommand(message)
    return
  }

  if (!message.content.startsWith(PREFIX)) return
  const [cmd, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/)

  switch (cmd) {
    case 'cs':
      await handleCsCommand(message, args)
      return
    case 'about':
    case 'introduce':
      await sendIntroReply(message)
      return
    case 'help':
      await message.reply(
        [
          '**agent-platform commands**',
          '`@bot <receipt> [email] [brand]` — natural mention. Any combination works:',
          '  `@bot ABC12345`     → receipt drives brand + email',
          '  `@bot jane@x.com`   → email-only; picks brand if customer exists in only one',
          '  `@bot fix this`     (as a reply) — pulls context from the referenced message + thread history',
          '  `@bot <follow-up>`  (inside a cs-recovery thread) — continues the existing conversation',
          '',
          '`!cs <ticket-id> email=... [receipt=...] [project=asksabrina|astroloversketch] [complaint="..."]` — explicit form. Project auto-detected from receipt.',
          '`!about` / `!introduce` / `@bot introduce yourself` — what I am, how to use me (attaches full guide).',
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
