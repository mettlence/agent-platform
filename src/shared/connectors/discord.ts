import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type ThreadChannel,
} from 'discord.js'
import { env } from '@/config/env.js'

let client: Client | null = null

export function getDiscordClient(): Client {
  if (client) return client
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Reaction, Partials.Channel],
  })
  return client
}

export async function loginDiscord(): Promise<void> {
  const c = getDiscordClient()
  await c.login(env.DISCORD_BOT_TOKEN)
}

export async function postToThread(
  threadId: string,
  content: string,
): Promise<Message | null> {
  const c = getDiscordClient()
  const channel = await c.channels.fetch(threadId)
  if (!channel || !channel.isThread()) return null
  return (channel as ThreadChannel).send(content)
}

export async function createThreadFromMessage(
  parentMessage: Message,
  name: string,
): Promise<ThreadChannel> {
  return parentMessage.startThread({
    name,
    autoArchiveDuration: 1440, // 24h
  })
}
