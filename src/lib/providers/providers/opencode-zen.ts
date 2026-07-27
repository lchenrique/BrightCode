/**
 * OpenCode Zen — curated model gateway by OpenCode.
 * https://opencode.ai/docs/zen/
 *
 * - Free models (minimax-m2.5-free, big-pickle, etc.) require no API key
 * - Paid models (gpt-5.6-sol, gpt-5.6-terra, etc.) need an OpenCode API key
 * - Endpoint: https://opencode.ai/zen/v1/chat/completions
 * - Format: OpenAI-compatible chat completions
 */

import { createProvider } from '../factory'
import { opencodeZenModels } from '../models'
import type { IAgentProvider } from '../types'

export const OPENCODE_ZEN_BASE_URL = 'https://opencode.ai/zen/v1'

export function createOpenCodeZenProvider(): IAgentProvider {
  return createProvider({
    id: 'opencode-zen',
    name: 'OpenCode Zen',
    baseURL: OPENCODE_ZEN_BASE_URL,
    apiFormat: 'openai-chat',
    staticModels: opencodeZenModels,
    unauthenticatedHeaders: {
      Authorization: 'Bearer public',
    },
    // No modelPrefix — Zen doesn't use a namespace prefix on model ids.
  })
}
