import Ajv, { type ValidateFunction } from 'ajv'
import { ipcMain, type WebContents } from 'electron'
import type { RuntimeEvent, ThreadState } from '../../shared/agent-protocol'
import {
  AGENT_RUNTIME_IPC_SCHEMAS,
  isAgentRuntimeImagePayloadWithinLimit,
  type AgentRuntimeHistoryReadCommand,
  type AgentRuntimeSubscribeCommand,
  type AgentRuntimeThreadCreateCommand,
  type AgentRuntimeThreadReadCommand,
  type AgentRuntimeTurnInterruptCommand,
  type AgentRuntimeTurnStartCommand,
  type AgentRuntimeUnsubscribeCommand,
} from '../../shared/agent-runtime-ipc'
import { IPC } from '../../shared/ipc-channels'
import { assertTrustedIpcSender } from '../renderer-security'
import { FAKE_RUNTIME_MODEL_ID, fakeRuntimeProvider } from './fake-runtime-provider'
import { createAgentsRuntimeProvider } from './agents-runtime-provider'
import { getRuntime } from './runtime'
import type { BrightCodeAgentsModelBinding } from './openai-agents-adapter'

const ajv = new Ajv({ allErrors: true })
const validators = {
  threadCreate: ajv.compile(AGENT_RUNTIME_IPC_SCHEMAS.threadCreate),
  threadRead: ajv.compile(AGENT_RUNTIME_IPC_SCHEMAS.threadRead),
  historyRead: ajv.compile(AGENT_RUNTIME_IPC_SCHEMAS.historyRead),
  turnStart: ajv.compile(AGENT_RUNTIME_IPC_SCHEMAS.turnStart),
  turnInterrupt: ajv.compile(AGENT_RUNTIME_IPC_SCHEMAS.turnInterrupt),
  subscribe: ajv.compile(AGENT_RUNTIME_IPC_SCHEMAS.subscribe),
  unsubscribe: ajv.compile(AGENT_RUNTIME_IPC_SCHEMAS.unsubscribe),
}

interface Subscription {
  sender: WebContents
  unsubscribe: () => void
}

const subscriptions = new Map<string, Subscription>()
const senderCleanupRegistered = new Set<number>()

function subscriptionKey(senderId: number, subscriptionId: string): string {
  return `${senderId}:${subscriptionId}`
}

function validate<T>(validator: ValidateFunction, value: unknown): T {
  if (validator(value)) return value as T
  const details = (validator.errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('; ')
  throw new Error(`Invalid Agent Runtime command: ${details}`)
}

function removeSubscription(senderId: number, subscriptionId: string): void {
  const key = subscriptionKey(senderId, subscriptionId)
  subscriptions.get(key)?.unsubscribe()
  subscriptions.delete(key)
}

function removeSenderSubscriptions(senderId: number): void {
  for (const [key, subscription] of subscriptions) {
    if (subscription.sender.id !== senderId) continue
    subscription.unsubscribe()
    subscriptions.delete(key)
  }
}

function registerSenderCleanup(sender: WebContents): void {
  if (senderCleanupRegistered.has(sender.id)) return
  senderCleanupRegistered.add(sender.id)
  sender.once('destroyed', () => {
    removeSenderSubscriptions(sender.id)
    senderCleanupRegistered.delete(sender.id)
  })
  sender.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) removeSenderSubscriptions(sender.id)
  })
}

export interface AgentRuntimeProviderResolver {
  resolve(modelId?: string, accountId?: string): BrightCodeAgentsModelBinding | undefined
}

let providerResolver: AgentRuntimeProviderResolver | null = null

export function configureAgentRuntimeProviderResolver(resolver: AgentRuntimeProviderResolver): void {
  providerResolver = resolver
}

export function registerAgentRuntimeIpc(): void {
  const runtime = getRuntime()

  ipcMain.handle(IPC.AGENT_RUNTIME_THREAD_CREATE, async (event, value) => {
    assertTrustedIpcSender(event)
    const command = validate<AgentRuntimeThreadCreateCommand>(validators.threadCreate, value)
    return runtime.createThread({ id: command.threadId })
  })

  ipcMain.handle(IPC.AGENT_RUNTIME_THREAD_READ, async (event, value) => {
    assertTrustedIpcSender(event)
    const command = validate<AgentRuntimeThreadReadCommand>(validators.threadRead, value)
    const opened = await runtime.openThread(command)
    return opened.state as ThreadState
  })

  ipcMain.handle(IPC.AGENT_RUNTIME_HISTORY_READ, async (event, value) => {
    assertTrustedIpcSender(event)
    const command = validate<AgentRuntimeHistoryReadCommand>(validators.historyRead, value)
    return runtime.readHistory(command.threadId, command.afterSequence)
  })

  ipcMain.handle(IPC.AGENT_RUNTIME_TURN_START, async (event, value) => {
    assertTrustedIpcSender(event)
    const command = validate<AgentRuntimeTurnStartCommand>(validators.turnStart, value)
    if (!isAgentRuntimeImagePayloadWithinLimit(command.images)) {
      throw new Error('Agent Runtime image payload is too large.')
    }
    const content = command.images?.length
      ? [
          { type: 'text' as const, text: command.text },
          ...command.images.map((image) => ({ type: 'image' as const, ...image })),
        ]
      : command.text
    const binding = providerResolver?.resolve(command.modelId, command.accountId)
    const provider = binding ? createAgentsRuntimeProvider(binding) : fakeRuntimeProvider
    const modelId = binding?.modelId ?? FAKE_RUNTIME_MODEL_ID
    const turnId = await runtime.startTurn({
      threadId: command.threadId,
      provider,
      modelId,
      credential: binding?.credential,
      userMessage: { role: 'user', content },
      startSequence: 0,
    })
    return { turnId }
  })

  ipcMain.handle(IPC.AGENT_RUNTIME_TURN_INTERRUPT, async (event, value) => {
    assertTrustedIpcSender(event)
    const command = validate<AgentRuntimeTurnInterruptCommand>(validators.turnInterrupt, value)
    await runtime.interruptTurn({ threadId: command.threadId, reason: 'user' })
  })

  ipcMain.handle(IPC.AGENT_RUNTIME_SUBSCRIBE, async (event, value) => {
    const sender = assertTrustedIpcSender(event)
    const command = validate<AgentRuntimeSubscribeCommand>(validators.subscribe, value)
    removeSubscription(sender.id, command.subscriptionId)
    registerSenderCleanup(sender)
    await runtime.openThread({ threadId: command.threadId })

    let replaying = true
    const pendingEvents: RuntimeEvent[] = []
    const unsubscribe = runtime.subscribe(command.threadId, (runtimeEvent) => {
      if (sender.isDestroyed()) return
      if (replaying) {
        pendingEvents.push(runtimeEvent)
        return
      }
      const state = runtime.getThreadState(command.threadId)
      if (!state) return
      sender.send(
        `${IPC.AGENT_RUNTIME_EVENT}:${command.subscriptionId}`,
        { event: runtimeEvent, state },
      )
    })
    subscriptions.set(subscriptionKey(sender.id, command.subscriptionId), {
      sender,
      unsubscribe,
    })

    try {
      const watermark = runtime.getThreadState(command.threadId)?.sequence ?? -1
      const persisted = await runtime.readHistory(command.threadId, command.afterSequence)
      const historyBySequence = new Map(
        persisted
          .filter((runtimeEvent) => runtimeEvent.sequence <= watermark)
          .map((runtimeEvent) => [runtimeEvent.sequence, runtimeEvent]),
      )
      for (const runtimeEvent of pendingEvents) {
        if (runtimeEvent.sequence > watermark) {
          historyBySequence.set(runtimeEvent.sequence, runtimeEvent)
        }
      }
      replaying = false
      return {
        state: runtime.getThreadState(command.threadId),
        history: [...historyBySequence.values()].sort((a, b) => a.sequence - b.sequence),
      }
    } catch (cause) {
      removeSubscription(sender.id, command.subscriptionId)
      throw cause
    }
  })

  ipcMain.handle(IPC.AGENT_RUNTIME_UNSUBSCRIBE, async (event, value) => {
    const sender = assertTrustedIpcSender(event)
    const command = validate<AgentRuntimeUnsubscribeCommand>(validators.unsubscribe, value)
    removeSubscription(sender.id, command.subscriptionId)
  })
}
