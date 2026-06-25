import { Events } from 'discord.js'
import pino from 'pino'
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
    if (message.author.bot) return
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
