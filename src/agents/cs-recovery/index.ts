import { ObjectId } from 'mongodb'
import { llm } from '@/shared/llm/index.js'
import type { Message, ContentBlock } from '@/shared/llm/client.js'
import { buildSystemPrompt, type SystemPromptOptions } from './prompt.js'
import { csRecoveryTools } from './tools.js'
import * as clickbank from '@/shared/connectors/clickbank.js'
import { getConnector, vendorOf, type ProjectKey } from '@/config/projects.js'
import type { UnifiedCustomerView } from '@/shared/connectors/types.js'
import { verifyPaymentGate } from '@/shared/gates/payment-verify.js'
import {
  appendMessage,
  clearBusy,
  createThread,
  getThread,
  tryMarkBusy,
  type ThreadInitCtx,
} from '@/shared/state/threads.js'
import { createApproval } from '@/shared/state/approvals.js'
import { loadActiveLessons } from '@/shared/state/lessons.js'
import { postToThread } from '@/shared/connectors/discord.js'

export type Project = ProjectKey

export interface RunInput {
  thread_id: string                  // discord thread id
  ticket_id: string
  project: Project
  customer_email: string
  order_id?: string
  clickbank_receipt?: string
  complaint_text?: string
  trigger_user_id: string            // discord user who invoked
}

export interface RunOutput {
  status: 'drafted' | 'escalated' | 'noop' | 'error'
  draft?: Record<string, unknown>
  approval_id?: ObjectId
  escalation?: { reason: string; summary: string; suggested_next_step?: string }
  /** Agent concluded no action was needed; this is the prose it produced. */
  noop_message?: string
  error?: string
  tokens_used?: number
}

const MAX_ITERATIONS = 25
const MAX_TOKENS_PER_RUN = 100_000

export async function runCsRecovery(input: RunInput): Promise<RunOutput> {
  if (!(await getThread(input.thread_id))) {
    const init_ctx: ThreadInitCtx = {
      customer_email: input.customer_email,
      ...(input.clickbank_receipt ? { clickbank_receipt: input.clickbank_receipt } : {}),
      ...(input.order_id ? { order_id: input.order_id } : {}),
      ...(input.complaint_text ? { complaint_text: input.complaint_text } : {}),
      trigger_user_id: input.trigger_user_id,
    }
    await createThread({
      _id: input.thread_id,
      ticket_id: input.ticket_id,
      project: input.project,
      agent: 'cs-recovery',
      init_ctx,
    })
  }

  const seed: Message = {
    role: 'user',
    content: `Investigate ticket ${input.ticket_id} for customer ${input.customer_email}.`,
  }
  await appendMessage(input.thread_id, seed)
  return runAgentLoop({ ctx: input, messages: [seed] })
}

/**
 * Resume an existing cs-recovery thread with a new user turn. Reconstructs
 * RunInput from the thread's init_ctx so callers only need the thread id and
 * the new message text — identifiers persist across turns.
 *
 * Multi-turn semantics:
 *   - The new user text is appended to the persisted history; the agent then
 *     re-runs the loop with the full prior conversation visible.
 *   - A `busy` lock prevents two concurrent runs from racing on the same
 *     thread (e.g. user fires two follow-ups in quick succession).
 *   - This does NOT cancel a pending approval — if the user wants to discard
 *     a still-open draft before re-opening, react ❌ first.
 */
export async function continueCsRecovery(
  threadId: string,
  userText: string,
): Promise<RunOutput> {
  const thread = await getThread(threadId)
  if (!thread) {
    return { status: 'error', error: 'thread not found — nothing to continue' }
  }
  if (!thread.init_ctx) {
    return {
      status: 'error',
      error: 'thread predates multi-turn support — start a new mention instead',
    }
  }

  const claimed = await tryMarkBusy(threadId)
  if (!claimed) {
    return {
      status: 'error',
      error: 'another run is in progress on this thread — wait for it to finish',
    }
  }

  try {
    const ctx: RunInput = {
      thread_id: threadId,
      ticket_id: thread.ticket_id,
      project: thread.project as Project,
      customer_email: thread.init_ctx.customer_email,
      clickbank_receipt: thread.init_ctx.clickbank_receipt,
      order_id: thread.init_ctx.order_id,
      complaint_text: thread.init_ctx.complaint_text,
      trigger_user_id: thread.init_ctx.trigger_user_id,
    }
    const newMsg: Message = { role: 'user', content: userText }
    await appendMessage(threadId, newMsg)
    return await runAgentLoop({
      ctx,
      messages: [...thread.messages, newMsg],
    })
  } finally {
    await clearBusy(threadId)
  }
}

async function runAgentLoop(opts: {
  ctx: RunInput
  messages: Message[]
}): Promise<RunOutput> {
  const { ctx } = opts
  const messages = [...opts.messages]

  const lessons = await loadActiveLessons(ctx.project)
  const promptOpts: SystemPromptOptions = {
    project: ctx.project,
    ticket_id: ctx.ticket_id,
    customer_email: ctx.customer_email,
    order_id: ctx.order_id,
    clickbank_receipt: ctx.clickbank_receipt,
    complaint_text: ctx.complaint_text,
    lessons: lessons.map((l) => `(${l.pattern}) ${l.rule}`),
  }
  const system = await buildSystemPrompt(promptOpts)

  let totalTokens = 0
  let draftAction: Record<string, unknown> | null = null
  let escalation: RunOutput['escalation'] | null = null

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await llm.complete({
      system,
      messages,
      tools: csRecoveryTools,
    })
    totalTokens += response.usage.input_tokens + response.usage.output_tokens

    if (totalTokens > MAX_TOKENS_PER_RUN) {
      return {
        status: 'error',
        error: `token budget exceeded: ${totalTokens} > ${MAX_TOKENS_PER_RUN}`,
        tokens_used: totalTokens,
      }
    }

    messages.push({ role: 'assistant', content: response.content })
    await appendMessage(ctx.thread_id, { role: 'assistant', content: response.content })

    if (response.stop_reason === 'end_turn') {
      // The model concluded its investigation without calling propose_action
      // or escalate_to_human. If it explained why in trailing prose, surface
      // that to CS as an informational outcome — common case is "nothing to
      // fix" (e.g. re-running !cs after a successful recovery). Only treat
      // it as an error when the model went silent entirely.
      const trailingText = response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim()
      if (trailingText) {
        return { status: 'noop', noop_message: trailingText, tokens_used: totalTokens }
      }
      return { status: 'error', error: 'agent ended without action or message', tokens_used: totalTokens }
    }

    if (response.stop_reason !== 'tool_use') continue

    const toolResults: ContentBlock[] = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      const result = await dispatchTool(block.name, block.input, ctx)
      if (result.draft) draftAction = result.draft
      if (result.escalation) escalation = result.escalation
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result.output),
        is_error: result.is_error,
      })
    }
    messages.push({ role: 'user', content: toolResults })
    await appendMessage(ctx.thread_id, { role: 'user', content: toolResults })

    if (draftAction) {
      const approvalId = await createApproval({
        thread_id: ctx.thread_id,
        ticket_id: ctx.ticket_id,
        project: ctx.project,
        agent: 'cs-recovery',
        customer_email: ctx.customer_email,
        drafted_action: draftAction,
        discord_message_id: '',          // filled by handler when it posts
        expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      })
      return { status: 'drafted', draft: draftAction, approval_id: approvalId, tokens_used: totalTokens }
    }

    if (escalation) {
      return { status: 'escalated', escalation, tokens_used: totalTokens }
    }
  }

  return { status: 'error', error: 'max iterations reached without action', tokens_used: totalTokens }
}

// ─── tool dispatcher ──────────────────────────────────────────────────────

interface ToolResult {
  output: unknown
  is_error?: boolean
  draft?: Record<string, unknown>
  escalation?: { reason: string; summary: string; suggested_next_step?: string }
}

async function dispatchTool(
  name: string,
  input: Record<string, unknown>,
  ctx: RunInput,
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'lookup_customer': {
        const { project, query } = input as { project: Project; query: string }
        if (project !== ctx.project) {
          return { output: { error: 'project mismatch' }, is_error: true }
        }
        const view = await getConnector(project).lookupCustomer(query)
        return { output: view ?? { error: 'not_found' }, is_error: !view }
      }

      case 'verify_clickbank_receipt': {
        const { receipt, expected_customer_id, identity_via_receipt_email } = input as {
          receipt: string
          expected_customer_id?: string
          identity_via_receipt_email?: boolean
        }
        const order = await clickbank.getOrderByReceipt(receipt)
        if (!order) return { output: { found: false } }
        const gate = verifyPaymentGate({
          order,
          expected_email: ctx.customer_email,
          expected_customer_id,
          identity_via_receipt_email,
          expected_project: ctx.project,
        })
        return { output: { order, gate } }
      }

      case 'resolve_customer_identity': {
        const { project, receipt } = input as { project: Project; query?: string; receipt: string }
        if (project !== ctx.project) {
          return { output: { error: 'project mismatch' }, is_error: true }
        }
        const conn = getConnector(project)

        // Step 1: direct receipt lookup at the project. Works when the receipt
        // is already linked to a customer record (typical when order processing
        // failed but receipt was recorded).
        let view = await conn.lookupCustomer(receipt)
        let matchedVia: string | null = view ? 'receipt' : null

        // Step 2: fetch the ClickBank order so we have vendor_variables either
        // way — even if we matched on receipt, the agent and the gate need the
        // cId/contact_id to verify and to bridge identity later.
        const order = await clickbank.getOrderByReceipt(receipt)
        if (!order) {
          return {
            output: {
              found: !!view,
              matched_via: matchedVia,
              customer_view: view,
              payment_email: null,
              optin_email: view?.customer.email ?? null,
              customer_id: null,
              contact_id: null,
              vendor_variables: {},
              email_mismatch: false,
              note: 'ClickBank order not found — receipt may be invalid or for a different vendor',
            },
            is_error: !view,
          }
        }

        // Step 3: if step 1 missed, try cId from vendor variables.
        if (!view && order.customer_id) {
          view = await conn.lookupCustomer(order.customer_id)
          if (view) matchedVia = 'customer_id'
        }

        // Step 4: if still missing, try the ClickBank payment email.
        if (!view) {
          view = await conn.lookupCustomer(order.email)
          if (view) matchedVia = 'payment_email'
        }

        const optinEmail = view?.customer.email ?? null
        const emailMismatch = !!optinEmail && optinEmail.toLowerCase().trim() !== order.email

        return {
          output: {
            found: !!view,
            matched_via: matchedVia ?? 'unmatched',
            customer_view: view,
            payment_email: order.email,
            optin_email: optinEmail,
            customer_id: order.customer_id ?? null,
            contact_id: order.contact_id ?? null,
            vendor_variables: order.vendor_variables,
            email_mismatch: emailMismatch,
            ...(order.contact_id && !view
              ? { note: `no ${project} match — contact_id present, future Maropost lookup can resolve to optin email` }
              : {}),
          },
        }
      }

      case 'find_clickbank_receipts_by_email': {
        const { project, email } = input as { project: Project; email: string }
        const orders = await clickbank.findOrdersByEmail(email, vendorOf(project), { type: 'SALE' })
        return { output: orders }
      }

      case 'find_all_customer_records': {
        const { project, email } = input as { project: Project; email: string }
        if (project !== ctx.project) {
          return { output: { error: 'project mismatch' }, is_error: true }
        }
        const conn = getConnector(project)
        const receipts = await clickbank.findOrdersByEmail(email, vendorOf(project), { type: 'SALE' })

        // Group receipts by cId so callers see which receipts belong to which
        // (potentially fragmented) customer record.
        const receiptsByCid = new Map<string, string[]>()
        const receiptsWithoutCid: string[] = []
        for (const r of receipts) {
          if (r.customer_id) {
            const list = receiptsByCid.get(r.customer_id) ?? []
            list.push(r.receipt)
            receiptsByCid.set(r.customer_id, list)
          } else {
            receiptsWithoutCid.push(r.receipt)
          }
        }

        // Look up the email-matched record plus every unique cId in parallel.
        // Catch per-call so one 404 doesn't void the whole result.
        const lookupViews = await Promise.all([
          conn.lookupCustomer(email).catch(() => null),
          ...Array.from(receiptsByCid.keys()).map((cId) =>
            conn.lookupCustomer(cId).catch(() => null),
          ),
        ])

        // Dedupe by customer.id (email-match and cId-match may resolve to the
        // same record); attach linked_receipts based on the cId index.
        const recordMap = new Map<
          string,
          {
            customer: UnifiedCustomerView['customer']
            matched_via: string
            mainOrders: UnifiedCustomerView['mainOrders']
            oto1Orders: UnifiedCustomerView['oto1Orders']
            oto2Orders: UnifiedCustomerView['oto2Orders']
            subscription: UnifiedCustomerView['subscription']
            linked_receipts: string[]
          }
        >()
        for (const view of lookupViews) {
          if (!view) continue
          const cid = view.customer.id
          if (recordMap.has(cid)) continue
          recordMap.set(cid, {
            customer: view.customer,
            matched_via: view.matchedVia,
            mainOrders: view.mainOrders,
            oto1Orders: view.oto1Orders,
            oto2Orders: view.oto2Orders,
            subscription: view.subscription,
            linked_receipts: receiptsByCid.get(cid) ?? [],
          })
        }

        const records = Array.from(recordMap.values())
        const resolvedCids = new Set(recordMap.keys())
        const receiptsUnresolved = Array.from(receiptsByCid.entries())
          .filter(([cId]) => !resolvedCids.has(cId))
          .flatMap(([, list]) => list)

        return {
          output: {
            email,
            total_receipts: receipts.length,
            receipts_by_cid: Object.fromEntries(receiptsByCid),
            receipts_without_cid: receiptsWithoutCid,
            receipts_unresolved: receiptsUnresolved,
            records,
            fragmentation_warning:
              records.length > 1
                ? `${records.length} distinct customer records share email "${email}" — backend created fragmented records across funnel passes. Each record may own different orders; pick the one whose cId matches the receipt of complaint.`
                : null,
          },
        }
      }

      case 'check_regeneration_job': {
        const { project, job_id } = input as { project: Project; job_id: string }
        const job = await getConnector(project).getJob(job_id)
        return { output: job ?? { error: 'not_found' }, is_error: !job }
      }

      case 'propose_action': {
        const draft = input as {
          action_type?: string
          order_kind?: string
          ref?: string
          customer_id?: string
          main_order_id?: string
          payment_meta?: Record<string, unknown>
        }
        if (draft.action_type === 'create_order') {
          if (!draft.customer_id) {
            return {
              output: {
                error:
                  'create_order requires customer_id (the target asksabrina customer.id from resolve_customer_identity or find_all_customer_records)',
              },
              is_error: true,
            }
          }
          if (!draft.payment_meta) {
            return {
              output: { error: 'create_order requires payment_meta sourced from the verified ClickBank receipt' },
              is_error: true,
            }
          }
          if (draft.order_kind !== 'main' && !draft.main_order_id) {
            return {
              output: {
                error: `create_order kind=${draft.order_kind} requires main_order_id (the mongo _id of the parent main Order from customer_view.mainOrders[*].ref). Backend rejects without it.`,
              },
              is_error: true,
            }
          }
        } else if (draft.action_type === 'update_order' || draft.action_type === 'regenerate') {
          if (!draft.ref) {
            return {
              output: { error: `${draft.action_type} requires ref (the existing order's mongo _id)` },
              is_error: true,
            }
          }
        }
        return { output: { drafted: true }, draft: input }
      }

      case 'escalate_to_human': {
        const e = input as { reason: string; summary: string; suggested_next_step?: string }
        return { output: { escalated: true }, escalation: e }
      }

      default:
        return { output: { error: `unknown tool: ${name}` }, is_error: true }
    }
  } catch (err) {
    return {
      output: { error: err instanceof Error ? err.message : String(err) },
      is_error: true,
    }
  }
}
