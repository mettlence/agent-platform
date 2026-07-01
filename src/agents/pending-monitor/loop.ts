import pino from 'pino'
import { findDueMonitors } from '@/shared/state/monitors.js'
import { runTick } from './tick.js'

const log = pino({ name: 'pending-monitor-loop' })

const TICK_MS = 60_000

let timer: NodeJS.Timeout | null = null
let running = false

/**
 * Poll pending_monitors every minute for schedules whose `next_run_at` has
 * elapsed. Each due monitor's tick is claimed atomically (see claimTick),
 * so multiple bot instances scheduled in parallel still fire exactly once.
 *
 * We serialize ticks WITHIN a single loop invocation to avoid hammering
 * project backends when many monitors are due simultaneously (e.g. after a
 * long crash/restart). Concurrent parallelism can be added later if we ever
 * run enough monitors for it to matter.
 */
export function startPendingMonitorLoop(): void {
  if (timer) return
  timer = setInterval(tickOnce, TICK_MS)
  // Fire once immediately on boot so a monitor scheduled right at startup
  // doesn't wait a full minute for its first tick.
  tickOnce().catch((err) => log.error({ err }, 'initial tick threw'))
  log.info({ intervalMs: TICK_MS }, 'pending-monitor loop started')
}

export function stopPendingMonitorLoop(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

async function tickOnce(): Promise<void> {
  if (running) return
  running = true
  try {
    const due = await findDueMonitors(new Date())
    for (const monitor of due) {
      try {
        await runTick(monitor)
      } catch (err) {
        log.error({ err, monitorId: monitor._id }, 'runTick threw')
      }
    }
  } catch (err) {
    log.error({ err }, 'findDueMonitors threw')
  } finally {
    running = false
  }
}
