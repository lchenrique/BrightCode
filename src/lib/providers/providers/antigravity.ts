/**
 * Antigravity — Google Cloud Code (newer Antigravity CLI).
 *
 * Endpoint: https://cloudcode-pa.googleapis.com/v1internal
 * Auth:     Authorization: Bearer ACCESS_TOKEN (OAuth, not API key)
 * Format:   gemini-native (the wire format is the same as Generative
 *           Language; only the URL and auth differ)
 *
 * The Cloud Code backend serves Gemini, Claude, and open-source models
 * to authenticated Antigravity CLI users. See the 9Router docs for
 * which model ids are actually accepted by this endpoint.
 */

import { createProvider } from '../factory'
import { antigravityModels } from '../models'
import type { IAgentProvider } from '../types'

export const ANTIGRAVITY_BASE_URL = 'https://cloudcode-pa.googleapis.com'

export function createAntigravityProvider(): IAgentProvider {
  return createProvider({
    id: 'antigravity',
    name: 'Antigravity',
    baseURL: ANTIGRAVITY_BASE_URL,
    apiFormat: 'gemini-native',
    staticModels: antigravityModels,
    defaultAuthMethod: 'cli_detected',
  })
}
