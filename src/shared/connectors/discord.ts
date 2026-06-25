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

/**
 * Discord rejects messages > 2000 chars with 50035. Leave headroom so a long
 * agent escalation summary doesn't crash the whole handler.
 */
const SAFE_CONTENT_LIMIT = 1900

export function chunkMessage(content: string, max = SAFE_CONTENT_LIMIT): string[] {
  if (content.length <= max) return [content]
  const chunks: string[] = []
  let remaining = content
  while (remaining.length > max) {
    // Prefer split on paragraph boundary; fall back to line, then word, then hard cut.
    let cutAt = remaining.lastIndexOf('\n\n', max)
    if (cutAt < max / 2) cutAt = remaining.lastIndexOf('\n', max)
    if (cutAt < max / 2) cutAt = remaining.lastIndexOf(' ', max)
    if (cutAt <= 0) cutAt = max
    chunks.push(remaining.slice(0, cutAt))
    remaining = remaining.slice(cutAt).replace(/^\s+/, '')
  }
  if (remaining.length) chunks.push(remaining)
  return chunks
}

/**
 * Send a message (possibly chunked) to a thread. Returns the LAST message sent
 * so callers can attach reactions / approval IDs to the message users will see
 * the action prompt on.
 */
export async function sendToThread(
  thread: ThreadChannel,
  content: string,
): Promise<Message> {
  const chunks = chunkMessage(content)
  let last: Message | null = null
  for (const chunk of chunks) {
    last = await thread.send(chunk)
  }
  return last!
}

export async function postToThread(
  threadId: string,
  content: string,
): Promise<Message | null> {
  const c = getDiscordClient()
  const channel = await c.channels.fetch(threadId)
  if (!channel || !channel.isThread()) return null
  return sendToThread(channel as ThreadChannel, content)
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
