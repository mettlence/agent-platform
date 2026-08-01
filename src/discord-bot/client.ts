import { Events } from 'discord.js'
import pino from 'pino'
import { isAllowlistedBot } from '@/config/env.js'
import { getDiscordClient, loginDiscord } from '@/shared/connectors/discord.js'
import { routeMessage } from './router.js'
import { handleReactionAdd } from './handlers/reaction.js'

const log = pino({ name: 'discord-bot' })

export async function startDiscordBot(): Promise<void> {
  const client = getDiscordClient()

  client.once(Events.ClientReady, (c) => {
    log.info({ user: c.user.tag }, 'discord bot ready')
  })

  client.on(Events.MessageCreate, (message) => {
    // Never react to ourselves — first guard, before the allowlist, because a
    // self-triggering bot loops forever and the allowlist can be misconfigured
    // to include our own ID.
    if (message.author.id === client.user?.id) return
    // Other bots are ignored unless explicitly allowlisted (Tala handing a
    // ticket over). Two mention-answering bots with no allowlist ping-pong.
    if (message.author.bot && !isAllowlistedBot(message.author.id)) return
    void routeMessage(message).catch((err) => {
      log.error({ err, messageId: message.id }, 'route error')
    })
  })

  client.on(Events.MessageReactionAdd, (reaction, user) => {
    void handleReactionAdd(reaction, user).catch((err) => {
      log.error({ err }, 'reaction handler error')
    })
  })

  await loginDiscord()
}
