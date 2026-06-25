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

const MAX_ITERATIONS = 20
const MAX_TOKENS_PER_RUN = 50_000

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
        const { receipt } = input as { receipt: string }
        const order = await clickbank.getOrderByReceipt(receipt)
        if (!order) return { output: { found: false } }
        const gate = verifyPaymentGate({
          order,
          expected_email: ctx.customer_email,
          expected_project: ctx.project,
        })
        return { output: { order, gate } }
      }

      case 'find_clickbank_receipts_by_email': {
        const { project, email } = input as { project: Project; email: string }
        const vendor = VENDOR_BY_PROJECT[project]
        if (!vendor) return { output: { error: 'unknown project vendor' }, is_error: true }
        const orders = await clickbank.findOrdersByEmail(email, vendor, { type: 'SALE' })
        return { output: orders }
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
