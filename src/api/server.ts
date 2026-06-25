import { Hono } from 'hono'
import { csRecoveryRoutes } from './routes/cs-recovery.js'

export const app = new Hono()

app.get('/health', (c) => c.json({ status: 'ok', uptime: process.uptime() }))

app.route('/cs-recovery', csRecoveryRoutes)
