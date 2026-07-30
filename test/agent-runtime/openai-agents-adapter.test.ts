import { Agent, RunState, Runner, tool } from '@openai/agents'
import { z } from 'zod'
import { describe, expect, it, vi } from 'vitest'
import type {
  IAgentProvider,
  ProviderEvent,
} from '../../electron/shared/providers/types'
import {
  BrightCodeAgentsModelProvider,
} from '../../electron/main/agent-runtime/openai-agents-adapter'
import type {
  ProviderService,
  RunProviderStreamInput,
} from '../../electron/main/agent-runtime/provider-service'
import { anthropicMessagesHandler } from '../../src/lib/providers/formats/anthropic-messages'
import { geminiNativeHandler } from '../../src/lib/providers/formats/gemini-native'
import { openaiChatHandler } from '../../src/lib/providers/formats/openai-chat'

function makeProvider(): IAgentProvider {
  return {
    id: 'fake',
    name: 'Fake',
    baseURL: 'https://fake.invalid',
    authMethod: 'api_key',
    apiFormat: 'custom',
    listModels: () => [{ id: 'fake-model', displayName: 'Fake', provider: 'fake' }],
    stream: async function* () {},
    validateCredential: async () => true,
  }
}

function serviceFrom(
  run: (input: RunProviderStreamInput) => AsyncGenerator<ProviderEvent>,
): ProviderService {
  return { run }
}

function event(
  input: RunProviderStreamInput,
  sequence: number,
  value: Omit<ProviderEvent, 'threadId' | 'turnId' | 'sequence' | 'timestamp'>,
): ProviderEvent {
  return {
    ...value,
    threadId: input.threadId,
    turnId: input.turnId,
    sequence,
    timestamp: sequence,
  }
}

function modelProvider(service: ProviderService): BrightCodeAgentsModelProvider {
  const provider = makeProvider()
  return new BrightCodeAgentsModelProvider(
    (modelName) => ({ provider, modelId: modelName ?? 'fake-model' }),
    service,
  )
}

describe('OpenAI Agents SDK adapter', () => {
  it('streams through Runner and performs a native handoff', async () => {
    const calls: RunProviderStreamInput[] = []
    const service = serviceFrom(async function* (input) {
      calls.push(input)
      if (calls.length === 1) {
        const handoffName = input.params.tools?.[0]?.name
        if (!handoffName) throw new Error('Missing handoff tool')
        yield event(input, 0, {
          type: 'tool_use_start',
          itemId: 'handoff-1',
          payload: { toolName: handoffName },
        })
        yield event(input, 1, {
          type: 'tool_use_delta',
          itemId: 'handoff-1',
          payload: { toolInput: {} },
        })
        yield event(input, 2, {
          type: 'tool_use_end',
          itemId: 'handoff-1',
          payload: {},
        })
        yield event(input, 3, {
          type: 'message_end',
          payload: { stopReason: 'tool_use', model: 'fake-model' },
        })
        return
      }

      yield event(input, 0, { type: 'text_delta', payload: { text: 'special' } })
      yield event(input, 1, { type: 'text_delta', payload: { text: 'ist' } })
      yield event(input, 2, {
        type: 'message_end',
        payload: {
          stopReason: 'end_turn',
          model: 'fake-model',
          usage: { input: 11, output: 2, cacheRead: 3 },
        },
      })
    })
    const provider = modelProvider(service)
    const specialist = new Agent({
      name: 'Specialist',
      instructions: 'Finish the task.',
      model: 'fake-model',
    })
    const triage = new Agent({
      name: 'Triage',
      instructions: 'Delegate the task.',
      model: 'fake-model',
      handoffs: [specialist],
    })
    const runner = new Runner({ modelProvider: provider, tracingDisabled: true })

    const result = await runner.run(triage, 'delegate', { stream: true })
    const deltas: string[] = []
    for await (const streamEvent of result) {
      if (
        streamEvent.type === 'raw_model_stream_event'
        && streamEvent.data.type === 'output_text_delta'
      ) {
        deltas.push(streamEvent.data.delta)
      }
    }

    expect(deltas).toEqual(['special', 'ist'])
    expect(result.finalOutput).toBe('specialist')
    expect(result.lastAgent?.name).toBe('Specialist')
    expect(calls).toHaveLength(2)
    expect(calls[0]?.params.tools?.[0]?.name).toMatch(/^transfer_to_/)
    expect(calls[1]?.params.messages.some((message) => message.role === 'tool')).toBe(true)
    expect(result.runContext.usage.inputTokens).toBe(11)
    expect(result.runContext.usage.outputTokens).toBe(2)
  })

  it('serializes an approval interruption and resumes the same RunState', async () => {
    let providerCalls = 0
    const executed = vi.fn(() => 'approved')
    const service = serviceFrom(async function* (input) {
      providerCalls++
      if (providerCalls === 1) {
        yield event(input, 0, {
          type: 'tool_use_start',
          itemId: 'secure-1',
          payload: { toolName: 'secure_action' },
        })
        yield event(input, 1, {
          type: 'tool_use_delta',
          itemId: 'secure-1',
          payload: { toolInput: { value: 'ok' } },
        })
        yield event(input, 2, {
          type: 'tool_use_end',
          itemId: 'secure-1',
          payload: {},
        })
        yield event(input, 3, {
          type: 'message_end',
          payload: { stopReason: 'tool_use', model: 'fake-model' },
        })
        return
      }

      expect(input.params.messages).toContainEqual({
        role: 'tool',
        content: [{
          type: 'tool_result',
          toolUseId: 'secure-1',
          toolName: 'secure_action',
          content: 'approved',
        }],
      })
      const geminiRequest = geminiNativeHandler.buildRequest(
        input.params,
        { method: 'api_key', apiKey: 'test-key' },
        'https://generativelanguage.googleapis.com',
      )
      expect(JSON.parse(geminiRequest.init.body as string)).toMatchObject({
        contents: expect.arrayContaining([{
          role: 'user',
          parts: [{
            functionResponse: {
              id: 'secure-1',
              name: 'secure_action',
              response: { result: 'approved', isError: false },
            },
          }],
        }]),
      })
      yield event(input, 0, { type: 'text_delta', payload: { text: 'done' } })
      yield event(input, 1, {
        type: 'message_end',
        payload: { stopReason: 'end_turn', model: 'fake-model' },
      })
    })
    const provider = modelProvider(service)
    const secureAction = tool({
      name: 'secure_action',
      description: 'Run a protected action.',
      parameters: z.object({ value: z.string() }),
      needsApproval: true,
      execute: executed,
    })
    const agent = new Agent({
      name: 'Approval Agent',
      instructions: 'Use the tool.',
      model: 'fake-model',
      tools: [secureAction],
    })
    const runner = new Runner({ modelProvider: provider, tracingDisabled: true })

    const interrupted = await runner.run(agent, 'run protected action')
    expect(interrupted.interruptions).toHaveLength(1)
    expect(executed).not.toHaveBeenCalled()

    const resumedState = await RunState.fromString(agent, interrupted.state.toString())
    const [approval] = resumedState.getInterruptions()
    if (!approval) throw new Error('Missing approval interruption')
    resumedState.approve(approval)
    const completed = await runner.run(agent, resumedState)

    expect(executed).toHaveBeenCalledOnce()
    expect(completed.finalOutput).toBe('done')
    expect(completed.interruptions).toHaveLength(0)
    expect(providerCalls).toBe(2)
  })

  it('preserves Gemini tool IDs, arguments, and parallel calls', () => {
    const chunks = geminiNativeHandler.createContext().processEvent({
      data: JSON.stringify({
        candidates: [{
          content: {
            role: 'model',
            parts: [
              { functionCall: { id: 'call-a', name: 'lookup', args: { query: 'A' } } },
              { functionCall: { id: 'call-b', name: 'lookup', args: { query: 'B' } } },
            ],
          },
        }],
      }),
    })

    expect(chunks).toEqual([
      { type: 'tool_use_start', id: 'call-a', name: 'lookup' },
      { type: 'tool_use_delta', id: 'call-a', name: 'lookup', input: { query: 'A' } },
      { type: 'tool_use_end', id: 'call-a' },
      { type: 'tool_use_start', id: 'call-b', name: 'lookup' },
      { type: 'tool_use_delta', id: 'call-b', name: 'lookup', input: { query: 'B' } },
      { type: 'tool_use_end', id: 'call-b' },
    ])
  })

  it('replays Gemini thoughtSignature through a Runner tool continuation', async () => {
    const chunks = geminiNativeHandler.createContext().processEvent({
      data: JSON.stringify({
        candidates: [{
          content: {
            role: 'model',
            parts: [{
              functionCall: { id: 'call-g', name: 'lookup', args: { query: 'G' } },
              thoughtSignature: 'signed-gemini-thought',
            }],
          },
        }],
      }),
    })
    if (!Array.isArray(chunks)) throw new Error('Expected Gemini tool chunks')
    let providerCalls = 0
    const service = serviceFrom(async function* (input) {
      providerCalls++
      if (providerCalls === 1) {
        let sequence = 0
        for (const chunk of chunks) {
          if (chunk.type === 'tool_use_start') {
            yield event(input, sequence++, {
              type: 'tool_use_start',
              itemId: chunk.id,
              payload: { toolName: chunk.name, providerItem: chunk.providerItem },
            })
          } else if (chunk.type === 'tool_use_delta') {
            yield event(input, sequence++, {
              type: 'tool_use_delta',
              itemId: chunk.id,
              payload: { toolName: chunk.name, toolInput: chunk.input, providerItem: chunk.providerItem },
            })
          } else if (chunk.type === 'tool_use_end') {
            yield event(input, sequence++, {
              type: 'tool_use_end',
              itemId: chunk.id,
              payload: {},
            })
          }
        }
        yield event(input, sequence, {
          type: 'message_end',
          payload: { stopReason: 'tool_use', model: 'fake-model' },
        })
        return
      }

      const body = JSON.parse(geminiNativeHandler.buildRequest(
        input.params,
        { method: 'api_key', apiKey: 'test-key' },
        'https://generativelanguage.googleapis.com',
      ).init.body as string)
      expect(body.contents).toEqual(expect.arrayContaining([{
        role: 'model',
        parts: [{
          functionCall: { id: 'call-g', name: 'lookup', args: { query: 'G' } },
          thoughtSignature: 'signed-gemini-thought',
        }],
      }]))
      yield event(input, 0, { type: 'text_delta', payload: { text: 'done' } })
      yield event(input, 1, {
        type: 'message_end',
        payload: { stopReason: 'end_turn', model: 'fake-model' },
      })
    })
    const lookup = tool({
      name: 'lookup',
      description: 'Look something up.',
      parameters: z.object({ query: z.string() }),
      execute: () => 'found',
    })
    const runner = new Runner({
      modelProvider: modelProvider(service),
      tracingDisabled: true,
    })
    const agent = new Agent({
      name: 'Gemini Signature Agent',
      instructions: 'Use lookup.',
      model: 'fake-model',
      tools: [lookup],
    })

    const result = await runner.run(agent, 'lookup G')

    expect(result.finalOutput).toBe('done')
    expect(providerCalls).toBe(2)
  })

  it('omits Gemini tools when toolChoice is none', () => {
    const body = JSON.parse(geminiNativeHandler.buildRequest({
      model: 'gemini-3',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{
        name: 'lookup',
        description: 'Look up.',
        parameters: { type: 'object', properties: {} },
      }],
      toolChoice: 'none',
    }, { method: 'api_key', apiKey: 'test-key' }, 'https://generativelanguage.googleapis.com').init.body as string)

    expect(body.tools).toBeUndefined()
    expect(body.toolConfig).toBeUndefined()
  })

  it('preserves raw OpenAI Responses arguments through a Runner continuation', async () => {
    const rawArguments = '{"n":9007199254740993}'
    const ctx = openaiChatHandler.createContext()
    const start = ctx.processEvent({
      data: JSON.stringify({
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          id: 'fc-native',
          type: 'function_call',
          call_id: 'call-raw',
          name: 'lookup',
          arguments: rawArguments,
        },
      }),
    })
    const done = ctx.processEvent({
      data: JSON.stringify({
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'fc-native',
          type: 'function_call',
          call_id: 'call-raw',
          name: 'lookup',
          arguments: rawArguments,
        },
      }),
    })
    if (!start || Array.isArray(start) || start.type !== 'tool_use_start') {
      throw new Error('Missing Responses tool start')
    }
    if (!done || Array.isArray(done) || done.type !== 'tool_use_delta') {
      throw new Error('Missing Responses tool delta')
    }
    let providerCalls = 0
    const service = serviceFrom(async function* (input) {
      providerCalls++
      if (providerCalls === 1) {
        yield event(input, 0, {
          type: 'tool_use_start',
          itemId: start.id,
          payload: { toolName: start.name, providerItem: start.providerItem },
        })
        yield event(input, 1, {
          type: 'tool_use_delta',
          itemId: done.id,
          payload: { toolName: done.name, toolInput: done.input, providerItem: done.providerItem },
        })
        yield event(input, 2, {
          type: 'tool_use_end',
          itemId: done.id,
          payload: {},
        })
        yield event(input, 3, {
          type: 'message_end',
          payload: { stopReason: 'tool_use', model: 'fake-model' },
        })
        return
      }

      const body = JSON.parse(openaiChatHandler.buildRequest(
        input.params,
        { method: 'api_key', apiKey: 'test-key' },
        'https://api.openai.com/v1/responses',
      ).init.body as string)
      expect(body.input).toContainEqual({
        id: 'fc-native',
        type: 'function_call',
        call_id: 'call-raw',
        name: 'lookup',
        arguments: rawArguments,
      })
      yield event(input, 0, { type: 'text_delta', payload: { text: 'done' } })
      yield event(input, 1, {
        type: 'message_end',
        payload: { stopReason: 'end_turn', model: 'fake-model' },
      })
    })
    const lookup = tool({
      name: 'lookup',
      description: 'Look something up.',
      parameters: z.object({ n: z.number() }),
      execute: () => 'found',
    })
    const runner = new Runner({
      modelProvider: modelProvider(service),
      tracingDisabled: true,
    })
    const agent = new Agent({
      name: 'Responses Raw Arguments Agent',
      instructions: 'Use lookup.',
      model: 'fake-model',
      tools: [lookup],
    })

    const result = await runner.run(agent, 'lookup the number')

    expect(result.finalOutput).toBe('done')
    expect(providerCalls).toBe(2)
  })

  it('maps tool results to valid provider wire payloads', () => {
    const params = {
      model: 'test-model',
      messages: [{
        role: 'tool' as const,
        content: [{
          type: 'tool_result' as const,
          toolUseId: 'call-1',
          content: 'found',
        }],
        toolCallId: 'call-1',
        toolName: 'lookup',
      }],
    }
    const geminiBody = JSON.parse(geminiNativeHandler.buildRequest(
      params,
      { method: 'api_key', apiKey: 'test-key' },
      'https://generativelanguage.googleapis.com',
    ).init.body as string)
    const anthropicBody = JSON.parse(anthropicMessagesHandler.buildRequest(
      params,
      { method: 'api_key', apiKey: 'test-key' },
      'https://api.anthropic.com',
    ).init.body as string)
    const openaiBody = JSON.parse(openaiChatHandler.buildRequest(
      params,
      { method: 'api_key', apiKey: 'test-key' },
      'https://api.openai.com/v1',
    ).init.body as string)

    expect(geminiBody.contents).toEqual([{
      role: 'user',
      parts: [{
        functionResponse: {
          id: 'call-1',
          name: 'lookup',
          response: { result: 'found', isError: false },
        },
      }],
    }])
    expect(anthropicBody.messages).toEqual([{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'found' }],
    }])
    expect(openaiBody.messages).toEqual([{
      role: 'tool',
      tool_call_id: 'call-1',
      content: 'found',
    }])
  })

  it('carries parallel Runner tool calls and results to every provider wire', async () => {
    let providerCalls = 0
    let secondRound: RunProviderStreamInput | undefined
    const service = serviceFrom(async function* (input) {
      providerCalls++
      if (providerCalls === 1) {
        const calls = [
          {
            id: 'call-a',
            name: 'lookup_a',
            input: { query: 'A' },
            providerItem: {
              id: 'fc-native-a',
              type: 'function_call',
              call_id: 'call-a',
              name: 'lookup_a',
              arguments: '{"query":"A"}',
            },
          },
          {
            id: 'call-b',
            name: 'lookup_b',
            input: { query: 'B' },
            providerItem: {
              id: 'fc-native-b',
              type: 'function_call',
              call_id: 'call-b',
              name: 'lookup_b',
              arguments: '{"query":"B"}',
            },
          },
        ]
        let sequence = 0
        for (const call of calls) {
          yield event(input, sequence++, {
            type: 'tool_use_start',
            itemId: call.id,
            payload: { toolName: call.name, providerItem: call.providerItem },
          })
          yield event(input, sequence++, {
            type: 'tool_use_delta',
            itemId: call.id,
            payload: { toolInput: call.input, providerItem: call.providerItem },
          })
          yield event(input, sequence++, {
            type: 'tool_use_end',
            itemId: call.id,
            payload: {},
          })
        }
        yield event(input, sequence, {
          type: 'message_end',
          payload: { stopReason: 'tool_use', model: 'fake-model' },
        })
        return
      }

      secondRound = input
      yield event(input, 0, { type: 'text_delta', payload: { text: 'done' } })
      yield event(input, 1, {
        type: 'message_end',
        payload: { stopReason: 'end_turn', model: 'fake-model' },
      })
    })
    const lookupA = tool({
      name: 'lookup_a',
      description: 'Look up A.',
      parameters: z.object({ query: z.string() }),
      execute: () => 'result-a',
    })
    const lookupB = tool({
      name: 'lookup_b',
      description: 'Look up B.',
      parameters: z.object({ query: z.string() }),
      execute: () => 'result-b',
    })
    const runner = new Runner({
      modelProvider: modelProvider(service),
      tracingDisabled: true,
    })
    const agent = new Agent({
      name: 'Parallel Agent',
      instructions: 'Use both tools.',
      model: 'fake-model',
      tools: [lookupA, lookupB],
    })

    const result = await runner.run(agent, 'look up A and B')
    if (!secondRound) throw new Error('Missing second provider round')
    const params = secondRound.params
    const expectedCalls = [
      { type: 'tool_use', id: 'call-a', name: 'lookup_a', input: { query: 'A' } },
      { type: 'tool_use', id: 'call-b', name: 'lookup_b', input: { query: 'B' } },
    ]
    const expectedResults = [
      { type: 'tool_result', toolUseId: 'call-a', toolName: 'lookup_a', content: 'result-a' },
      { type: 'tool_result', toolUseId: 'call-b', toolName: 'lookup_b', content: 'result-b' },
    ]

    expect(result.finalOutput).toBe('done')
    expect(params.messages).toEqual(expect.arrayContaining([
      { role: 'assistant', content: expectedCalls.map((call, index) => ({
        ...call,
        providerItem: index === 0
          ? {
              id: 'fc-native-a',
              type: 'function_call',
              call_id: 'call-a',
              name: 'lookup_a',
              arguments: '{"query":"A"}',
            }
          : {
              id: 'fc-native-b',
              type: 'function_call',
              call_id: 'call-b',
              name: 'lookup_b',
              arguments: '{"query":"B"}',
            },
      })) },
      { role: 'tool', content: expectedResults },
    ]))

    const credential = { method: 'api_key' as const, apiKey: 'test-key' }
    const geminiBody = JSON.parse(geminiNativeHandler.buildRequest(
      params,
      credential,
      'https://generativelanguage.googleapis.com',
    ).init.body as string)
    const anthropicBody = JSON.parse(anthropicMessagesHandler.buildRequest(
      params,
      credential,
      'https://api.anthropic.com',
    ).init.body as string)
    const openaiChatBody = JSON.parse(openaiChatHandler.buildRequest(
      params,
      credential,
      'https://api.openai.com/v1',
    ).init.body as string)
    const openaiResponsesBody = JSON.parse(openaiChatHandler.buildRequest(
      params,
      credential,
      'https://api.openai.com/v1/responses',
    ).init.body as string)

    expect(geminiBody.contents).toEqual(expect.arrayContaining([
      {
        role: 'model',
        parts: [
          { functionCall: { id: 'call-a', name: 'lookup_a', args: { query: 'A' } } },
          { functionCall: { id: 'call-b', name: 'lookup_b', args: { query: 'B' } } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { id: 'call-a', name: 'lookup_a', response: { result: 'result-a', isError: false } } },
          { functionResponse: { id: 'call-b', name: 'lookup_b', response: { result: 'result-b', isError: false } } },
        ],
      },
    ]))
    expect(anthropicBody.messages).toEqual(expect.arrayContaining([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call-a', name: 'lookup_a', input: { query: 'A' } },
          { type: 'tool_use', id: 'call-b', name: 'lookup_b', input: { query: 'B' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call-a', content: 'result-a' },
          { type: 'tool_result', tool_use_id: 'call-b', content: 'result-b' },
        ],
      },
    ]))
    expect(openaiChatBody.messages).toEqual(expect.arrayContaining([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call-a', type: 'function', function: { name: 'lookup_a', arguments: '{"query":"A"}' } },
          { id: 'call-b', type: 'function', function: { name: 'lookup_b', arguments: '{"query":"B"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call-a', content: 'result-a' },
      { role: 'tool', tool_call_id: 'call-b', content: 'result-b' },
    ]))
    expect(openaiResponsesBody.input).toEqual(expect.arrayContaining([
      {
        id: 'fc-native-a',
        type: 'function_call',
        call_id: 'call-a',
        name: 'lookup_a',
        arguments: '{"query":"A"}',
      },
      {
        id: 'fc-native-b',
        type: 'function_call',
        call_id: 'call-b',
        name: 'lookup_b',
        arguments: '{"query":"B"}',
      },
      { type: 'function_call_output', call_id: 'call-a', output: 'result-a' },
      { type: 'function_call_output', call_id: 'call-b', output: 'result-b' },
    ]))
  })

  it('rejects server-managed conversation state before calling a provider', async () => {
    const run = vi.fn(async function* () {
      yield* []
    })
    const runner = new Runner({
      modelProvider: modelProvider(serviceFrom(run)),
      tracingDisabled: true,
    })
    const agent = new Agent({
      name: 'State Agent',
      instructions: 'Reply.',
      model: 'fake-model',
    })

    await expect(runner.run(agent, 'hello', { conversationId: 'conv-1' })).rejects.toThrow(
      'OpenAI Agents adapter does not support server-managed conversation state.',
    )
    await expect(runner.run(agent, 'hello', { previousResponseId: 'resp-1' })).rejects.toThrow(
      'OpenAI Agents adapter does not support server-managed conversation state.',
    )
    expect(run).not.toHaveBeenCalled()
  })

  it('replays signed Anthropic thinking on a stateless Runner tool round', async () => {
    const ctx = anthropicMessagesHandler.createContext()
    const thinkingEvents = [
      { event: 'content_block_start', data: JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) },
      { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'check' } }) },
      { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed-thinking' } }) },
      { event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop', index: 0 }) },
    ]
    const chunks = thinkingEvents.flatMap((streamEvent) => {
      const chunk = ctx.processEvent(streamEvent)
      return chunk ? (Array.isArray(chunk) ? chunk : [chunk]) : []
    })
    const providerOutput = chunks.find((chunk) => chunk.type === 'provider_output_item')
    if (!providerOutput || providerOutput.type !== 'provider_output_item') {
      throw new Error('Missing signed Anthropic thinking item')
    }
    let providerCalls = 0
    const service = serviceFrom(async function* (input) {
      providerCalls++
      if (providerCalls === 1) {
        yield event(input, 0, {
          type: 'provider_output_item',
          payload: {
            provider: providerOutput.provider,
            providerOutputItem: providerOutput.item,
          },
        })
        yield event(input, 1, {
          type: 'tool_use_start',
          itemId: 'lookup-anthropic',
          payload: { toolName: 'lookup' },
        })
        yield event(input, 2, {
          type: 'tool_use_delta',
          itemId: 'lookup-anthropic',
          payload: { toolInput: { query: 'A' } },
        })
        yield event(input, 3, {
          type: 'tool_use_end',
          itemId: 'lookup-anthropic',
          payload: {},
        })
        yield event(input, 4, {
          type: 'message_end',
          payload: { stopReason: 'tool_use', model: 'fake-model' },
        })
        return
      }

      const body = JSON.parse(anthropicMessagesHandler.buildRequest(
        input.params,
        { method: 'api_key', apiKey: 'test-key' },
        'https://api.anthropic.com',
      ).init.body as string)
      expect(body.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: expect.arrayContaining([
            { type: 'thinking', thinking: 'check', signature: 'signed-thinking' },
          ]),
        }),
      ]))
      yield event(input, 0, { type: 'text_delta', payload: { text: 'done' } })
      yield event(input, 1, {
        type: 'message_end',
        payload: { stopReason: 'end_turn', model: 'fake-model' },
      })
    })
    const lookup = tool({
      name: 'lookup',
      description: 'Look something up.',
      parameters: z.object({ query: z.string() }),
      execute: () => 'found',
    })
    const runner = new Runner({
      modelProvider: modelProvider(service),
      tracingDisabled: true,
    })
    const agent = new Agent({
      name: 'Anthropic Thinking Agent',
      instructions: 'Use lookup.',
      model: 'fake-model',
      tools: [lookup],
    })

    const result = await runner.run(agent, 'lookup A')

    expect(result.finalOutput).toBe('done')
    expect(providerCalls).toBe(2)
  })

  it('replays native provider reasoning on a stateless tool round', async () => {
    const reasoningItem = {
      id: 'reasoning-1',
      type: 'reasoning',
      encrypted_content: 'encrypted',
    }
    let providerCalls = 0
    const service = serviceFrom(async function* (input) {
      providerCalls++
      if (providerCalls === 1) {
        yield event(input, 0, {
          type: 'provider_output_item',
          payload: {
            provider: 'openai-responses',
            providerOutputItem: reasoningItem,
          },
        })
        yield event(input, 1, {
          type: 'tool_use_start',
          itemId: 'lookup-1',
          payload: { toolName: 'lookup' },
        })
        yield event(input, 2, {
          type: 'tool_use_delta',
          itemId: 'lookup-1',
          payload: { toolInput: { query: 'BrightCode' } },
        })
        yield event(input, 3, {
          type: 'tool_use_end',
          itemId: 'lookup-1',
          payload: {},
        })
        yield event(input, 4, {
          type: 'message_end',
          payload: { stopReason: 'tool_use', model: 'fake-model' },
        })
        return
      }

      expect(input.params.messages).toEqual(expect.arrayContaining([{
        role: 'assistant',
        content: '',
        providerOutputItems: [reasoningItem],
      }]))
      yield event(input, 0, { type: 'text_delta', payload: { text: 'done' } })
      yield event(input, 1, {
        type: 'message_end',
        payload: { stopReason: 'end_turn', model: 'fake-model' },
      })
    })
    const lookup = tool({
      name: 'lookup',
      description: 'Look something up.',
      parameters: z.object({ query: z.string() }),
      execute: () => 'found',
    })
    const runner = new Runner({
      modelProvider: modelProvider(service),
      tracingDisabled: true,
    })
    const agent = new Agent({
      name: 'Reasoning Agent',
      instructions: 'Use lookup.',
      model: 'fake-model',
      tools: [lookup],
    })

    const result = await runner.run(agent, 'lookup BrightCode')

    expect(result.finalOutput).toBe('done')
    expect(providerCalls).toBe(2)
  })

  it('propagates AbortSignal through Runner to the provider stream', async () => {
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let receivedSignal: AbortSignal | undefined
    const service = serviceFrom(async function* (input) {
      receivedSignal = input.signal
      markStarted?.()
      await new Promise<void>((resolve) => {
        input.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      yield* []
    })
    const runner = new Runner({
      modelProvider: modelProvider(service),
      tracingDisabled: true,
    })
    const agent = new Agent({
      name: 'Abort Agent',
      instructions: 'Wait.',
      model: 'fake-model',
    })
    const controller = new AbortController()

    const result = await runner.run(agent, 'wait', {
      stream: true,
      signal: controller.signal,
    })
    const consume = (async () => {
      for await (const _streamEvent of result) {
        // Drain until cancellation.
      }
    })()
    await started
    controller.abort()
    await consume

    expect(receivedSignal).toBeDefined()
    expect(receivedSignal?.aborted).toBe(true)
    expect(result.cancelled).toBe(true)
  })
})
