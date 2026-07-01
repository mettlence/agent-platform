import type { Message } from 'discord.js'
import { runCsRecovery } from '@/agents/cs-recovery/index.js'
import { createThreadFromMessage, sendToThread, startTyping } from '@/shared/connectors/discord.js'
import { attachDiscordMessageId } from '@/shared/state/approvals.js'
import { getOrderByReceipt } from '@/shared/connectors/clickbank.js'
import { projectFromVendor } from '@/config/env.js'
import { PROJECTS, PROJECT_KEYS, type ProjectKey } from '@/config/projects.js'
import {
  extractAll,
  extractFreeText,
  mergeTokens,
  stripDiscordMentions,
  type ExtractedTokens,
} from '@/discord-bot/extractors.js'
import { isIntroRequest, sendIntroReply } from './introduce.js'
import { handleMonitorRequest, looksLikeMonitorRequest } from './monitor-command.js'

/**
 * Natural-language entrypoint. Triggered when a user @-mentions the bot —
 * with any combination of receipt, email, and brand keyword, in any order.
 *
 * Recognition priority for resolving which brand a ticket belongs to:
 *   1. Explicit `project=` token or unambiguous brand keyword in the message
 *   2. ClickBank receipt → vendor → project (one CB call)
 *   3. Email-only → lookupCustomer across every registered project in parallel
 *
 * Context discovery when the mention itself is empty (e.g. user replies
 * to a customer screenshot with just "@bot fix this"):
 *   1. The referenced message (if it's a reply)
 *   2. Last ~20 messages of the current channel/thread, oldest-first
 * We stop expanding context as soon as the user-provided message has at
 * least one usable token — they were being specific.
 */
const CONTEXT_HISTORY_LIMIT = 20

export async function handleMentionCommand(message: Message): Promise<void> {
  const ownTokens = extractAll(message.content)

  // Intro + monitor short-circuits run against the user's OWN message only,
  // and BEFORE history/reply expansion. Otherwise a channel with stale
  // receipt/email context bleeds into "who are you?" or "monitor pending"
  // and the intent is skipped in favour of an unrelated ticket flow.
  const stripped = stripDiscordMentions(message.content).trim()
  if (looksLikeMonitorRequest(stripped)) {
    await handleMonitorRequest(message, stripped)
    return
  }
  if (!hasUsable(ownTokens)) {
    if (isIntroRequest(stripped)) {
      await sendIntroReply(message)
      return
    }
  }

  let tokens: ExtractedTokens = ownTokens
  let contextSource: 'self' | 'reply' | 'history' = 'self'

  if (!hasUsable(tokens) && message.reference?.messageId) {
    try {
      const ref = await message.channel.messages.fetch(message.reference.messageId)
      tokens = mergeTokens(tokens, extractAll(ref.content))
      if (hasUsable(tokens)) contextSource = 'reply'
    } catch {
      // referenced message may have been deleted — fall through to history scan
    }
  }

  if (!hasUsable(tokens)) {
    try {
      const history = await message.channel.messages.fetch({
        limit: CONTEXT_HISTORY_LIMIT,
        before: message.id,
      })
      // Oldest-first so a receipt pasted earlier and an email pasted later
      // both surface, and the latest mention isn't accidentally biased by
      // the most recent line only.
      for (const m of [...history.values()].reverse()) {
        if (m.author.bot) continue
        tokens = mergeTokens(tokens, extractAll(m.content))
      }
      if (hasUsable(tokens)) contextSource = 'history'
    } catch {
      // ignore — handled by the "nothing found" reply below
    }
  }

  if (!hasUsable(tokens)) {
    await message.reply(
      [
        "I can't see a receipt or email to work from.",
        'Try: `@bot <receipt>` · `@bot <email>` · `@bot <receipt> <email>`',
        'Or reply to a message that already contains one with `@bot fix this`.',
        'Not sure what I do? `@bot introduce yourself`.',
      ].join('\n'),
    )
    return
  }

  if (tokens.receipts.length > 1) {
    await message.reply(
      `Found ${tokens.receipts.length} receipts (${tokens.receipts.join(', ')}). Re-mention with just the one to investigate.`,
    )
    return
  }

  const resolution = await resolveProject(tokens)
  if (!resolution.ok) {
    await message.reply(resolution.error)
    return
  }
  const { project, source, derivedEmail } = resolution

  const email = tokens.emails[0] ?? derivedEmail
  if (!email) {
    await message.reply(
      `Resolved brand to **${project}** (via ${source}) but no email is on the receipt either. Add the customer email and re-mention.`,
    )
    return
  }

  const ticketId = tokens.ticketOverride ?? `disc-${message.id}`
  const receipt = tokens.receipts[0]

  // Free-text intent — what's left after the structural tokens. Without
  // this the agent only sees "Investigate ticket X for customer Y" and
  // has no signal about WHY the ticket was filed (regenerate / refund /
  // missing link / etc), so it tends to no-op when nothing's broken.
  const ownFreeText = extractFreeText(message.content)
  const contextFreeText =
    contextSource === 'reply' && message.reference?.messageId
      ? await safeFetchFreeText(message, message.reference.messageId)
      : ''
  const complaintText = [ownFreeText, contextFreeText].filter(Boolean).join(' — ') || undefined

  const thread = await createThreadFromMessage(message, `${ticketId} · cs-recovery`)
  // The "investigating ..." line gives instant feedback that the bot picked
  // up the ticket; once the final result lands we delete it so the thread
  // reads as just (user mention) → (bot answer) without scaffolding noise.
  const investigatingMsg = await sendToThread(
    thread,
    [
      `🤖 Investigating **${ticketId}** for **${email}**`,
      `· project: **${project}** (via ${source})`,
      receipt ? `· receipt: \`${receipt}\`` : null,
      contextSource !== 'self' ? `· context: ${contextSource}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
  )

  const stopTyping = startTyping(thread)
  try {
    const result = await runCsRecovery({
      thread_id: thread.id,
      ticket_id: ticketId,
      project,
      customer_email: email,
      clickbank_receipt: receipt,
      complaint_text: complaintText,
      trigger_user_id: message.author.id,
    })

    if (result.status === 'drafted' && result.draft && result.approval_id) {
      const draftMessage = await sendToThread(thread, formatDraft(result.draft))
      await attachDiscordMessageId(result.approval_id, draftMessage.id)
      await draftMessage.react('✅')
      await draftMessage.react('❌')
    } else if (result.status === 'escalated' && result.escalation) {
      await sendToThread(
        thread,
        [
          `⚠️ **Escalating to human**`,
          `**Reason:** ${result.escalation.reason}`,
          '',
          result.escalation.summary,
          result.escalation.suggested_next_step
            ? `\n**Suggested next step:**\n${result.escalation.suggested_next_step}`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
    } else if (result.status === 'noop' && result.noop_message) {
      await sendToThread(thread, [`ℹ️ **No action needed**`, '', result.noop_message].join('\n'))
    } else if (result.status === 'error') {
      await sendToThread(thread, `❌ Error: \`${result.error}\``)
    }
    await investigatingMsg.delete().catch(() => {})
  } finally {
    stopTyping()
  }
}

function hasUsable(t: ExtractedTokens): boolean {
  return t.receipts.length > 0 || t.emails.length > 0
}

async function safeFetchFreeText(message: Message, refId: string): Promise<string> {
  try {
    const ref = await message.channel.messages.fetch(refId)
    return stripDiscordMentions(ref.content).replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}

type Resolution =
  | { ok: true; project: ProjectKey; source: string; derivedEmail?: string }
  | { ok: false; error: string }

async function resolveProject(tokens: ExtractedTokens): Promise<Resolution> {
  // Explicit brand keyword in the message always wins. If two were named,
  // bail — we don't pick.
  if (tokens.projects.length === 1) {
    const project = tokens.projects[0]!
    // When the user also gave us a receipt, fetch the billing email off it
    // so the agent has a concrete customer to investigate — otherwise we'd
    // bail with "no email" even though the receipt has one we could use.
    if (tokens.receipts.length === 1) {
      try {
        const order = await getOrderByReceipt(tokens.receipts[0]!)
        return {
          ok: true,
          project,
          source: 'keyword',
          derivedEmail: typeof order?.email === 'string' ? order.email : undefined,
        }
      } catch {
        // Surface the keyword-resolved project even when CB is unreachable —
        // the agent will still try the email-lookup tools.
      }
    }
    return { ok: true, project, source: 'keyword' }
  }
  if (tokens.projects.length > 1) {
    return {
      ok: false,
      error: `Multiple brand keywords detected (${tokens.projects.join(', ')}). Re-mention with only one.`,
    }
  }

  if (tokens.receipts.length === 1) {
    const receipt = tokens.receipts[0]!
    let order
    try {
      order = await getOrderByReceipt(receipt)
    } catch (err) {
      return {
        ok: false,
        error: `ClickBank lookup failed for receipt \`${receipt}\`: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    if (!order) {
      return { ok: false, error: `Receipt \`${receipt}\` not found in ClickBank.` }
    }
    const project = projectFromVendor(order.vendor) as ProjectKey | null
    if (!project) {
      return {
        ok: false,
        error: `Vendor \`${order.vendor}\` does not map to any registered brand.`,
      }
    }
    return {
      ok: true,
      project,
      source: 'receipt',
      derivedEmail: typeof order.email === 'string' ? order.email : undefined,
    }
  }

  if (tokens.emails.length >= 1) {
    const email = tokens.emails[0]!
    const matches = await Promise.all(
      PROJECT_KEYS.map(async (k) => {
        try {
          const c = await PROJECTS[k].connector.lookupCustomer(email)
          return c ? k : null
        } catch {
          return null
        }
      }),
    )
    const hits = matches.filter((m): m is ProjectKey => m !== null)
    if (hits.length === 0) {
      return {
        ok: false,
        error: `No customer matched \`${email}\` in any registered brand (${PROJECT_KEYS.join(', ')}).`,
      }
    }
    if (hits.length === 1) {
      return { ok: true, project: hits[0]!, source: 'email-lookup' }
    }
    return {
      ok: false,
      error: [
        `Email \`${email}\` matched multiple brands: ${hits.join(', ')}.`,
        `Re-mention with the brand name, e.g. \`@bot ${email} ${hits[0]}\`.`,
      ].join('\n'),
    }
  }

  return {
    ok: false,
    error: 'Need at least a receipt or an email to identify the customer.',
  }
}

function formatDraft(draft: Record<string, unknown>): string {
  return [
    '📝 **Proposed action**',
    '```json',
    JSON.stringify(draft, null, 2),
    '```',
    'React ✅ to execute, ❌ to skip.',
  ].join('\n')
}
