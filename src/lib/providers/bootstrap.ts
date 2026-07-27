/**
 * One-shot bootstrap that wires the registered providers into the registry.
 * Call once from the app entrypoint.
 *
 * The list is intentionally explicit — providers must opt in, not be
 * auto-discovered, so the user always knows what's wired up. Add new
 * providers here as we ship them (Phase 2+ in the plan).
 */

import {
  createAnthropicProvider,
  createAntigravityProvider,
  createGeminiProvider,
  createOpenAIProvider,
  createOpenCodeGoProvider,
  createOpenCodeZenProvider,
  createMiniMaxProvider,
  providerRegistry,
} from '.'

export function bootstrapProviders(): void {
  providerRegistry.registerAll([
    createOpenAIProvider(),
    createAnthropicProvider(),
    createGeminiProvider(),
    createAntigravityProvider(),
    createOpenCodeZenProvider(),
    createOpenCodeGoProvider(),
    createMiniMaxProvider(),
  ])
}
