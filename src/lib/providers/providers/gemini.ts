/**
 * Gemini Generative Language API (a.k.a. Google AI Studio / Gemini CLI).
 *
 * Endpoint: https://generativelanguage.googleapis.com/v1beta/models
 * Auth:     ?key=API_KEY query param, OR Authorization: Bearer ACCESS_TOKEN
 * Format:   gemini-native (see formats/gemini-native.ts)
 */

import { createProvider } from '../factory'
import { geminiModels } from '../models'
import type { IAgentProvider } from '../types'

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com'

export function createGeminiProvider(): IAgentProvider {
  return createProvider({
    id: 'gemini-cli',
    name: 'Gemini CLI',
    baseURL: GEMINI_BASE_URL,
    apiFormat: 'gemini-native',
    staticModels: geminiModels,
    defaultAuthMethod: 'api_key',
  })
}
