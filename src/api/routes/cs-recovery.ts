import { Hono } from 'hono'
import { z } from 'zod'
import { runCsRecovery } from '@/agents/cs-recovery/index.js'

export const csRecoveryRoutes = new Hono()

const triggerSchema = z.object({
  thread_id: z.string(),
  ticket_id: z.string(),
  project: z.enum(['asksabrina', 'astroloversketch']),
  customer_email: z.string().email(),
  order_id: z.string().optional(),
  clickbank_receipt: z.string().optional(),
  complaint_text: z.string().optional(),
  trigger_user_id: z.string(),
})

csRecoveryRoutes.post('/trigger', async (c) => {
  const body = await c.req.json()
  const parsed = triggerSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
  }

  const result = await runCsRecovery(parsed.data)
  return c.json(result)
})
