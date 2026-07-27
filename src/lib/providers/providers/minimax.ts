/**
 * MiniMax native API.
 * https://platform.minimax.io/docs/api-reference/text-chat-openai
 *
 * MiniMax exposes an OpenAI-compatible endpoint and bearer API keys.
 */

import { createProvider } from '../factory'
import { minimaxModels } from '../models'
import type { IAgentProvider } from '../types'

export const MINIMAX_BASE_URL = 'https://api.minimax.io/v1'

export function createMiniMaxProvider(): IAgentProvider {
  return createProvider({
    id: 'minimax',
    name: 'MiniMax',
    baseURL: MINIMAX_BASE_URL,
    apiFormat: 'openai-chat',
    staticModels: minimaxModels,
  })
}
