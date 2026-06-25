import { ObjectId } from 'mongodb'
import { llm } from '@/shared/llm/index.js'
import type { Message, ContentBlock } from '@/shared/llm/client.js'
import { buildSystemPrompt, type SystemPromptOptions } from './prompt.js'
import { csRecoveryTools } from './tools.js'
import * as clickbank from '@/shared/connectors/clickbank.js'
import * as asksabrina from '@/shared/connectors/asksabrina.js'
import { verifyPaymentGate } from '@/shared/gates/payment-verify.js'
import { appendMessage, createThread, getThread } from '@/shared/state/threads.js'
import { createApproval } from '@/shared/state/approvals.js'
import { loadActiveLessons } from '@/shared/state/lessons.js'
import { postToThread } from '@/shared/connectors/discord.js'

export type Project = 'asksabrina' | 'astroloversketch'

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
  status: 'drafted' | 'escalated' | 'error'
  draft?: Record<string, unknown>
  approval_id?: ObjectId
  escalation?: { reason: string; summary: string; suggested_next_step?: string }
  error?: string
  tokens_used?: number
}

const MAX_ITERATIONS = 25
const MAX_TOKENS_PER_RUN = 100_000

const VENDOR_BY_PROJECT: Record<Project, string> = {
  asksabrina: 'sabrinapsy',
  astroloversketch: 'astrosketc',
}

export async function runCsRecovery(input: RunInput): Promise<RunOutput> {
  if (!(await getThread(input.thread_id))) {
    await createThread({
      _id: input.thread_id,
      ticket_id: input.ticket_id,
      project: input.project,
      agent: 'cs-recovery',
    })
  }

  const lessons = await loadActiveLessons(input.project)

  const promptOpts: SystemPromptOptions = {
    project: input.project,
    ticket_id: input.ticket_id,
    customer_email: input.customer_email,
    order_id: input.order_id,
    clickbank_receipt: input.clickbank_receipt,
    complaint_text: input.complaint_text,
    lessons: lessons.map((l) => `(${l.pattern}) ${l.rule}`),
  }
  const system = await buildSystemPrompt(promptOpts)

  const messages: Message[] = [
    {
      role: 'user',
      content: `Investigate ticket ${input.ticket_id} for customer ${input.customer_email}.`,
    },
  ]

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
    await appendMessage(input.thread_id, { role: 'assistant', content: response.content })

    if (response.stop_reason === 'end_turn') {
      // Surface any text the model produced even if it didn't tool-call.
      const trailingText = response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
      if (trailingText) await postToThread(input.thread_id, trailingText)
      return { status: 'error', error: 'agent ended without action', tokens_used: totalTokens }
    }

    if (response.stop_reason !== 'tool_use') continue

    const toolResults: ContentBlock[] = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      const result = await dispatchTool(block.name, block.input, input)
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
    await appendMessage(input.thread_id, { role: 'user', content: toolResults })

    if (draftAction) {
      const approvalId = await createApproval({
        thread_id: input.thread_id,
        ticket_id: input.ticket_id,
        project: input.project,
        agent: 'cs-recovery',
        customer_email: input.customer_email,
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
        if (project === 'asksabrina') {
          const view = await asksabrina.lookupCustomer(query)
          return { output: view ?? { error: 'not_found' }, is_error: !view }
        }
        return { output: { error: 'project not implemented' }, is_error: true }
      }

      case 'verify_clickbank_receipt': {
        const { receipt, expected_customer_id } = input as {
          receipt: string
          expected_customer_id?: string
        }
        const order = await clickbank.getOrderByReceipt(receipt)
        if (!order) return { output: { found: false } }
        const gate = verifyPaymentGate({
          order,
          expected_email: ctx.customer_email,
          expected_customer_id,
          expected_project: ctx.project,
        })
        return { output: { order, gate } }
      }

      case 'resolve_customer_identity': {
        const { project, receipt } = input as { project: Project; query?: string; receipt: string }
        if (project !== ctx.project) {
          return { output: { error: 'project mismatch' }, is_error: true }
        }
        if (project !== 'asksabrina') {
          return { output: { error: 'project not implemented' }, is_error: true }
        }

        // Step 1: direct receipt lookup at the project. Works when the receipt
        // is already linked to a customer record (typical when order processing
        // failed but receipt was recorded).
        let view = await asksabrina.lookupCustomer(receipt)
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
          view = await asksabrina.lookupCustomer(order.customer_id)
          if (view) matchedVia = 'customer_id'
        }

        // Step 4: if still missing, try the ClickBank payment email.
        if (!view) {
          view = await asksabrina.lookupCustomer(order.email)
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
              ? { note: 'no asksabrina match — contact_id present, future Maropost lookup can resolve to optin email' }
              : {}),
          },
        }
      }

      case 'find_clickbank_receipts_by_email': {
        const { project, email } = input as { project: Project; email: string }
        const vendor = VENDOR_BY_PROJECT[project]
        if (!vendor) return { output: { error: 'unknown project vendor' }, is_error: true }
        const orders = await clickbank.findOrdersByEmail(email, vendor, { type: 'SALE' })
        return { output: orders }
      }

      case 'find_all_customer_records': {
        const { project, email } = input as { project: Project; email: string }
        if (project !== ctx.project) {
          return { output: { error: 'project mismatch' }, is_error: true }
        }
        if (project !== 'asksabrina') {
          return { output: { error: 'project not implemented' }, is_error: true }
        }

        const vendor = VENDOR_BY_PROJECT[project]
        const receipts = await clickbank.findOrdersByEmail(email, vendor, { type: 'SALE' })

        // Group receipts by cId so callers see which receipts belong to which
        // (potentially fragmented) asksabrina record.
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
          asksabrina.lookupCustomer(email).catch(() => null),
          ...Array.from(receiptsByCid.keys()).map((cId) =>
            asksabrina.lookupCustomer(cId).catch(() => null),
          ),
        ])

        // Dedupe by customer.id (email-match and cId-match may resolve to the
        // same record); attach linked_receipts based on the cId index.
        const recordMap = new Map<
          string,
          {
            customer: asksabrina.AsksabrinaCustomerView['customer']
            matched_via: string
            mainOrders: asksabrina.AsksabrinaCustomerView['mainOrders']
            oto1Orders: asksabrina.AsksabrinaCustomerView['oto1Orders']
            oto2Orders: asksabrina.AsksabrinaCustomerView['oto2Orders']
            subscription: asksabrina.AsksabrinaCustomerView['subscription']
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
            subscription: view.subscription ?? null,
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
        if (project === 'asksabrina') {
          const job = await asksabrina.getJob(job_id)
          return { output: job ?? { error: 'not_found' } }
        }
        return { output: { error: 'project not implemented' }, is_error: true }
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
