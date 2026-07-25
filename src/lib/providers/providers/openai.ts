/**
 * OpenAI direct provider.
 *
 * Reuses the shared `openai-chat` format handler — only the base URL and
 * static model catalog differ from any other OpenAI-compatible provider.
 */

import { createProvider } from '../factory'
import { openaiModels } from '../models'
import type { IAgentProvider } from '../types'

export const OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const CODEX_BACKEND_URL = 'https://chatgpt.com/backend-api/codex/responses'

export function createOpenAIProvider(): IAgentProvider {
  const base = createProvider({
    id: 'openai',
    name: 'OpenAI',
    baseURL: OPENAI_BASE_URL,
    apiFormat: 'openai-chat',
    staticModels: openaiModels,
  })

  return {
    ...base,
    async *stream(params, credential) {
      const isCodexToken =
        credential?.method === 'cli_detected' ||
        credential?.method === 'oauth' ||
        (credential?.accessToken && !credential.apiKey?.startsWith('sk-'))

      const baseURL = isCodexToken ? CODEX_BACKEND_URL : OPENAI_BASE_URL

      const inner = createProvider({
        id: 'openai',
        name: 'OpenAI',
        baseURL,
        apiFormat: 'openai-chat',
        staticModels: openaiModels,
      })

      yield* inner.stream(params, credential)
    },
  }
}
