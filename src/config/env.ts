import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),

  MONGODB_URI: z.string().url(),
  MONGODB_DB: z.string().default('agent_platform'),

  ANTHROPIC_API_KEY: z.string().startsWith('sk-ant-'),
  ANTHROPIC_MODEL: z.string().default('claude-opus-4-7'),

  DISCORD_BOT_TOKEN: z.string().min(1),
  // CSV of guild (server) IDs the bot will respond in. Single ID also valid.
  // Discord channel IDs are globally unique snowflakes, so the channel allowlist
  // below stays flat across guilds — the guild check is a defense-in-depth gate
  // against the bot being invited to a server we didn't intend to operate in.
  DISCORD_GUILD_IDS: z
    .string()
    .min(1)
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
    .refine((arr) => arr.length > 0, 'DISCORD_GUILD_IDS must contain at least one ID'),
  // CSV of channel IDs the bot will respond in. Single ID also valid.
  DISCORD_CS_CHANNEL_IDS: z
    .string()
    .min(1)
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
    .refine((arr) => arr.length > 0, 'DISCORD_CS_CHANNEL_IDS must contain at least one ID'),
  // CSV of channel IDs where monitor commands post inline instead of creating
  // a thread. Must be a subset of DISCORD_CS_CHANNEL_IDS (the router filter
  // still applies). Empty / unset = every channel uses threaded mode. Optional.
  DISCORD_MONITOR_CHANNEL_IDS: z
    .string()
    .optional()
    .default('')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
  DISCORD_CS_LEAD_ROLE_ID: z.string().optional(),
  // CSV of BOT user IDs allowed to trigger the agent by mentioning it. Empty
  // (the default) keeps the historical behaviour of ignoring every bot.
  //
  // This exists so a partner CS bot (Tala) can hand tickets over. It is an
  // explicit allowlist rather than a blanket "accept bots" because two bots
  // that both answer mentions will ping-pong forever; the bot's own ID is
  // rejected separately in discord-bot/client.ts.
  DISCORD_ALLOWED_BOT_IDS: z
    .string()
    .optional()
    .default('')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
  // Discord user ID that approves bot-relayed tickets over DM. When unset,
  // every ticket keeps approving in-thread exactly as before — the DM route
  // is opt-in and needs both this and a bot in DISCORD_ALLOWED_BOT_IDS.
  DISCORD_APPROVER_USER_ID: z.string().optional(),

  // Single ClickBank API key (no separate dev key as of 2023-07-27).
  CLICKBANK_API_KEY: z.string().min(1),

  // Project APIs (re-use existing agent API keys).
  ASKSABRINA_API_BASE: z.string().url(),
  ASKSABRINA_AGENT_KEY: z.string().min(1),

  ASTROLOVERSKETCH_API_BASE: z.string().url().optional().or(z.literal('')),
  ASTROLOVERSKETCH_AGENT_KEY: z.string().optional().or(z.literal('')),

  // Maropost (read-only contact lookup). Bridges the contact_id that Maropost
  // email funnels pass to ClickBank instead of a cId. Optional: when unset the
  // bridge is skipped and those receipts escalate as before.
  MAROPOST_ACCOUNT_ID: z.string().optional().or(z.literal('')),
  MAROPOST_API_KEY: z.string().optional().or(z.literal('')),
})

export const env = schema.parse(process.env)
export type Env = z.infer<typeof schema>

/**
 * ClickBank vendor (account nickname) → internal project key.
 * Used by payment-verify gate to confirm a receipt belongs to the right project.
 */
export const VENDOR_PROJECT_MAP: Record<string, string> = {
  sabrinapsy: 'asksabrina',
  astrosketc: 'astroloversketch',
}

export function projectFromVendor(vendor: string): string | null {
  return VENDOR_PROJECT_MAP[vendor.toLowerCase().trim()] ?? null
}

/** True when this author is a bot we've explicitly agreed to take tickets from. */
export function isAllowlistedBot(userId: string): boolean {
  return env.DISCORD_ALLOWED_BOT_IDS.includes(userId)
}
