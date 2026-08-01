import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type SendableChannels,
  type TextChannel,
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
      // DM approval route. DirectMessageReactions is the one that actually
      // matters — without it the ✅ on a DM'd draft never reaches the gateway
      // and the approval silently hangs until it expires.
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.DirectMessageReactions,
    ],
    // Partials.Channel is required for DM events at all: the DM channel isn't
    // in cache until the user interacts, so without it discord.js drops the
    // event instead of emitting a partial.
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
 * A "post target" is either a Discord thread or a regular text channel. Both
 * have identical `.send()` semantics, and monitor inline-mode uses a plain
 * text channel while cs-recovery uses a thread. Keeping a union here lets
 * both call sites share the send/react/chunk plumbing.
 */
export type PostTarget = ThreadChannel | TextChannel | SendableChannels

/**
 * Send a message (possibly chunked) to a thread or text channel. Returns the
 * LAST message sent so callers can attach reactions / approval IDs to the
 * message users will see the action prompt on.
 */
export async function sendToThread(
  target: PostTarget,
  content: string,
): Promise<Message> {
  const chunks = chunkMessage(content)
  let last: Message | null = null
  for (const chunk of chunks) {
    last = await target.send(chunk)
  }
  return last!
}

export async function postToThread(
  targetId: string,
  content: string,
): Promise<Message | null> {
  const c = getDiscordClient()
  const channel = await c.channels.fetch(targetId)
  if (!channel || !('send' in channel)) return null
  return sendToThread(channel as PostTarget, content)
}

/**
 * DM a user, chunked like any other send. Returns the LAST message so the
 * caller can attach an approval id and reactions to it.
 *
 * Returns null instead of throwing when Discord refuses the DM — the common
 * case is error 50007 ("Cannot send messages to this user"), which happens
 * when the recipient has "Allow direct messages from server members" off, or
 * shares no guild with the bot. Callers MUST handle null by falling back to a
 * visible channel post; a swallowed DM failure would strand the approval.
 */
export async function sendDM(userId: string, content: string): Promise<Message | null> {
  try {
    const user = await getDiscordClient().users.fetch(userId)
    const dm = await user.createDM()
    return await sendToThread(dm, content)
  } catch {
    return null
  }
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

/**
 * Create a thread that is NOT anchored to a message.
 *
 * A thread started from a message hangs a permanent "N Messages ›" strip
 * under it in the channel. For relayed tickets the whole point is that the
 * channel shows two clean lines, so the investigation goes in a detached
 * private thread instead — same capabilities, no inline clutter.
 *
 * `members` are added explicitly because a private thread is invisible to
 * anyone who isn't in it: without this the approver would get a DM linking to
 * a thread they can't open.
 *
 * Returns null when the channel can't host one or the bot lacks the
 * permission, so the caller can fall back to the message-anchored form rather
 * than losing the thread entirely.
 */
export async function createDetachedThread(
  channel: unknown,
  name: string,
  members: string[] = [],
): Promise<ThreadChannel | null> {
  const c = channel as TextChannel
  if (!c?.threads?.create) return null
  try {
    const thread = await c.threads.create({
      name,
      autoArchiveDuration: 1440, // 24h
      type: ChannelType.PrivateThread,
      invitable: false,
    })
    for (const id of members) {
      await thread.members.add(id).catch(() => {})
    }
    return thread
  } catch {
    return null
  }
}

/**
 * Show the "Bot is typing…" indicator while a long-running task is in flight.
 * Discord auto-clears the indicator after ~10s, so we re-send every 5s. The
 * returned function stops the loop — always call it in a finally so we don't
 * leak intervals.
 *
 *   const stopTyping = startTyping(thread)
 *   try { await doWork() } finally { stopTyping() }
 */
// Loose duck-typed channel — ThreadChannel and TextChannel both have
// sendTyping, but their discriminated-union types don't cleanly converge,
// so accepting "anything with sendTyping" sidesteps the friction.
type Typeable = { sendTyping: () => Promise<unknown> }

export function startTyping(channel: unknown): () => void {
  if (!channel || typeof (channel as Typeable).sendTyping !== 'function') {
    return () => {}
  }
  const tick = () => {
    ;(channel as Typeable).sendTyping().catch(() => {})
  }
  tick()
  const id = setInterval(tick, 5_000)
  return () => clearInterval(id)
}
