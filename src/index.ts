import { serve } from '@hono/node-server'
import pino from 'pino'
import { env } from '@/config/env.js'
import { app } from '@/api/server.js'
import { startDiscordBot } from '@/discord-bot/client.js'
import { connectMongo, closeMongo } from '@/shared/db/mongo.js'

const log = pino({ level: env.NODE_ENV === 'production' ? 'info' : 'debug' })

async function main(): Promise<void> {
  await connectMongo()
  log.info('mongo connected')

  await startDiscordBot()
  log.info('discord bot started')

  serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    log.info({ port: info.port }, 'http server started')
  })

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'shutting down')
    await closeMongo()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  log.error(err, 'fatal startup error')
  process.exit(1)
})
