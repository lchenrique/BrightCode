/**
 * OpenCode Go — OpenAI-chat subset.
 * https://opencode.ai/docs/go/
 *
 * - $5 first month, $10/month after
 * - Endpoint: https://opencode.ai/zen/go/v1/chat/completions
 * - Format: OpenAI-compatible chat completions
 * - Model ids are namespaced with `opencode-go/` prefix (e.g.
 *   `opencode-go/kimi-k2.6`) — the factory adds this automatically via
 *   `modelPrefix` when the caller doesn't include a slash.
 *
 * A handful of Go models (Qwen 3.7 Max/Plus, Qwen 3.6 Plus, Qwen 3.5
 * Plus, MiniMax M3/M2.7/M2.5) only work over the Anthropic /v1/messages
 * path; they live in a separate `opencode-go-anthropic` provider that
 * shares the same API key through `credentialProviderId`. The split is
 * driven by `OPENCODE_GO_FORMAT_BY_ID` in `../models`.
 */

import { createProvider } from '../factory'
import { OPENCODE_GO_FORMAT_BY_ID, opencodeGoModels } from '../models'
import type { IAgentProvider } from '../types'

export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1'

export function createOpenCodeGoProvider(): IAgentProvider {
  return createProvider({
    id: 'opencode-go',
    name: 'OpenCode Go',
    baseURL: OPENCODE_GO_BASE_URL,
    apiFormat: 'openai-chat',
    staticModels: opencodeGoModels.filter(
      (m) => OPENCODE_GO_FORMAT_BY_ID[m.id] === 'openai-chat',
    ),
    modelPrefix: 'opencode-go/',
  })
}
