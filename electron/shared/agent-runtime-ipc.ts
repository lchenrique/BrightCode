import type { RuntimeEvent, ThreadState } from './agent-protocol'

export interface AgentRuntimeThreadCreateCommand {
  threadId?: string
}

export interface AgentRuntimeThreadReadCommand {
  threadId: string
}

export interface AgentRuntimeHistoryReadCommand {
  threadId: string
  afterSequence?: number
}

export interface AgentRuntimeImageInput {
  data: string
  mediaType: string
}

export interface AgentRuntimeTurnStartCommand {
  threadId: string
  text: string
  modelId?: string
  accountId?: string
  images?: AgentRuntimeImageInput[]
}

export interface AgentRuntimeTurnInterruptCommand {
  threadId: string
}

export interface AgentRuntimeSubscribeCommand {
  threadId: string
  subscriptionId: string
  afterSequence?: number
}

export interface AgentRuntimeUnsubscribeCommand {
  subscriptionId: string
}

export interface AgentRuntimeEventEnvelope {
  event: RuntimeEvent
  state: ThreadState
}

export const AGENT_RUNTIME_MAX_IMAGES = 4
export const AGENT_RUNTIME_MAX_IMAGE_DATA_CHARS = 8_000_000
export const AGENT_RUNTIME_MAX_TOTAL_IMAGE_DATA_CHARS = 20_000_000

export function isAgentRuntimeImagePayloadWithinLimit(
  images: AgentRuntimeImageInput[] | undefined,
): boolean {
  let total = 0
  for (const image of images ?? []) {
    total += image.data.length
    if (total > AGENT_RUNTIME_MAX_TOTAL_IMAGE_DATA_CHARS) return false
  }
  return true
}

const threadId = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9_-]+$',
} as const

const subscriptionId = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9_-]+$',
} as const

export const AGENT_RUNTIME_IPC_SCHEMAS = {
  threadCreate: {
    type: 'object',
    additionalProperties: false,
    properties: { threadId },
  },
  threadRead: {
    type: 'object',
    additionalProperties: false,
    required: ['threadId'],
    properties: { threadId },
  },
  historyRead: {
    type: 'object',
    additionalProperties: false,
    required: ['threadId'],
    properties: {
      threadId,
      afterSequence: { type: 'integer', minimum: -1 },
    },
  },
  turnStart: {
    type: 'object',
    additionalProperties: false,
    required: ['threadId', 'text'],
    properties: {
      threadId,
      text: { type: 'string', minLength: 1, maxLength: 200_000 },
      modelId: { type: 'string', minLength: 1, maxLength: 200 },
      accountId: { type: 'string', minLength: 1, maxLength: 128 },
      images: {
        type: 'array',
        maxItems: AGENT_RUNTIME_MAX_IMAGES,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['data', 'mediaType'],
          properties: {
            data: {
              type: 'string',
              minLength: 1,
              maxLength: AGENT_RUNTIME_MAX_IMAGE_DATA_CHARS,
            },
            mediaType: { type: 'string', pattern: '^image/[A-Za-z0-9.+-]+$' },
          },
        },
      },
    },
  },
  turnInterrupt: {
    type: 'object',
    additionalProperties: false,
    required: ['threadId'],
    properties: { threadId },
  },
  subscribe: {
    type: 'object',
    additionalProperties: false,
    required: ['threadId', 'subscriptionId'],
    properties: {
      threadId,
      subscriptionId,
      afterSequence: { type: 'integer', minimum: -1 },
    },
  },
  unsubscribe: {
    type: 'object',
    additionalProperties: false,
    required: ['subscriptionId'],
    properties: { subscriptionId },
  },
} as const

export interface AgentRuntimeAPI {
  createThread(command: AgentRuntimeThreadCreateCommand): Promise<{ threadId: string }>
  readThread(command: AgentRuntimeThreadReadCommand): Promise<ThreadState>
  readHistory(command: AgentRuntimeHistoryReadCommand): Promise<RuntimeEvent[]>
  startTurn(command: AgentRuntimeTurnStartCommand): Promise<{ turnId: string }>
  interruptTurn(command: AgentRuntimeTurnInterruptCommand): Promise<void>
  subscribe(
    command: AgentRuntimeSubscribeCommand,
    listener: (envelope: AgentRuntimeEventEnvelope) => void,
  ): Promise<() => void>
}
