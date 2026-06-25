export interface Tool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

export interface Message {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

export interface CompleteOptions {
  system?: string
  messages: Message[]
  tools?: Tool[]
  max_tokens?: number
  temperature?: number
}

export interface CompleteResponse {
  content: ContentBlock[]
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'
  usage: {
    input_tokens: number
    output_tokens: number
  }
}

export interface LLMClient {
  complete(opts: CompleteOptions): Promise<CompleteResponse>
}
