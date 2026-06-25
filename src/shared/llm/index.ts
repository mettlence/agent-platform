import { ClaudeClient } from './claude.js'
import type { LLMClient } from './client.js'

export const llm: LLMClient = new ClaudeClient()
export * from './client.js'
