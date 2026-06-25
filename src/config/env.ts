import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),

  MONGODB_URI: z.string().url(),
  MONGODB_DB: z.string().default('agent_platform'),

  ANTHROPIC_API_KEY: z.string().startsWith('sk-ant-'),
  ANTHROPIC_MODEL: z.string().default('claude-opus-4-7'),

  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  DISCORD_CS_CHANNEL_ID: z.string().min(1),
  DISCORD_CS_LEAD_ROLE_ID: z.string().optional(),

  // Single ClickBank API key (no separate dev key as of 2023-07-27).
  CLICKBANK_API_KEY: z.string().min(1),

  // Project APIs (re-use existing agent API keys).
  ASKSABRINA_API_BASE: z.string().url(),
  ASKSABRINA_AGENT_KEY: z.string().min(1),

  ASTROLOVERSKETCH_API_BASE: z.string().url().optional().or(z.literal('')),
  ASTROLOVERSKETCH_AGENT_KEY: z.string().optional().or(z.literal('')),
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
