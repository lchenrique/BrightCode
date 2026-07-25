# BrightCode — Fase 2: Provider Abstraction

> **Status:** Em planejamento (2026-07-24)
> **Owner:** Carlos Henrique
> **UI atual:** entregue por Kimi K3 (modelo paralelo) — base mantida do que Mavis montou em `D:/projetos pessoais/BrightCode/`
> **Inspiração arquitetural:** `D:/agent-teams/orkas-fork` (pattern `createPiProvider` + `ProviderRegistry`)

---

## 1. Visão

BrightCode é um clone open-source do MiniMax Code cujo diferencial é **multi-provider transparente**. O usuário escolhe qual LLM provider usar por chat, e a aplicação conversa com qualquer um deles sem lock-in num motor específico (sem ficar preso ao OpenCode SDK, por exemplo).

Três modalidades de autenticação suportadas:

1. **API key estática** — colada manualmente no Settings (ou já salva em env var)
2. **OAuth direto do app** — PKCE/device code via browser, quando o provider suporta
3. **Detecção de CLI local** — se o usuário já está logado em Codex CLI, `gcloud`, ou Antigravity CLI, reaproveita a credencial sem pedir login novo

---

## 2. Catálogo de providers

| Provider | Base URL | Auth padrão | Models principais |
|---|---|---|---|
| **OpenAI** | `https://api.openai.com/v1` | API key ou OAuth (Codex) | `gpt-5`, `gpt-4o`, `o3`, `o1` |
| **Codex CLI** | `https://api.openai.com/v1` | CLI detection | Mesmos da OpenAI |
| **Anthropic** | `https://api.anthropic.com` | API key (`x-api-key` header) | `claude-sonnet-4-5`, `claude-opus-4-7`, `claude-haiku-4` |
| **Google Gemini** | `https://generativelanguage.googleapis.com` | API key ou gcloud ADC | `gemini-2.5-pro`, `gemini-2.5-flash` |
| **Antigravity CLI** (Google) | `https://cloudcode-pa.googleapis.com` | CLI keyring | `gemini-3-pro-high`, `claude-sonnet-4-6`, `claude-opus-4-6`, `gpt-oss-120b` |
| **OpenCode Zen** | `https://opencode.ai/zen/v1/responses` | Free (sem key) ou API key (paid) | Free: `minimax-m2.5-free`, `big-pickle`, `mimo-v2-pro-free`. Paid: `gpt-5.5`, `gpt-5.3-codex` |
| **OpenCode Go** | `https://opencode.ai/zen/go/v1/{chat/completions\|messages}` | API key (subscription $5→$10/mês) | `glm-5.2`, `kimi-k2.7-code`, `deepseek-v4-pro`, `minimax-m3` (Anthropic-style) |
| **PayPerQ (PQ)** | `https://api.ppq.ai` | API key (`sk-...`) | Gateway OpenAI-compatible, 500+ models |
| **MiniMax** | `https://api.minimax.io/anthropic` | API key | `minimax-m3`, `minimax-m2.7` |

---

## 3. Três modalidades de auth

### 3.1. API key estática
Provider guarda no nosso auth store, manda como `Authorization: Bearer <key>` ou `x-api-key: <key>`.

### 3.2. OAuth direto do app
PKCE flow ou device code, dependendo do provider. A lib `oauth4webapi` ou `openid-client` no Node/Web. Server-side state storage em `localStorage` (web) ou `electron-store` (depois).

### 3.3. Detecção de CLI

```ts
// src/lib/auth/cli-detector.ts
interface CLICredential {
  provider: 'openai' | 'google' | 'antigravity'
  token: string
  refreshToken?: string
  expiresAt?: number
  email?: string
  source: 'codex-auth.json' | 'codex-keyring' | 'gcloud-adc' | 'antigravity-keyring'
}

async function detectCodexAuth(): Promise<CLICredential | null>
async function detectGcloudAuth(): Promise<CLICredential | null>
async function detectAntigravityAuth(): Promise<CLICredential | null>
async function detectAllCLIs(): Promise<CLICredential[]>
```

**Locais de leitura por CLI:**

| CLI | Local | Como ler | Plataforma |
|---|---|---|---|
| **Codex** | `%USERPROFILE%\.codex\auth.json` ou `~/.codex/auth.json` (override `CODEX_HOME`) | Lê JSON, extrai `OPENAI_API_KEY` ou `tokens.access_token` + `refresh_token` | Cross-platform |
| **Codex (keyring mode)** | OS Credential Manager | Service: "Codex Auth" no macOS / genérico no Windows / Secret Service no Linux. Usa `keytar` | Cross-platform |
| **gcloud** | `~/.config/gcloud/application_default_credentials.json` (Linux) / `%APPDATA%\gcloud\...` (Windows) | JSON com `client_id` + `refresh_token`. Refresh via OAuth2 flow direto | Cross-platform |
| **Antigravity** | OS Keyring (não arquivo) | `keytar` lê o token; se não achar, prompt pra rodar `agy login` | Cross-platform |

**Fluxo no app:**

1. Usuário adiciona provider no Settings → "Codex (OpenAI)"
2. Settings abre modal → "Checking CLI..." (spinner ~500ms)
3. Detector varre: codex auth.json → codex keyring → gcloud (se for Google)
4. Se achou: mostra "✅ Logado como user@email.com via Codex CLI" + botão "Usar essa conta"
5. Se não achou: oferece OAuth direto do app OU "Cole sua API key"

---

## 4. Arquitetura

### 4.1. Tipos centrais

```ts
// src/lib/providers/types.ts

export type AuthMethod = 'api_key' | 'oauth' | 'cli_detected'
export type ApiFormat = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-native' | 'custom'

export interface ProviderCredential {
  method: AuthMethod
  // API key
  apiKey?: string
  // OAuth
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  // CLI detection
  cliSource?: 'codex-auth.json' | 'codex-keyring' | 'gcloud-adc' | 'antigravity-keyring'
  cliEmail?: string
}

export interface ModelInfo {
  id: string                          // 'gpt-5', 'claude-sonnet-4-5'
  displayName: string                 // 'GPT 5'
  provider: string                    // 'openai'
  contextWindow?: number
  supportsTools?: boolean
  supportsThinking?: boolean
  supportsImages?: boolean
  inputCost?: number                  // USD per 1M tokens
  outputCost?: number
  free?: boolean
}

export type StreamChunk =
  | { type: 'message_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; id: string; input: unknown }
  | { type: 'tool_use_end'; id: string }
  | { type: 'message_end'; stopReason: string; usage?: { input: number; output: number }; model: string }
  | { type: 'error'; error: Error }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentBlock[]
  // For tool messages
  toolCallId?: string
  toolName?: string
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mediaType: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  | { type: 'thinking'; text: string; signature?: string }

export interface StreamParams {
  model: string                       // 'gpt-5' ou 'openai/gpt-5'
  messages: ChatMessage[]
  systemPrompt?: string
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high'
  sessionId?: string                  // pra cache key
}

export interface IAgentProvider {
  id: string                          // 'openai'
  name: string                        // 'OpenAI'
  baseURL: string
  authMethod: AuthMethod
  apiFormat: ApiFormat
  listModels(): Promise<ModelInfo[]>   // dinâmico quando possível
  stream(params: StreamParams, credential: ProviderCredential): AsyncIterable<StreamChunk>
  validateCredential(credential: ProviderCredential): Promise<boolean>
}
```

### 4.2. Registry + Factory

```ts
// src/lib/providers/registry.ts
export class ProviderRegistry {
  private providers = new Map<string, IAgentProvider>()
  private credentials = new Map<string, ProviderCredential>()

  register(provider: IAgentProvider): void

  get(id: string): IAgentProvider | undefined
  list(): IAgentProvider[]

  setCredential(providerId: string, credential: ProviderCredential): void
  getCredential(providerId: string): ProviderCredential | undefined

  /** Resolve model id (com ou sem prefixo provider/) para {provider, modelId} */
  resolveForModel(modelId: string): { provider: IAgentProvider; model: string } | undefined

  /** Lista todos os models de todos os providers habilitados */
  async listAllModels(): Promise<ModelInfo[]>
}

// Singleton
export const providerRegistry = new ProviderRegistry()
```

```ts
// src/lib/providers/factory.ts

export function createProvider(config: {
  id: string
  name: string
  baseURL: string
  apiFormat: ApiFormat
  authMethod?: AuthMethod
  // Hooks opcionais pra customizar requests/responses
  requestTransform?: (body: unknown) => unknown
  responseTransform?: (chunk: unknown) => StreamChunk | null
  staticHeaders?: Record<string, string>
  modelPrefix?: string                // ex: 'opencode-go/' — adicionado automaticamente
}): IAgentProvider
```

A `createProvider` é a peça central — uma factory genérica que, dado um formato de API (openai-chat, openai-responses, anthropic-messages, gemini-native), sabe como serializar a request e desserializar o stream. Providers específicos podem passar `requestTransform`/`responseTransform` para customizar.

---

## 5. File structure

```
src/lib/providers/
├── types.ts                          # IAgentProvider, ModelInfo, StreamChunk, ChatMessage, etc
├── registry.ts                       # ProviderRegistry singleton
├── factory.ts                        # createProvider() genérica
├── formats/
│   ├── openai-chat.ts                # adapter /v1/chat/completions (streaming SSE)
│   ├── openai-responses.ts           # adapter /v1/responses (OpenAI Responses API)
│   ├── anthropic-messages.ts         # adapter /v1/messages (Anthropic streaming)
│   └── gemini-native.ts              # adapter :streamGenerateContent
├── providers/
│   ├── openai.ts                     # createOpenAIProvider
│   ├── anthropic.ts                  # createAnthropicProvider
│   ├── opencode-zen.ts               # createOpenCodeZenProvider (free + paid)
│   ├── opencode-go.ts                # createOpenCodeGoProvider
│   ├── antigravity.ts                # createAntigravityProvider (Google Cloud Code)
│   ├── payperq.ts                    # createPayPerQProvider
│   ├── minimax.ts                    # createMiniMaxProvider
│   └── gemini.ts                     # createGeminiProvider (gcloud ADC + API key)
├── auth/
│   ├── store.ts                      # AuthStore (persiste credenciais)
│   ├── cli-detector.ts               # detectAllCLIs() orquestrador
│   ├── codex.ts                      # lê ~/.codex/auth.json + keyring
│   ├── gcloud.ts                     # lê gcloud ADC + refresh
│   ├── antigravity.ts                # lê keyring
│   └── oauth-flow.ts                 # PKCE + device code genérico
└── models.ts                         # ModelInfo estático (fallback quando dinâmico falha)
```

---

## 6. Plano de execução por fases

### Fase 0 — Confirmações com Carlos (pendente)
- [ ] **"ALF"** que você mencionou — protocolo específico (tipo OIDC-A) ou foi typo de "OAuth"?
- [ ] **PQ** = PayPerQ (`api.ppq.ai`, 500+ modelos via 1 key) ou outro (PPQAI de patentes)?
- [ ] **OpenCode Zen sem key** — confirma que `minimax-m2.5-free`, `big-pickle` funcionam sem credencial alguma?
- [ ] Mais algum provider? (Mistral, Groq, xAI, Bedrock, Azure OpenAI, etc.)
- [ ] Ordem de prioridade — começar por qual?

### Fase 1 — Foundation
- [ ] `types.ts` com `IAgentProvider`, `ModelInfo`, `StreamChunk`, `ProviderCredential`, `ChatMessage`, `ContentBlock`
- [ ] `factory.ts` com `createProvider()` genérica + adapters para `openai-chat`, `openai-responses`, `anthropic-messages`
- [ ] `registry.ts` singleton
- [ ] Auth store em `localStorage` (web) com `ApiKeyCredential | OAuthCredential`
- [ ] `ChatInput` conectado: `submit()` → `registry.get(providerId).stream()` → render incremental de chunks
- [ ] Prova de conceito: OpenAI + Anthropic funcionando end-to-end com streaming

### Fase 2 — Providers essenciais
- [ ] `providers/openai.ts` (chat + responses)
- [ ] `providers/anthropic.ts`
- [ ] `providers/opencode-zen.ts` (free + paid)
- [ ] `providers/opencode-go.ts` (chat + anthropic split)
- [ ] `providers/minimax.ts`
- [ ] Model picker UI (2 selects empilhados em popover, padrão do orkas)

### Fase 3 — CLI detection
- [ ] `auth/codex.ts` — lê `~/.codex/auth.json` + keyring via `keytar`
- [ ] `auth/gcloud.ts` — lê ADC + refresh
- [ ] `auth/antigravity.ts` — lê keyring do `agy`
- [ ] `auth/cli-detector.ts` — orquestrador
- [ ] Settings UI: ao adicionar provider, primeiro detecta CLI, depois oferece OAuth/key
- [ ] Persistir `cliSource` + `cliEmail` para mostrar "logado como X"

### Fase 4 — Providers exóticos
- [ ] `providers/payperq.ts` (OpenAI-compat com baseURL custom)
- [ ] `providers/gemini.ts` (gcloud ADC + API key, formato gemini-native)
- [ ] `providers/antigravity.ts` (formato gemini-native com OAuth Google)
- [ ] `formats/gemini-native.ts` (streaming via `:streamGenerateContent`)

### Fase 5 — Settings UI
- [ ] Modal de providers com: API key field, "Detectar CLI" button, "Login com OAuth" button
- [ ] Validação via `validateCredential()` (faz request de ping)
- [ ] Toggle "thinking" / "tools" / "image input" baseado em `ModelInfo.supportsX`
- [ ] Mostrar quota/rate limit quando o provider expõe (futuro)

---

## 7. Estratégia de execução (paralelização com agents)

**Quem faz o quê:**

| Tarefa | Owner | Justificativa |
|---|---|---|
| Tipos centrais (`types.ts`) | **Mavis (eu)** | É a base — todos os outros dependem |
| `factory.ts` + adapters de formato | **Mavis (eu)** | Arquitetura crítica, valida o pattern |
| `registry.ts` + auth store | **Mavis (eu)** | Conecta com UI existente |
| ChatInput → registry end-to-end | **Mavis (eu)** | Prova de conceito + smoke test |
| Provider: OpenAI | **agent `coder`** | Bem escopado, formato conhecido |
| Provider: Anthropic | **agent `coder`** | Bem escopado, formato conhecido |
| Provider: OpenCode Zen | **agent `coder`** | OpenAI-compat, só config diferente |
| Provider: OpenCode Go | **agent `coder`** | OpenAI+Anthropic split |
| Provider: MiniMax | **agent `coder`** | Anthropic-compat, baseURL custom |
| CLI detection (codex, gcloud, antigravity) | **agent `coder`** | 3 arquivos isolados |
| Settings modal de providers | **Mavis (eu)** | UI, mais rápido iterar direto |
| Verificação final (build + smoke) | **agent `verifier`** | Smoke test end-to-end |

Após cada bloco do `coder`, eu rodo build + quick smoke e libero o próximo.

---

## 8. Notas e contexto

- **Kimi K3** está finalizando a UI do shell (sidebar, welcome screen, etc). Quando ele terminar, eu junto o que ele produziu com a camada de providers.
- **Não fazer fork** do orkas/opencode — BrightCode é greenfield.
- **Pattern preferido:** `createPiProvider()` do orkas (1 factory genérica, N providers) mas **sem dependência do `@earendil-works/pi-ai`** — o nosso factory próprio é mais limpo e customizável.
- **Auth store** começa em `localStorage`. Quando virar Electron, migra pra `electron-store` (keytar cuida do keyring).
- **Streams sempre `AsyncIterable<StreamChunk>`** — uniforme pra todos os providers. A UI só conhece `StreamChunk`, nunca o formato cru do provider.

---

## 9. Referências

- **Orkas (`D:/agent-teams/orkas-fork`)** — inspiração principal
  - `src/core-agent/src/providers/pi-provider.ts` — pattern da factory
  - `src/core-agent/src/providers/registry.ts` — registry
  - `src/core-agent/src/auth/types.ts` — `ApiKeyCredential | OAuthCredential`
  - `src/renderer/modules/chat-model-picker.js` — UI do model picker
- **Politron (`D:/projetos pessoais/politron`)** — referência de patterns
  - `apps/desktop/src/main/services/provider-router.ts` — dual provider
  - `apps/desktop/src/renderer/src/features/group-chat/mention-parser.ts`
- **MiniMax Code** (screenshot de referência) — UI target
- **Documentação de providers:**
  - OpenCode Zen: `https://opencode.ai/docs/zen/`
  - OpenCode Go: `https://opencode.ai/docs/go/`
  - Antigravity: `https://antigravity.google/docs/cli/install`
  - PayPerQ: `https://ppq.ai/api-docs`
  - Codex CLI: `https://inventivehq.com/knowledge-base/openai/where-configuration-files-are-stored`
  - Gemini CLI: `https://geminicli.com/docs/get-started/authentication/`
