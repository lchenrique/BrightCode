/**
 * OpenCode Go (Anthropic subset).
 *
 * The OpenCode Go gateway serves two different wire formats at sibling paths:
 *   • /v1/chat/completions   — OpenAI-compatible (see ./opencode-go.ts)
 *   • /v1/messages           — Anthropic-compatible
 *
 * A handful of Go models (Qwen 3.7 Max/Plus, Qwen 3.6 Plus, MiniMax M3 /
 * M2.7 / M2.5) only work over the Anthropic path. Since BrightCode's
 * `IAgentProvider` is single-format, this provider is registered as a
 * separate id (`opencode-go-anthropic`) but resolves credentials from the
 * shared `opencode-go` bucket via `credentialProviderId`, so the user only
 * ever adds one API key.
 *
 * Pricing and model ids mirror the public docs at
 * https://opencode.ai/docs/go/ (last verified 2026-07-28).
 */

import { createProvider } from '../factory'
import { opencodeGoAnthropicModels } from '../models'
import type { IAgentProvider } from '../types'

// baseURL is intentionally WITHOUT the trailing /v1 — the Anthropic
// format handler appends '/v1/messages' itself, so we get
// https://opencode.ai/zen/go/v1/messages.
export const OPENCODE_GO_ANTHROPIC_BASE_URL = 'https://opencode.ai/zen/go'

export function createOpenCodeGoAnthropicProvider(): IAgentProvider {
  return createProvider({
    id: 'opencode-go-anthropic',
    // Share credentials with the OpenAI-chat Go provider — one API key
    // powers both wire-format subsets.
    credentialProviderId: 'opencode-go',
    name: 'OpenCode Go',
    baseURL: OPENCODE_GO_ANTHROPIC_BASE_URL,
    apiFormat: 'anthropic-messages',
    staticModels: opencodeGoAnthropicModels,
    modelPrefix: 'opencode-go/',
  })
}
