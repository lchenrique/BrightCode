/**
 * OpenCode Go — low-cost subscription plan by OpenCode.
 * https://opencode.ai/docs/go/
 *
 * - $5 first month, $10/month after
 * - Endpoint: https://opencode.ai/zen/go/v1/chat/completions
 * - Format: OpenAI-compatible chat completions for most models
 * - Model ids are namespaced with `opencode-go/` prefix (e.g.
 *   `opencode-go/kimi-k2.6`) — the factory adds this automatically via
 *   `modelPrefix` when the caller doesn't include a slash.
 *
 * Some Go models (DeepSeek V4 Pro/Flash, MiniMax M2.5/M2.7, MiniMax M3)
 * use the Anthropic /v1/messages format instead — those aren't in this
 * catalog yet. They'll be added as a second provider registered under the
 * same credential once we add the per-model format router.
 */

import { createProvider } from '../factory'
import { opencodeGoModels } from '../models'
import type { IAgentProvider } from '../types'

export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1'

export function createOpenCodeGoProvider(): IAgentProvider {
  return createProvider({
    id: 'opencode-go',
    name: 'OpenCode Go',
    baseURL: OPENCODE_GO_BASE_URL,
    apiFormat: 'openai-chat',
    staticModels: opencodeGoModels,
    modelPrefix: 'opencode-go/',
  })
}
