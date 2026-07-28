/**
 * Public surface of the provider layer.
 *
 * Import from `@/lib/providers` in UI code. Don't import from sub-paths
 * unless you're extending the layer with new format handlers or providers.
 */

export * from './types'
export { providerRegistry } from './registry'
export { createProvider } from './factory'
export { authStore } from './auth/store'
export { createOpenAIProvider } from './providers/openai'
export { createAnthropicProvider } from './providers/anthropic'
export { createOpenCodeZenProvider } from './providers/opencode-zen'
export { createOpenCodeGoProvider } from './providers/opencode-go'
export { createOpenCodeGoAnthropicProvider } from './providers/opencode-go-anthropic'
export { createGeminiProvider } from './providers/gemini'
export { createAntigravityProvider } from './providers/antigravity'
export { createMiniMaxProvider } from './providers/minimax'
export {
  openaiModels,
  anthropicModels,
  opencodeZenModels,
  opencodeGoModels,
  opencodeGoAnthropicModels,
  geminiModels,
  antigravityModels,
  minimaxModels,
} from './models'
export * from './usage'
