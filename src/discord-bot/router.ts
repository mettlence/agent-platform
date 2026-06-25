import type { Message } from 'discord.js'
import { handleCsCommand } from './handlers/cs-command.js'

const PREFIX = '!'

export async function routeMessage(message: Message): Promise<void> {
  if (!message.content.startsWith(PREFIX)) return
  const [cmd, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/)

  switch (cmd) {
    case 'cs':
      await handleCsCommand(message, args)
      return
    case 'help':
      await message.reply(
        [
          '**agent-platform commands**',
          '`!cs <ticket-id> [project=asksabrina] [email=...]` — start a CS recovery flow',
          '`!help` — show this',
        ].join('\n'),
      )
      return
    default:
      // ignore unknown commands silently
      return
  }
}
