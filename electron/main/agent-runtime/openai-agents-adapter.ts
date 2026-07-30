import { randomUUID } from 'node:crypto'
import {
  Usage,
  type AgentInputItem,
  type AssistantMessageItem,
  type FunctionCallItem,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ReasoningItem,
  type StreamEvent,
} from '@openai/agents'
import type {
  ChatMessage,
  ContentBlock,
  IAgentProvider,
  ProviderCredential,
  ThinkingLevel,
  ToolDefinition,
} from '../../shared/providers/types'
import {
  getProviderService,
  type ProviderService,
  type RunProviderStreamInput,
} from './provider-service'

export interface BrightCodeAgentsModelBinding {
  provider: IAgentProvider
  modelId: string
  credential?: ProviderCredential
}

export type BrightCodeAgentsModelResolver = (
  modelName?: string,
) => BrightCodeAgentsModelBinding

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringifyToolInput(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value ?? {})
}

function parseToolInput(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function textFromToolOutput(output: unknown): string {
  if (typeof output === 'string') return output
  if (isRecord(output) && output['type'] === 'text' && typeof output['text'] === 'string') {
    return output['text']
  }
  if (Array.isArray(output)) {
    return output.map((part) => {
      if (isRecord(part) && part['type'] === 'input_text' && typeof part['text'] === 'string') {
        return part['text']
      }
      throw new Error('OpenAI Agents adapter does not support non-text tool output.')
    }).join('\n')
  }
  throw new Error('OpenAI Agents adapter does not support structured tool output.')
}

function contentFromUserItem(item: Extract<AgentInputItem, { role: 'user' }>): string {
  if (typeof item.content === 'string') return item.content
  return item.content.map((part) => {
    if (part.type === 'input_text') return part.text
    throw new Error(`OpenAI Agents adapter does not support user content type "${part.type}".`)
  }).join('\n')
}

function contentFromAssistantItem(
  item: Extract<AgentInputItem, { role: 'assistant' }>,
): string {
  return item.content.map((part) => {
    if (part.type === 'output_text') return part.text
    throw new Error(`OpenAI Agents adapter does not support assistant content type "${part.type}".`)
  }).join('\n')
}

function toChatMessages(input: ModelRequest['input']): ChatMessage[] {
  if (typeof input === 'string') return [{ role: 'user', content: input }]

  const messages: ChatMessage[] = []
  for (const item of input) {
    if ('role' in item && item.role === 'user') {
      messages.push({ role: 'user', content: contentFromUserItem(item) })
      continue
    }
    if ('role' in item && item.role === 'assistant') {
      messages.push({ role: 'assistant', content: contentFromAssistantItem(item) })
      continue
    }
    if ('role' in item && item.role === 'system') {
      messages.push({ role: 'system', content: item.content })
      continue
    }
    if (item.type === 'function_call') {
      const block: ContentBlock = {
        type: 'tool_use',
        id: item.callId,
        name: item.name,
        input: parseToolInput(item.arguments),
        ...(isRecord(item.providerData?.['providerItem'])
          ? { providerItem: item.providerData['providerItem'] }
          : {}),
      }
      const previous = messages.at(-1)
      if (previous?.role === 'assistant' && Array.isArray(previous.content)) {
        previous.content.push(block)
      } else {
        messages.push({ role: 'assistant', content: [block] })
      }
      continue
    }
    if (item.type === 'reasoning') {
      const providerOutputItem = item.providerData?.['providerOutputItem']
      if (isRecord(providerOutputItem)) {
        messages.push({
          role: 'assistant',
          content: '',
          providerOutputItems: [providerOutputItem],
        })
        continue
      }
      const providerItem = item.providerData?.['providerItem']
      if (isRecord(providerItem)) {
        const text = typeof providerItem['thinking'] === 'string'
          ? providerItem['thinking']
          : typeof providerItem['text'] === 'string'
            ? providerItem['text']
            : ''
        messages.push({
          role: 'assistant',
          content: [{ type: 'thinking', text, providerItem }],
        })
        continue
      }
      throw new Error('OpenAI Agents adapter cannot replay reasoning without provider data.')
    }
    if (item.type === 'function_call_result') {
      const block: ContentBlock = {
        type: 'tool_result',
        toolUseId: item.callId,
        toolName: item.name,
        content: textFromToolOutput(item.output),
      }
      const previous = messages.at(-1)
      if (previous?.role === 'tool' && Array.isArray(previous.content)) {
        previous.content.push(block)
      } else {
        messages.push({ role: 'tool', content: [block] })
      }
      continue
    }
    throw new Error(`OpenAI Agents adapter does not support input item type "${item.type}".`)
  }
  return messages
}

function toToolParameters(schema: unknown): ToolDefinition['parameters'] {
  if (!isRecord(schema) || schema['type'] !== 'object' || !isRecord(schema['properties'])) {
    throw new Error('OpenAI Agents adapter requires object JSON schemas for tools.')
  }
  return schema as ToolDefinition['parameters']
}

function toToolDefinitions(request: ModelRequest): ToolDefinition[] {
  const tools = request.tools.map((tool): ToolDefinition => {
    if (tool.type !== 'function') {
      throw new Error(`OpenAI Agents adapter does not support tool type "${tool.type}".`)
    }
    return {
      name: tool.name,
      description: tool.description,
      parameters: toToolParameters(tool.parameters),
    }
  })
  const handoffs = request.handoffs.map((handoff): ToolDefinition => ({
    name: handoff.toolName,
    description: handoff.toolDescription,
    parameters: toToolParameters(handoff.inputJsonSchema),
  }))
  return [...tools, ...handoffs]
}

function toThinkingLevel(request: ModelRequest): ThinkingLevel | undefined {
  const effort = request.modelSettings.reasoning?.effort
  if (effort === undefined || effort === null) return undefined
  if (effort === 'none') return 'off'
  if (effort === 'xhigh') {
    throw new Error('OpenAI Agents adapter does not support reasoning effort "xhigh".')
  }
  return effort
}

function toToolChoice(request: ModelRequest): 'auto' | 'none' | { name: string } | undefined {
  const choice = request.modelSettings.toolChoice
  if (choice === undefined) return undefined
  if (choice === 'required') {
    throw new Error('OpenAI Agents adapter does not support required tool choice.')
  }
  if (choice === 'auto') return 'auto'
  if (choice === 'none') return 'none'
  return { name: choice }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError')
}

export class BrightCodeAgentsModel implements Model {
  private readonly binding: BrightCodeAgentsModelBinding
  private readonly providerService: ProviderService

  constructor(binding: BrightCodeAgentsModelBinding, providerService: ProviderService) {
    this.binding = binding
    this.providerService = providerService
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    for await (const event of this.getStreamedResponse(request)) {
      if (event.type === 'response_done') {
        return {
          usage: new Usage(event.response.usage),
          output: event.response.output,
          requestId: event.response.requestId,
        }
      }
    }
    throw new Error('BrightCode provider stream ended without a response.')
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    if (request.signal?.aborted) throw abortError(request.signal)
    if (request.conversationId || request.previousResponseId) {
      throw new Error(
        'OpenAI Agents adapter does not support server-managed conversation state.',
      )
    }

    const responseId = randomUUID()
    const output: Array<AssistantMessageItem | FunctionCallItem | ReasoningItem> = []
    const toolCalls = new Map<string, {
      name: string
      arguments: string
      providerItem?: Record<string, unknown>
    }>()
    let textMessage: AssistantMessageItem | undefined
    let textContent: { type: 'output_text'; text: string } | undefined
    let usage = new Usage({ requests: 1 })
    let completed = false

    yield { type: 'response_started' }

    const input: RunProviderStreamInput = {
      threadId: responseId,
      turnId: responseId,
      startSequence: 0,
      provider: this.binding.provider,
      credential: this.binding.credential,
      signal: request.signal,
      params: {
        model: this.binding.modelId,
        messages: toChatMessages(request.input),
        systemPrompt: request.systemInstructions,
        temperature: request.modelSettings.temperature,
        maxTokens: request.modelSettings.maxTokens,
        signal: request.signal,
        thinking: toThinkingLevel(request),
        tools: toToolDefinitions(request),
        toolChoice: toToolChoice(request),
      },
    }

    for await (const event of this.providerService.run(input)) {
      if (request.signal?.aborted) throw abortError(request.signal)

      if (event.type === 'text_delta' && event.payload.text) {
        if (!textMessage || !textContent) {
          textContent = { type: 'output_text', text: '' }
          textMessage = {
            id: `message-${responseId}`,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [textContent],
          }
          output.push(textMessage)
        }
        textContent.text += event.payload.text
        yield {
          type: 'output_text_delta',
          itemId: textMessage.id,
          delta: event.payload.text,
        }
        continue
      }

      if (event.type === 'provider_output_item' && event.payload.providerOutputItem) {
        const providerItem = event.payload.providerOutputItem
        output.push({
          type: 'reasoning',
          ...(typeof providerItem['id'] === 'string' ? { id: providerItem['id'] } : {}),
          content: [],
          providerData: event.payload.provider === 'openai-responses'
            ? { provider: event.payload.provider, providerOutputItem: providerItem }
            : { provider: event.payload.provider, providerItem },
        })
        continue
      }

      if (event.type === 'tool_use_start' && event.itemId && event.payload.toolName) {
        toolCalls.set(event.itemId, {
          name: event.payload.toolName,
          arguments: '{}',
          ...(event.payload.providerItem ? { providerItem: event.payload.providerItem } : {}),
        })
        continue
      }

      if (event.type === 'tool_use_delta' && event.itemId) {
        const call = toolCalls.get(event.itemId)
        if (!call) throw new Error(`Tool delta received before start for "${event.itemId}".`)
        call.arguments = stringifyToolInput(event.payload.toolInput)
        if (event.payload.providerItem) call.providerItem = event.payload.providerItem
        continue
      }

      if (event.type === 'tool_use_end' && event.itemId) {
        const call = toolCalls.get(event.itemId)
        if (!call) throw new Error(`Tool end received before start for "${event.itemId}".`)
        const item: FunctionCallItem = {
          type: 'function_call',
          id: event.itemId,
          callId: event.itemId,
          name: call.name,
          arguments: call.arguments,
          status: 'completed',
          ...(call.providerItem ? { providerData: { providerItem: call.providerItem } } : {}),
        }
        output.push(item)
        toolCalls.delete(event.itemId)
        continue
      }

      if (event.type === 'error') {
        throw new Error(event.payload.error?.message ?? 'BrightCode provider error.')
      }

      if (event.type === 'message_end') {
        for (const [callId, call] of toolCalls) {
          output.push({
            type: 'function_call',
            id: callId,
            callId,
            name: call.name,
            arguments: call.arguments,
            status: 'completed',
          })
        }
        toolCalls.clear()
        const providerUsage = event.payload.usage
        usage = new Usage({
          requests: 1,
          inputTokens: providerUsage?.input ?? 0,
          outputTokens: providerUsage?.output ?? 0,
          totalTokens: (providerUsage?.input ?? 0) + (providerUsage?.output ?? 0),
          inputTokensDetails: providerUsage ? [{
            cacheRead: providerUsage.cacheRead ?? 0,
            cacheWrite: providerUsage.cacheWrite ?? 0,
          }] : [],
        })
        completed = true
        yield {
          type: 'response_done',
          response: {
            id: responseId,
            usage,
            output,
          },
        }
        return
      }
    }

    if (request.signal?.aborted) throw abortError(request.signal)
    if (!completed) throw new Error('BrightCode provider stream ended without message_end.')
  }
}

export class BrightCodeAgentsModelProvider implements ModelProvider {
  private readonly resolveModel: BrightCodeAgentsModelResolver
  private readonly providerService: ProviderService

  constructor(
    resolveModel: BrightCodeAgentsModelResolver,
    providerService: ProviderService = getProviderService(),
  ) {
    this.resolveModel = resolveModel
    this.providerService = providerService
  }

  getModel(modelName?: string): Model {
    return new BrightCodeAgentsModel(this.resolveModel(modelName), this.providerService)
  }
}
