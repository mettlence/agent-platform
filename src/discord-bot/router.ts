import type { Message } from 'discord.js'
import pino from 'pino'
import { env } from '@/config/env.js'
import { getDiscordClient } from '@/shared/connectors/discord.js'
import { getThread } from '@/shared/state/threads.js'
import { handleMentionCommand } from './handlers/mention-command.js'
import { handleThreadContinuation } from './handlers/thread-continue.js'

const log = pino({ name: 'router' })

/**
 * Mention is the only trigger. The old `!cs` / `!monitor` / `!fix-pending` /
 * `!help` prefix commands were removed — every one of them had a natural
 * mention equivalent that people actually used, and the prefix forms were
 * dead weight that also had to be taught to a partner bot.
 *
 * Intent routing itself lives in handleMentionCommand; this file only decides
 * WHETHER we're being addressed, and whether it's a new ticket or a follow-up.
 *
 * DMs never reach here (no guildId → dropped by the allowlist). That is
 * deliberate: the DM surface is reaction-only, for approving drafts.
 */
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

  if (!mentioned) return

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
}
