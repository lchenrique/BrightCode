import { describe, expect, it } from 'vitest'
import type { ProviderEvent, IAgentProvider } from '../../electron/shared/providers/types'
import { createAgentsRuntimeProvider } from '../../electron/main/agent-runtime/agents-runtime-provider'
import type { BrightCodeAgentsModelBinding } from '../../electron/main/agent-runtime/openai-agents-adapter'
import type { ProviderService, RunProviderStreamInput } from '../../electron/main/agent-runtime/provider-service'

function provider(): IAgentProvider {
  return {
    id: 'fake',
    name: 'Fake',
    baseURL: 'https://fake.invalid',
    authMethod: 'api_key',
    apiFormat: 'openai-chat',
    listModels: () => [{ id: 'fake-model', displayName: 'Fake', provider: 'fake' }],
    stream: async function* () {},
    validateCredential: async () => true,
  }
}

function serviceFrom(run: (input: RunProviderStreamInput) => AsyncGenerator<ProviderEvent>): ProviderService {
  return { run }
}

describe('Agents SDK runtime provider', () => {
  it('executes Runner through ProviderService and preserves binding', async () => {
    const calls: RunProviderStreamInput[] = []
    const service = serviceFrom(async function* (input) {
      calls.push(input)
      yield { type: 'text_delta', threadId: input.threadId, turnId: input.turnId, sequence: 0, timestamp: 1, payload: { text: 'ok' } }
      yield { type: 'message_end', threadId: input.threadId, turnId: input.turnId, sequence: 1, timestamp: 2, payload: { stopReason: 'end_turn', model: 'fake-model' } }
    })
    const binding: BrightCodeAgentsModelBinding = {
      provider: provider(),
      modelId: 'fake-model',
      credential: { method: 'api_key', apiKey: 'secret' },
    }
    const runtimeProvider = createAgentsRuntimeProvider(binding, service)
    const chunks = []
    for await (const chunk of runtimeProvider.stream({
      model: 'fake-model',
      messages: [
        { role: 'user', content: 'earlier' },
        { role: 'assistant', content: 'previous answer' },
        { role: 'user', content: 'hello' },
      ],
    })) chunks.push(chunk)

    expect(chunks.map((chunk) => chunk.type)).toEqual(['message_start', 'text_delta', 'message_end'])
    expect(chunks[1]).toMatchObject({ type: 'text_delta', text: 'ok' })
    expect(calls[0]?.params.model).toBe('fake-model')
    expect(calls[0]?.params.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
    expect(calls[0]?.credential?.apiKey).toBe('secret')
  })
})
