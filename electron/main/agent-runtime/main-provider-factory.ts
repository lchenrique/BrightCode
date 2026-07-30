import type {
  ApiFormat,
  IAgentProvider,
  ModelInfo,
  ProviderCredential,
  StreamChunk,
  StreamParams,
} from '../../shared/providers/types'
import { anthropicMessagesHandler } from '../../../src/lib/providers/formats/anthropic-messages'
import { geminiNativeHandler } from '../../../src/lib/providers/formats/gemini-native'
import { openaiChatHandler, classifyHttpError } from '../../../src/lib/providers/formats/openai-chat'
import { parseSSE } from '../../../src/lib/providers/formats/sse-parser'
import type { FormatHandler } from '../../../src/lib/providers/types'

const handlers: Partial<Record<ApiFormat, FormatHandler>> = {
  'openai-chat': openaiChatHandler,
  'openai-responses': openaiChatHandler,
  'anthropic-messages': anthropicMessagesHandler,
  'gemini-native': geminiNativeHandler,
}

export interface MainProviderConfig {
  id: string
  name: string
  baseURL: string
  apiFormat: ApiFormat
  staticModels: ModelInfo[]
  credentialProviderId?: string
  modelPrefix?: string
  unauthenticatedHeaders?: Record<string, string>
}

export function createMainProvider(config: MainProviderConfig): IAgentProvider {
  const handler = handlers[config.apiFormat]
  if (!handler) throw new Error(`No main-process handler for ${config.apiFormat}.`)
  return {
    id: config.id,
    credentialProviderId: config.credentialProviderId ?? config.id,
    name: config.name,
    baseURL: config.baseURL,
    authMethod: 'api_key',
    apiFormat: config.apiFormat,
    listModels: () => config.staticModels,
    async *stream(params: StreamParams, credential?: ProviderCredential): AsyncIterable<StreamChunk> {
      const effectiveParams = config.modelPrefix && !params.model.includes('/')
        ? { ...params, model: `${config.modelPrefix}${params.model}` }
        : params
      const request = handler.buildRequest(effectiveParams, credential, config.baseURL)
      const headers = new Headers(request.init.headers as Record<string, string> | undefined)
      if (!credential) {
        for (const [key, value] of Object.entries(config.unauthenticatedHeaders ?? {})) headers.set(key, value)
      }
      const response = await fetch(request.url, { ...request.init, headers, signal: params.signal })
      if (!response.ok) throw classifyHttpError(response.status, config.id)
      if (!response.body) throw new Error(`${config.id}: empty streaming response.`)
      const context = handler.createContext()
      for await (const event of parseSSE(response.body, params.signal)) {
        const chunks = context.processEvent(event)
        for (const chunk of Array.isArray(chunks) ? chunks : chunks ? [chunks] : []) yield chunk
      }
      const tail = context.finalize()
      for (const chunk of Array.isArray(tail) ? tail : tail ? [tail] : []) yield chunk
      yield context.emitMessageEnd()
    },
    async validateCredential(): Promise<boolean> {
      return true
    },
  }
}
