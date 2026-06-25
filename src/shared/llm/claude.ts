import Anthropic from '@anthropic-ai/sdk'
import { env } from '@/config/env.js'
import type {
  LLMClient,
  CompleteOptions,
  CompleteResponse,
  ContentBlock,
} from './client.js'

export class ClaudeClient implements LLMClient {
  private client: Anthropic

  constructor() {
    this.client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  }

  async complete(opts: CompleteOptions): Promise<CompleteResponse> {
    // Newer Claude models (Opus 4.x and up) reject the `temperature` param.
    // Only include it when the caller explicitly sets it.
    const body: Record<string, unknown> = {
      model: env.ANTHROPIC_MODEL,
      max_tokens: opts.max_tokens ?? 4096,
      system: opts.system,
      messages: opts.messages,
      tools: opts.tools,
    }
    if (opts.temperature !== undefined) {
      body.temperature = opts.temperature
    }

    const response = await this.client.messages.create(body as never)

    return {
      content: response.content as ContentBlock[],
      stop_reason: response.stop_reason as CompleteResponse['stop_reason'],
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
    }
  }
}
