/**
 * Static model catalogs. The registry uses these as fallbacks when a
 * provider can't be queried dynamically (offline, before first auth, etc).
 *
 * Pricing in USD per 1M tokens. "free" = no per-token cost.
 */

import type { ModelInfo } from './types'

// MiniMax native OpenAI-compatible API (https://api.minimax.io/v1).
// The model ids intentionally match the upstream API exactly.
export const minimaxModels: ModelInfo[] = [
  {
    id: 'MiniMax-M2.7',
    displayName: 'MiniMax M2.7',
    provider: 'minimax',
    contextWindow: 204_800,
    supportsTools: true,
    supportsThinking: true,
    inputCost: 0.3,
    outputCost: 1.2,
  },
  {
    id: 'MiniMax-M2.7-highspeed',
    displayName: 'MiniMax M2.7 Highspeed',
    provider: 'minimax',
    contextWindow: 204_800,
    supportsTools: true,
    supportsThinking: true,
    inputCost: 0.3,
    outputCost: 1.2,
  },
  {
    id: 'MiniMax-M2.5',
    displayName: 'MiniMax M2.5',
    provider: 'minimax',
    contextWindow: 204_800,
    supportsTools: true,
    supportsThinking: true,
    inputCost: 0.3,
    outputCost: 1.2,
  },
  {
    id: 'MiniMax-M2.5-highspeed',
    displayName: 'MiniMax M2.5 Highspeed',
    provider: 'minimax',
    contextWindow: 204_800,
    supportsTools: true,
    supportsThinking: true,
    inputCost: 0.3,
    outputCost: 1.2,
  },
  {
    id: 'MiniMax-M2.1',
    displayName: 'MiniMax M2.1',
    provider: 'minimax',
    contextWindow: 204_800,
    supportsTools: true,
    supportsThinking: true,
    inputCost: 0.3,
    outputCost: 1.2,
  },
  {
    id: 'MiniMax-M3',
    displayName: 'MiniMax M3',
    provider: 'minimax',
    contextWindow: 200_000,
    supportsTools: true,
    supportsThinking: true,
    inputCost: 0.3,
    outputCost: 1.2,
  },
]

// ─── OpenAI ─────────────────────────────────────────────────────────────
// Native OpenAI API. Catalog cross-referenced with
// https://platform.openai.com/docs/models (last verified 2026-07-24).
// We only list the models we actually want to surface in the picker;
// the API is queried dynamically for the full list when a key is set.
export const openaiModels: ModelInfo[] = [
  {
    id: 'gpt-5.6-sol',
    displayName: 'GPT 5.6 Sol',
    provider: 'openai',
    contextWindow: 400_000,
    supportsTools: true,
    supportsThinking: true,
    supportsImages: true,
    inputCost: 1.25,
    outputCost: 10.0,
  },
  {
    id: 'gpt-5.6-terra',
    displayName: 'GPT 5.6 Terra',
    provider: 'openai',
    contextWindow: 400_000,
    supportsTools: true,
    supportsThinking: true,
    supportsImages: true,
    inputCost: 0.75,
    outputCost: 6.0,
  },
  {
    id: 'gpt-5.6-luna',
    displayName: 'GPT 5.6 Luna',
    provider: 'openai',
    contextWindow: 400_000,
    supportsTools: true,
    supportsThinking: true,
    supportsImages: true,
    inputCost: 0.25,
    outputCost: 2.0,
  },
]

// ─── Anthropic ─────────────────────────────────────────────────────────
export const anthropicModels: ModelInfo[] = [
  {
    id: 'claude-sonnet-4-5',
    displayName: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    contextWindow: 200_000,
    supportsTools: true,
    supportsThinking: true,
    supportsImages: true,
    inputCost: 3.0,
    outputCost: 15.0,
  },
  {
    id: 'claude-opus-4-7',
    displayName: 'Claude Opus 4.7',
    provider: 'anthropic',
    contextWindow: 200_000,
    supportsTools: true,
    supportsThinking: true,
    supportsImages: true,
    inputCost: 15.0,
    outputCost: 75.0,
  },
  {
    id: 'claude-haiku-4',
    displayName: 'Claude Haiku 4',
    provider: 'anthropic',
    contextWindow: 200_000,
    supportsTools: true,
    supportsImages: true,
    inputCost: 0.8,
    outputCost: 4.0,
  },
]

// ─── OpenCode Zen ──────────────────────────────────────────────────────
// Catalog cross-referenced with https://opencode.ai/docs/zen/ (last verified
// 2026-07-24). The free tier requires no API key; the paid tier needs an
// OpenCode Zen key (obtained via the CLI's `codex login`-style flow or at
// https://opencode.ai). Endpoint: https://opencode.ai/zen/v1/chat/completions.
// (The docs note /v1/responses for some models, but chat-completions is the
// common surface and is what the opencode-zen provider speaks.)
export const opencodeZenModels: ModelInfo[] = [
  // ── Free tier (no key required) ──
  {
    id: 'big-pickle',
    displayName: 'Big Pickle',
    provider: 'opencode-zen',
    contextWindow: 200_000,
    supportsTools: true,
    free: true,
    requiresAuth: false,
  },
  {
    id: 'deepseek-v4-flash-free',
    displayName: 'DeepSeek V4 Flash Free',
    provider: 'opencode-zen',
    contextWindow: 200_000,
    supportsTools: true,
    supportsThinking: true,
    thinkingLevels: ['high', 'max'],
    free: true,
    requiresAuth: false,
  },
  {
    id: 'mimo-v2.5-free',
    displayName: 'MiMo V2.5 Free',
    provider: 'opencode-zen',
    contextWindow: 200_000,
    supportsTools: true,
    free: true,
    requiresAuth: false,
  },
  {
    id: 'laguna-s-2.1-free',
    displayName: 'Laguna S 2.1 Free',
    provider: 'opencode-zen',
    contextWindow: 200_000,
    supportsTools: true,
    free: true,
    requiresAuth: false,
  },
  {
    id: 'ling-3.0-flash-free',
    displayName: 'Ling 3.0 Flash Free',
    provider: 'opencode-zen',
    contextWindow: 262_100,
    supportsTools: true,
    free: true,
    requiresAuth: false,
  },
  {
    id: 'north-mini-code-free',
    displayName: 'North Mini Code Free',
    provider: 'opencode-zen',
    contextWindow: 200_000,
    supportsTools: true,
    free: true,
    requiresAuth: false,
  },
  {
    id: 'nemotron-3-ultra-free',
    displayName: 'Nemotron 3 Ultra Free',
    provider: 'opencode-zen',
    contextWindow: 204_800,
    supportsTools: true,
    free: true,
    requiresAuth: false,
  },

  // ── Paid tier (key required) ──
  // GPT family
  { id: 'gpt-5.6-sol', displayName: 'GPT 5.6 Sol', provider: 'opencode-zen', contextWindow: 272_000, supportsTools: true, supportsThinking: true, inputCost: 5.0, outputCost: 30.0 },
  { id: 'gpt-5.6-terra', displayName: 'GPT 5.6 Terra', provider: 'opencode-zen', contextWindow: 272_000, supportsTools: true, supportsThinking: true, inputCost: 2.5, outputCost: 15.0 },
  { id: 'gpt-5.6-luna', displayName: 'GPT 5.6 Luna', provider: 'opencode-zen', contextWindow: 272_000, supportsTools: true, inputCost: 1.0, outputCost: 6.0 },

  // Claude family
  { id: 'claude-fable-5', displayName: 'Claude Fable 5', provider: 'opencode-zen', contextWindow: 200_000, supportsTools: true, inputCost: 10.0, outputCost: 50.0 },
  { id: 'claude-opus-5', displayName: 'Claude Opus 5', provider: 'opencode-zen', contextWindow: 200_000, supportsTools: true, inputCost: 5.0, outputCost: 25.0 },
  { id: 'claude-opus-4-8', displayName: 'Claude Opus 4.8', provider: 'opencode-zen', contextWindow: 200_000, supportsTools: true, inputCost: 5.0, outputCost: 25.0 },
  { id: 'claude-opus-4-7', displayName: 'Claude Opus 4.7', provider: 'opencode-zen', contextWindow: 200_000, supportsTools: true, supportsThinking: true, inputCost: 5.0, outputCost: 25.0 },
  { id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', provider: 'opencode-zen', contextWindow: 200_000, supportsTools: true, supportsThinking: true, inputCost: 5.0, outputCost: 25.0 },
  { id: 'claude-opus-4-5', displayName: 'Claude Opus 4.5', provider: 'opencode-zen', contextWindow: 200_000, supportsTools: true, inputCost: 5.0, outputCost: 25.0 },
  { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', provider: 'opencode-zen', contextWindow: 200_000, supportsTools: true, inputCost: 2.0, outputCost: 10.0 },
  { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', provider: 'opencode-zen', contextWindow: 200_000, supportsTools: true, inputCost: 3.0, outputCost: 15.0 },
  { id: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5', provider: 'opencode-zen', contextWindow: 200_000, supportsTools: true, supportsThinking: true, inputCost: 3.0, outputCost: 15.0 },
  { id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', provider: 'opencode-zen', contextWindow: 200_000, supportsTools: true, inputCost: 1.0, outputCost: 5.0 },

  // Gemini family
  { id: 'gemini-3-6-flash', displayName: 'Gemini 3.6 Flash', provider: 'opencode-zen', contextWindow: 1_000_000, supportsTools: true, inputCost: 1.5, outputCost: 7.5 },
  { id: 'gemini-3-5-flash', displayName: 'Gemini 3.5 Flash', provider: 'opencode-zen', contextWindow: 1_000_000, supportsTools: true, inputCost: 1.5, outputCost: 9.0 },
  { id: 'gemini-3-5-flash-lite', displayName: 'Gemini 3.5 Flash Lite', provider: 'opencode-zen', contextWindow: 1_000_000, supportsTools: true, inputCost: 0.3, outputCost: 2.5 },
  { id: 'gemini-3-1-pro', displayName: 'Gemini 3.1 Pro', provider: 'opencode-zen', contextWindow: 1_000_000, supportsTools: true, supportsThinking: true, inputCost: 2.0, outputCost: 12.0 },
  { id: 'gemini-3-flash', displayName: 'Gemini 3 Flash', provider: 'opencode-zen', contextWindow: 1_000_000, supportsTools: true, inputCost: 0.5, outputCost: 3.0 },

  // Grok family
  { id: 'grok-4-5', displayName: 'Grok 4.5', provider: 'opencode-zen', contextWindow: 200_000, supportsTools: true, inputCost: 2.0, outputCost: 6.0 },
  { id: 'grok-build-0-1', displayName: 'Grok Build 0.1', provider: 'opencode-zen', contextWindow: 200_000, supportsTools: true, inputCost: 1.0, outputCost: 2.0 },

  // Qwen family
  { id: 'qwen3-7-max', displayName: 'Qwen3.7 Max', provider: 'opencode-zen', contextWindow: 200_000, supportsTools: true, inputCost: 2.5, outputCost: 7.5 },
  { id: 'qwen3-7-plus', displayName: 'Qwen3.7 Plus', provider: 'opencode-zen', contextWindow: 200_000, supportsTools: true, inputCost: 0.4, outputCost: 1.6 },
  { id: 'qwen3-6-plus', displayName: 'Qwen3.6 Plus', provider: 'opencode-zen', contextWindow: 200_000, supportsTools: true, inputCost: 0.5, outputCost: 3.0 },
  { id: 'qwen3-5-plus', displayName: 'Qwen3.5 Plus', provider: 'opencode-zen', contextWindow: 200_000, supportsTools: true, inputCost: 0.2, outputCost: 1.2 },

  // DeepSeek family
  { id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', provider: 'opencode-zen', contextWindow: 1_000_000, supportsTools: true, supportsThinking: true, thinkingLevels: ['high', 'max'], inputCost: 1.74, outputCost: 3.48 },
  { id: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', provider: 'opencode-zen', contextWindow: 1_000_000, supportsTools: true, supportsThinking: true, thinkingLevels: ['high', 'max'], inputCost: 0.14, outputCost: 0.28 },

  // MiniMax family
  { id: 'minimax-m3', displayName: 'MiniMax M3', provider: 'opencode-zen', contextWindow: 200_000, supportsTools: true, inputCost: 0.3, outputCost: 1.2 },
  { id: 'minimax-m2-7', displayName: 'MiniMax M2.7', provider: 'opencode-zen', contextWindow: 200_000, supportsTools: true, inputCost: 0.3, outputCost: 1.2 },

  // GLM family
  { id: 'glm-5-2', displayName: 'GLM 5.2', provider: 'opencode-zen', contextWindow: 200_000, supportsTools: true, inputCost: 1.4, outputCost: 4.4 },
  { id: 'glm-5-1', displayName: 'GLM 5.1', provider: 'opencode-zen', contextWindow: 200_000, supportsTools: true, inputCost: 1.4, outputCost: 4.4 },

  // Kimi family
  { id: 'kimi-k2-7-code', displayName: 'Kimi K2.7 Code', provider: 'opencode-zen', contextWindow: 200_000, supportsTools: true, inputCost: 0.95, outputCost: 4.0 },
  { id: 'kimi-k2-6', displayName: 'Kimi K2.6', provider: 'opencode-zen', contextWindow: 200_000, supportsTools: true, inputCost: 0.95, outputCost: 4.0 },
]

// ─── OpenCode Go ────────────────────────────────────────────────────────
// https://opencode.ai/docs/go/
// $5 first month, $10/month after. Two wire formats are served by the same
// gateway (different sub-paths):
//   • https://opencode.ai/zen/go/v1/chat/completions   — OpenAI-compatible
//   • https://opencode.ai/zen/go/v1/messages           — Anthropic-compatible
//
// Because BrightCode's IAgentProvider is single-format, we register two
// providers (opencode-go and opencode-go-anthropic). They share one
// credential via `credentialProviderId: 'opencode-go'`, so a single API
// key in Settings powers both.
//
// `OPENCODE_GO_FORMAT_BY_ID` is the single source of truth for which wire
// format each model id uses — it was cross-referenced with the public
// docs (https://opencode.ai/docs/go/) and the live `/v1/models` endpoint
// (last verified 2026-07-28).
export const OPENCODE_GO_FORMAT_BY_ID: Record<string, 'openai-chat' | 'anthropic-messages'> = {
  // ── OpenAI chat (/v1/chat/completions) ──
  'grok-4.5': 'openai-chat',
  'glm-5.2': 'openai-chat',
  'glm-5.1': 'openai-chat',
  'glm-5': 'openai-chat',
  'kimi-k3': 'openai-chat',
  'kimi-k2.7-code': 'openai-chat',
  'kimi-k2.6': 'openai-chat',
  'kimi-k2.5': 'openai-chat',
  'deepseek-v4-pro': 'openai-chat',
  'deepseek-v4-flash': 'openai-chat',
  'mimo-v2.5': 'openai-chat',
  'mimo-v2.5-pro': 'openai-chat',
  'mimo-v2-pro': 'openai-chat',
  'mimo-v2-omni': 'openai-chat',
  'hy3': 'openai-chat',
  'hy3-preview': 'openai-chat',

  // ── Anthropic messages (/v1/messages) ──
  'minimax-m3': 'anthropic-messages',
  'minimax-m2.7': 'anthropic-messages',
  'minimax-m2.5': 'anthropic-messages',
  'qwen3.7-max': 'anthropic-messages',
  'qwen3.7-plus': 'anthropic-messages',
  'qwen3.6-plus': 'anthropic-messages',
  'qwen3.5-plus': 'anthropic-messages',
}

// Master catalog. Each entry is rendered into the appropriate provider
// group based on `OPENCODE_GO_FORMAT_BY_ID`. Pricing is from the public
// docs (USD per 1M tokens). When a model is missing from this list but
// the gateway advertises it via `/v1/models`, the dynamic fetch in
// `useOpenCodeGoModels` will pick it up with best-effort defaults.
export const opencodeGoModels: ModelInfo[] = [
  // Z.ai
  { id: 'glm-5.2', displayName: 'GLM 5.2', provider: 'opencode-go', supportsTools: true, inputCost: 1.4, outputCost: 4.4 },
  { id: 'glm-5.1', displayName: 'GLM 5.1', provider: 'opencode-go', supportsTools: true, inputCost: 1.4, outputCost: 4.4 },
  { id: 'glm-5', displayName: 'GLM 5', provider: 'opencode-go', supportsTools: true, inputCost: 1.0, outputCost: 3.2 },
  // Moonshot
  { id: 'kimi-k3', displayName: 'Kimi K3', provider: 'opencode-go', contextWindow: 1_048_576, supportsTools: true, inputCost: 3.0, outputCost: 15.0 },
  { id: 'kimi-k2.7-code', displayName: 'Kimi K2.7 Code', provider: 'opencode-go', contextWindow: 262_144, supportsTools: true, inputCost: 0.95, outputCost: 4.0 },
  { id: 'kimi-k2.6', displayName: 'Kimi K2.6', provider: 'opencode-go', contextWindow: 262_144, supportsTools: true, inputCost: 0.95, outputCost: 4.0 },
  { id: 'kimi-k2.5', displayName: 'Kimi K2.5', provider: 'opencode-go', contextWindow: 262_144, supportsTools: true, inputCost: 0.6, outputCost: 3.0 },
  // Xiaomi MiMo
  { id: 'mimo-v2.5-pro', displayName: 'MiMo V2.5 Pro', provider: 'opencode-go', supportsTools: true, inputCost: 0.435, outputCost: 0.87 },
  { id: 'mimo-v2.5', displayName: 'MiMo V2.5', provider: 'opencode-go', supportsTools: true, inputCost: 0.14, outputCost: 0.28 },
  { id: 'mimo-v2-omni', displayName: 'MiMo V2 Omni', provider: 'opencode-go', supportsTools: true, inputCost: 0.4, outputCost: 2.0 },
  { id: 'mimo-v2-pro', displayName: 'MiMo V2 Pro', provider: 'opencode-go', contextWindow: 1_048_576, supportsTools: true, inputCost: 1.0, outputCost: 3.0 },
  // DeepSeek
  { id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', provider: 'opencode-go', contextWindow: 1_000_000, supportsTools: true, supportsThinking: true, thinkingLevels: ['high', 'max'], inputCost: 0.435, outputCost: 0.87 },
  { id: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', provider: 'opencode-go', contextWindow: 1_000_000, supportsTools: true, supportsThinking: true, thinkingLevels: ['high', 'max'], inputCost: 0.14, outputCost: 0.28 },
  // xAI
  { id: 'grok-4.5', displayName: 'Grok 4.5', provider: 'opencode-go', contextWindow: 500_000, supportsTools: true, inputCost: 2.0, outputCost: 6.0 },
  // Hy3
  { id: 'hy3', displayName: 'Hy3', provider: 'opencode-go', supportsTools: true, inputCost: 0.14, outputCost: 0.58 },
  { id: 'hy3-preview', displayName: 'Hy3 Preview', provider: 'opencode-go', supportsTools: true, inputCost: 0.14, outputCost: 0.58 },
  // Alibaba Qwen (Anthropic-messages path)
  { id: 'qwen3.7-max', displayName: 'Qwen 3.7 Max', provider: 'opencode-go', supportsTools: true, inputCost: 2.5, outputCost: 7.5 },
  { id: 'qwen3.7-plus', displayName: 'Qwen 3.7 Plus', provider: 'opencode-go', supportsTools: true, inputCost: 0.4, outputCost: 1.6 },
  { id: 'qwen3.6-plus', displayName: 'Qwen 3.6 Plus', provider: 'opencode-go', supportsTools: true, inputCost: 0.5, outputCost: 3.0 },
  { id: 'qwen3.5-plus', displayName: 'Qwen 3.5 Plus', provider: 'opencode-go', supportsTools: true, inputCost: 0.2, outputCost: 1.2 },
  // MiniMax (Anthropic-messages path)
  { id: 'minimax-m3', displayName: 'MiniMax M3', provider: 'opencode-go', contextWindow: 200_000, supportsTools: true, inputCost: 0.3, outputCost: 1.2 },
  { id: 'minimax-m2.7', displayName: 'MiniMax M2.7', provider: 'opencode-go', contextWindow: 200_000, supportsTools: true, inputCost: 0.3, outputCost: 1.2 },
  { id: 'minimax-m2.5', displayName: 'MiniMax M2.5', provider: 'opencode-go', contextWindow: 200_000, supportsTools: true, inputCost: 0.3, outputCost: 1.2 },
]

// ─── OpenCode Go (Anthropic subset) ────────────────────────────────────
// Same gateway, but the request shape is Anthropic's /v1/messages — the
// upstream mandates it for these model ids. The provider id is
// 'opencode-go-anthropic' so the registry can route by model, but the
// stored credential lives under 'opencode-go' so both subsets share a
// single API key in Settings.
export const opencodeGoAnthropicModels: ModelInfo[] = opencodeGoModels.filter(
  (m) => OPENCODE_GO_FORMAT_BY_ID[m.id] === 'anthropic-messages',
)

// ── Gemini Generative Language API ──────────────────────────────────────
//
// Catalog of the most common Gemini models. Google AI Studio is the source
// of truth (https://ai.google.dev/gemini-api/docs/models) so this list may
// lag a quarter behind. We only list what the user can actually call.
export const geminiModels: ModelInfo[] = [
  {
    id: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    provider: 'gemini-cli',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsThinking: true,
    supportsImages: true,
    inputCost: 1.25,
    outputCost: 10.0,
  },
  {
    id: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    provider: 'gemini-cli',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsImages: true,
    inputCost: 0.075,
    outputCost: 0.3,
  },
  {
    id: 'gemini-2.5-flash-lite',
    displayName: 'Gemini 2.5 Flash Lite',
    provider: 'gemini-cli',
    contextWindow: 1_000_000,
    supportsTools: true,
    inputCost: 0.025,
    outputCost: 0.1,
  },
  {
    id: 'gemini-2.0-flash',
    displayName: 'Gemini 2.0 Flash',
    provider: 'gemini-cli',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsImages: true,
    inputCost: 0.1,
    outputCost: 0.4,
  },
]

// ── Antigravity (Google Cloud Code) ─────────────────────────────────────
//
// Antigravity is a newer Google CLI that exposes Gemini + Claude + a few
// open models through the same Code Assist surface. All requests go
// through `cloudcode-pa.googleapis.com/v1internal`. Model catalog
// cross-referenced with the 9Router docs (decolua/9router).
export const antigravityModels: ModelInfo[] = [
  {
    id: 'gemini-3-pro-high',
    displayName: 'Gemini 3 Pro High',
    provider: 'antigravity',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsThinking: true,
    supportsImages: true,
  },
  {
    id: 'gemini-3-flash-preview',
    displayName: 'Gemini 3 Flash (preview)',
    provider: 'antigravity',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsImages: true,
  },
  {
    id: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro (Cloud Code)',
    provider: 'antigravity',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsThinking: true,
    supportsImages: true,
  },
  {
    id: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6 (via Cloud Code)',
    provider: 'antigravity',
    contextWindow: 200_000,
    supportsTools: true,
    supportsImages: true,
  },
  {
    id: 'claude-opus-4-6-thinking',
    displayName: 'Claude Opus 4.6 Thinking (via Cloud Code)',
    provider: 'antigravity',
    contextWindow: 200_000,
    supportsTools: true,
    supportsThinking: true,
  },
  {
    id: 'gpt-oss-120b',
    displayName: 'GPT-OSS 120B (via Cloud Code)',
    provider: 'antigravity',
    contextWindow: 128_000,
    supportsTools: true,
  },
]
