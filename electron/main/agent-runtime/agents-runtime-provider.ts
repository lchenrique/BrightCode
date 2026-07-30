import { Agent, Runner, type AgentInputItem } from '@openai/agents'
import type {
  IAgentProvider,
  ModelInfo,
  ProviderCredential,
  StreamChunk,
  StreamParams,
} from '../../shared/providers/types'
import {
  BrightCodeAgentsModelProvider,
  type BrightCodeAgentsModelBinding,
} from './openai-agents-adapter'
import { getProviderService, type ProviderService } from './provider-service'

function lastUserText(params: StreamParams): string {
  const message = [...params.messages].reverse().find((item) => item.role === 'user')
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

function agentInput(params: StreamParams): string | AgentInputItem[] {
  const message = [...params.messages].reverse().find((item) => item.role === 'user')
  if (!message || typeof message.content === 'string') return lastUserText(params)
  const content: Array<
    | { type: 'input_text'; text: string }
    | { type: 'input_image'; image: string }
  > = []
  for (const block of message.content) {
    if (block.type === 'text') {
      content.push({ type: 'input_text', text: block.text })
    } else if (block.type === 'image') {
      content.push({ type: 'input_image', image: `data:${block.mediaType};base64,${block.data}` })
    }
  }
  return [{ role: 'user', content }]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function streamTextDelta(data: unknown): string | undefined {
  if (!isRecord(data) || data['type'] !== 'output_text_delta') return undefined
  return typeof data['delta'] === 'string' ? data['delta'] : undefined
}

/**
 * Main-process provider that makes the Agents SDK the actual execution loop.
 * BrightCode's ProviderService remains the network/credential boundary.
 */
export function createAgentsRuntimeProvider(
  binding: BrightCodeAgentsModelBinding,
  providerService: ProviderService = getProviderService(),
): IAgentProvider {
  return {
    id: `agents-runtime:${binding.provider.id}`,
    name: `${binding.provider.name} via Agents SDK`,
    baseURL: binding.provider.baseURL,
    authMethod: binding.provider.authMethod,
    apiFormat: 'custom',
    credentialProviderId: binding.provider.credentialProviderId,
    listModels(): ModelInfo[] {
      return binding.provider.listModels()
    },
    async *stream(params: StreamParams, credential?: ProviderCredential): AsyncIterable<StreamChunk> {
      const effectiveBinding = { ...binding, credential: credential ?? binding.credential }
      const effectiveModelProvider = new BrightCodeAgentsModelProvider(
        () => effectiveBinding,
        providerService,
      )
      const agent = new Agent({
        name: 'BrightCode Agent',
        instructions: params.systemPrompt ?? 'Answer the user clearly and helpfully.',
        model: params.model,
      })
      const runner = new Runner({
        modelProvider: effectiveModelProvider,
        tracingDisabled: true,
      })
      const result = await runner.run(agent, agentInput(params), {
        stream: true,
        signal: params.signal,
        maxTurns: 8,
      })

      yield { type: 'message_start' }
      for await (const event of result) {
        if (event.type !== 'raw_model_stream_event') continue
        const text = streamTextDelta(event.data)
        if (text) yield { type: 'text_delta', text }
      }
      await result.completed
      if (result.error instanceof Error) throw result.error
      yield {
        type: 'message_end',
        stopReason: 'end_turn',
        model: binding.modelId,
      }
    },
    async validateCredential(_credential: ProviderCredential): Promise<boolean> {
      return true
    },
  }
}
