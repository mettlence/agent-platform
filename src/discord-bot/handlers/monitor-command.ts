import type { Message } from 'discord.js'
import pino from 'pino'
import { attachDiscordMessageId, createApproval } from '@/shared/state/approvals.js'
import { findActiveByThread, stopMonitor } from '@/shared/state/monitors.js'
import {
  looksLikeMonitorRequest,
  parseMonitorRequest,
  type MonitorRequest,
} from './monitor-parser.js'
import { createThreadFromMessage, sendToThread } from '@/shared/connectors/discord.js'

const log = pino({ name: 'monitor-command' })

const APPROVAL_TTL_MINUTES = 30

/**
 * Handle a monitor request — either from a natural mention detected in
 * mention-command, or from an explicit `!monitor ...` invocation. Both
 * paths converge here: parse → propose in thread → user ✅ to schedule.
 *
 * The scheduling itself happens in reaction.ts on ✅, so this handler's
 * only job is to draft + park a pending_approvals row. That reuses the
 * same reaction dispatch already wired for cs-recovery.
 */
export async function handleMonitorRequest(
  message: Message,
  requestText: string,
): Promise<void> {
  const parsed = parseMonitorRequest(requestText)
  if (!parsed.ok) {
    await message.reply(
      [
        `❌ Can't schedule that monitor: ${parsed.error}`,
        '',
        'Examples:',
        '`@bot monitor pending asksabrina every 4h for 24h`',
        '`@bot cronjob check pending both per 2h selama 12 jam`',
        '`!monitor both every 4h for 24h`',
      ].join('\n'),
    )
    return
  }

  const { projects, interval_hours, duration_hours } = parsed.request
  const totalTicks = Math.ceil(duration_hours / interval_hours)

  const thread = await createThreadFromMessage(
    message,
    `pending-monitor · ${projects.join('+')} · ${interval_hours}h`,
  )

  // Reject a second monitor targeting the same thread. Threads are 1:1 with
  // monitors — attaching two would race on next_run_at and double-post.
  const existing = await findActiveByThread(thread.id)
  if (existing) {
    await sendToThread(
      thread,
      `⚠️ There's already an active monitor in this thread (expires <t:${Math.floor(existing.expires_at.getTime() / 1000)}:R>). Stop it first with \`!stop-monitor\`.`,
    )
    return
  }

  const now = new Date()
  const expiresAt = new Date(now.getTime() + APPROVAL_TTL_MINUTES * 60_000)

  const draft = buildDraft(parsed.request, totalTicks)
  const approvalId = await createApproval({
    thread_id: thread.id,
    ticket_id: `monitor-${thread.id}`,
    project: projects.join('+'),
    agent: 'pending-monitor',
    customer_email: '',
    drafted_action: {
      action_type: 'schedule_pending_monitor',
      projects,
      interval_hours,
      duration_hours,
    },
    discord_message_id: '',
    expires_at: expiresAt,
  })

  const draftMessage = await sendToThread(thread, draft)
  await attachDiscordMessageId(approvalId, draftMessage.id)
  await draftMessage.react('✅')
  await draftMessage.react('❌')

  log.info(
    { approvalId, projects, interval_hours, duration_hours, threadId: thread.id },
    'monitor draft posted',
  )
}

export async function handleStopMonitor(message: Message): Promise<void> {
  const threadId = message.channelId
  const stopped = await stopMonitor(threadId, message.author.id)
  if (!stopped) {
    await message.reply('No active monitor in this thread.')
    return
  }
  await message.reply(
    `🛑 Monitor stopped. Ran ${stopped.tick_count} tick${stopped.tick_count === 1 ? '' : 's'} before you stopped it.`,
  )
}

export { looksLikeMonitorRequest }

function buildDraft(req: MonitorRequest, totalTicks: number): string {
  const { projects, interval_hours, duration_hours } = req
  return [
    '📋 **Scheduled pending-order monitor**',
    '',
    `- Projects: **${projects.join(', ')}**`,
    `- Interval: every **${humanizeHours(interval_hours)}**`,
    `- Duration: **${humanizeHours(duration_hours)}** (~${totalTicks} check${totalTicks === 1 ? '' : 's'} total)`,
    `- Reports post to this thread; auto-stops at expiry`,
    '',
    'Each tick calls `/api/agent/pending-readings` on the target project(s), diffs against the prior snapshot, and reports:',
    '- 🆕 new items since last tick',
    '- ⚠️ items stuck across ticks (age > 30min)',
    '- ✅ items resolved since last tick',
    '',
    'React ✅ to start, ❌ to cancel. Stop early with `!stop-monitor` in this thread.',
  ].join('\n')
}

function humanizeHours(h: number): string {
  if (h >= 1) {
    return h === Math.floor(h) ? `${h}h` : `${h}h`
  }
  return `${Math.round(h * 60)}m`
}
