/**
 * Anthropic direct provider.
 *
 * Uses the `anthropic-messages` format handler — separate from the OpenAI
 * chat handler because the wire format, auth headers, and SSE event
 * structure all differ.
 */

import { createProvider } from '../factory'
import { anthropicModels } from '../models'
import type { IAgentProvider } from '../types'

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com'

export function createAnthropicProvider(): IAgentProvider {
  return createProvider({
    id: 'anthropic',
    name: 'Anthropic',
    baseURL: ANTHROPIC_BASE_URL,
    apiFormat: 'anthropic-messages',
    staticModels: anthropicModels,
  })
}
