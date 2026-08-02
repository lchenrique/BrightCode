import { electronStoreCwd } from './configure-user-data'

/**
 * Electron main process.
 *
 * Responsibilities:
 *   - Create the BrowserWindow that hosts the renderer.
 *   - Persist provider credentials to `electron-store` (encrypted at rest
 *     by the OS in production builds; plain JSON in dev — see TODO).
 *   - Expose a thin IPC surface so the renderer can read/write credentials
 *     without touching Node directly.
 *
 * The renderer is loaded from Vite's dev server during development and
 * from the built `dist/index.html` in production. Hot reload is wired up
 * automatically by `vite-plugin-electron`.
 */

import { app, BrowserWindow, ipcMain, protocol, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import Store from 'electron-store'
import { IPC } from '../shared/ipc-channels'
import {
  detectAllCLIs,
  detectAntigravity,
  detectClaudeCode,
  detectCodex,
  detectGeminiCLI,
  detectOpenCode,
  type CLIDetection,
  type DetectedProviderId,
} from './cli-detect'
import {
  type UsageRecord,
  type UsageSummary,
  type QuotaSnapshot,
} from '../../src/lib/providers/usage/types'
import { registerProviderProxy } from './provider-proxy'
import { registerProjectsIpc } from './projects'
import { registerTasksIpc } from './tasks'
import { registerOAuthIpc } from './oauth'
import {
  PROJECT_PREVIEW_SCHEME,
  registerFsIpc,
  registerProjectPreviewProtocol,
} from './fs-ops'
import { registerToolsIpc } from './tools'
import { registerSkillsIpc } from './skills'
import { registerTerminalIpc } from './terminal'
import { registerGitIpc } from './git'
import { registerBrightMemoryIpc } from './bright-memory'
import {
  configureAgentRuntimeProviderResolver,
  registerAgentRuntimeIpc,
} from './agent-runtime/ipc'
import type { BrightCodeAgentsModelBinding } from './agent-runtime/openai-agents-adapter'
import { getRendererEntryUrl, isTrustedRendererUrl } from './renderer-security'
import type { IAgentProvider, ProviderCredential } from '../../src/lib/providers/types'
import {
  anthropicModels,
  antigravityModels,
  geminiModels,
  minimaxModels,
  openaiModels,
  opencodeGoAnthropicModels,
  opencodeGoModels,
  opencodeZenModels,
} from '../../src/lib/providers/models'
import { createMainProvider } from './agent-runtime/main-provider-factory'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

protocol.registerSchemesAsPrivileged([
  {
    scheme: PROJECT_PREVIEW_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
])

// Existing Electron installs used Conf's shared config.json through this CJS interop.
// Keep that path for user data; isolated smokes use ElectronStore with an explicit cwd.
const StoreCtor = electronStoreCwd
  ? Store
  : ((Store as unknown as { default?: typeof Store }).default ?? Store)

// ── Usage store ────────────────────────────────────────────────────────

type UsageStoreData = {
  records: Record<string, Record<string, UsageRecord[]>>
  quotas: Record<string, Record<string, QuotaSnapshot>>
}

const usageStore = new StoreCtor<UsageStoreData>({
  name: 'usage',
  cwd: electronStoreCwd,
  defaults: { records: {}, quotas: {} },
})

/**
 * Codex writes the latest rate-limit snapshot into token_count events under
 * ~/.codex/sessions. Orca uses this local state as a fallback because it is
 * available even when the remote usage endpoint is unavailable.
 */
function readLatestCodexLocalUsage(): { rate_limits: unknown } | null {
  const root = join(homedir(), '.codex', 'sessions')
  const files: Array<{ path: string; mtime: number }> = []

  const walk = (dir: string, depth: number): void => {
    if (depth > 5) return
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path, depth + 1)
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          try {
            files.push({ path, mtime: statSync(path).mtimeMs })
          } catch {
            // A session may disappear while Codex is rotating its files.
          }
        }
      }
    } catch {
      // The sessions directory is optional (for example, API-key-only use).
    }
  }

  walk(root, 0)
  files.sort((a, b) => b.mtime - a.mtime)

  for (const file of files.slice(0, 40)) {
    try {
      const lines = readFileSync(file.path, 'utf8').split(/\r?\n/)
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (!lines[index]) continue
        const record = JSON.parse(lines[index]) as Record<string, unknown>
        const outerPayload = record.payload as Record<string, unknown> | undefined
        const rateLimits =
          record.rate_limits ??
          outerPayload?.rate_limits ??
          (outerPayload?.payload as Record<string, unknown> | undefined)?.rate_limits
        if (rateLimits && typeof rateLimits === 'object') {
          return { rate_limits: rateLimits }
        }
      }
    } catch {
      // Ignore malformed/partially-written session files.
    }
  }
  return null
}

function broadcastUsageChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(IPC.USAGE_CHANGED)
  }
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

ipcMain.handle(IPC.USAGE_RECORD, (_e, record: UsageRecord): void => {
  const data = usageStore.get('records')
  data[record.providerId] ??= {}
  data[record.providerId][record.accountId] ??= []
  data[record.providerId][record.accountId].push(record)
  const cutoff = Date.now() - THIRTY_DAYS_MS
  data[record.providerId][record.accountId] = data[record.providerId][record.accountId].filter(
    (r) => r.timestamp >= cutoff,
  )
  usageStore.set('records', data)
  broadcastUsageChanged()
})

ipcMain.handle(
  IPC.USAGE_GET_HISTORY,
  (_e, providerId: string, accountId?: string, since?: number): UsageRecord[] => {
    const data = usageStore.get('records')
    const prov = data[providerId]
    if (!prov) return []
    const cutoff = since ?? 0
    if (accountId) {
      const list = prov[accountId]
      return list ? list.filter((r) => r.timestamp >= cutoff) : []
    }
    const out: UsageRecord[] = []
    for (const list of Object.values(prov)) {
      for (const r of list) {
        if (r.timestamp >= cutoff) out.push(r)
      }
    }
    return out.sort((a, b) => b.timestamp - a.timestamp)
  },
)

ipcMain.handle(
  IPC.USAGE_GET_ALL_HISTORY,
  (): Record<string, Record<string, UsageRecord[]>> => usageStore.get('records'),
)

ipcMain.handle(IPC.USAGE_GET_SUMMARIES, (): UsageSummary[] => {
  const records = usageStore.get('records')
  const quotas = usageStore.get('quotas')
  const summaryMap = new Map<string, UsageSummary>()

  for (const [providerId, prov] of Object.entries(records)) {
    for (const [accountId, list] of Object.entries(prov)) {
      const grouped = new Map<string, UsageRecord[]>()
      for (const r of list) {
        const key = `${providerId}::${accountId}::${r.model}`
        const g = grouped.get(key) ?? []
        g.push(r)
        grouped.set(key, g)
      }
      for (const [key, group] of grouped) {
        const model = group[0].model
        let totalInput = 0, totalOutput = 0, totalCost = 0, totalCacheRead = 0, totalCacheWrite = 0, lastUsed = 0
        for (const r of group) {
          totalInput += r.inputTokens
          totalOutput += r.outputTokens
          totalCost += r.estimatedCost ?? 0
          if (r.cacheRead) totalCacheRead += r.cacheRead
          if (r.cacheWrite) totalCacheWrite += r.cacheWrite
          if (r.timestamp > lastUsed) lastUsed = r.timestamp
        }
        const quota = quotas[providerId]?.[accountId]
        summaryMap.set(key, {
          providerId,
          accountId,
          model,
          totalInputTokens: totalInput,
          totalOutputTokens: totalOutput,
          totalRequests: group.length,
          totalCacheRead: totalCacheRead || undefined,
          totalCacheWrite: totalCacheWrite || undefined,
          estimatedCost: Math.round(totalCost * 1_000_000) / 1_000_000,
          lastUsedAt: lastUsed,
          quota,
        })
      }
    }
  }
  return Array.from(summaryMap.values())
})

ipcMain.handle(
  IPC.USAGE_SET_QUOTA,
  (_e, providerId: string, accountId: string, quota: QuotaSnapshot): void => {
    const quotas = usageStore.get('quotas')
    quotas[providerId] ??= {}
    quotas[providerId][accountId] = quota
    usageStore.set('quotas', quotas)
    broadcastUsageChanged()
  },
)

ipcMain.handle(
  IPC.USAGE_GET_QUOTA,
  (_e, providerId: string, accountId: string): QuotaSnapshot | undefined => {
    return usageStore.get('quotas')[providerId]?.[accountId]
  },
)

ipcMain.handle(
  IPC.USAGE_GET_ALL_QUOTAS,
  (): Record<string, Record<string, QuotaSnapshot>> => usageStore.get('quotas'),
)

ipcMain.handle(
  IPC.USAGE_FETCH_CODEX,
  async (_e, accessToken: string, accountId?: string): Promise<{ ok: boolean; status: number; data: unknown }> => {
    if (!accessToken || typeof accessToken !== 'string') return { ok: false, status: 401, data: null }
    try {
      const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          originator: 'codex_cli_rs',
          'OpenAI-Beta': 'codex-1',
          ...(typeof accountId === 'string' && accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
        },
      })
      const data = await response.json().catch(() => null)
      return { ok: response.ok, status: response.status, data }
    } catch {
      return { ok: false, status: 0, data: null }
    }
  },
)

ipcMain.handle(
  IPC.USAGE_READ_CODEX_LOCAL,
  (): { ok: boolean; data: unknown } => {
    const data = readLatestCodexLocalUsage()
    return data ? { ok: true, data } : { ok: false, data: null }
  },
)

/**
 * Generic server-side fetch for quota endpoints. Some providers (e.g.
 * MiniMax) reject the browser CORS preflight on headers like `x-api-key`,
 * so the renderer routes these requests through the main process.
 */
ipcMain.handle(
  IPC.USAGE_FETCH_QUOTA,
  async (
    _e,
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ ok: boolean; status: number; data: unknown } | null> => {
    if (typeof url !== 'string' || !url) return null
    try {
      const response = await fetch(url, {
        method: typeof init?.method === 'string' ? init.method : 'GET',
        headers: init?.headers && typeof init.headers === 'object' ? init.headers : undefined,
        body: typeof init?.body === 'string' ? init.body : undefined,
      })
      const data = await response.json().catch(() => null)
      return { ok: response.ok, status: response.status, data }
    } catch {
      return null
    }
  },
)

ipcMain.handle(IPC.USAGE_CLEAR, (): void => {
  usageStore.set('records', {})
  usageStore.set('quotas', {})
  broadcastUsageChanged()
})

// ── Persistent credential store ────────────────────────────────────────
//
// We keep the same shape the renderer used in the browser dev mode
// (localStorage) so the API surface doesn't need to change between modes.
// `name` controls the file on disk: ~/.config/brightcode/auth.json (macOS)
// or %APPDATA%/brightcode/auth.json (Windows).
type StoredCredential = {
  method: 'api_key' | 'oauth' | 'cli_detected'
  apiKey?: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  cliSource?: string
  cliEmail?: string
}

type StoredAccount = {
  id: string
  providerId: string
  label: string
  email?: string
  authMethod: 'api_key' | 'oauth' | 'cli_detected'
  apiKey?: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  cliSource?: string
  cliEmail?: string
  enabled: boolean
  lastUsedAt?: number
  createdAt: number
}

/**
 * Agent team definitions — persisted under `agents` in electron-store.
 * Same shape as `AgentDefinition` in `src/lib/agents/store.ts`.
 */
type AgentDefinition = {
  id: string
  name: string
  avatarSeed: string
  description: string
  systemPrompt: string
  model: string
  accountId?: string
  projectId?: string
  tools: string[]
  enabled: boolean
  createdAt: number
  updatedAt: number
}

const auth = new StoreCtor<{
  credentials: Record<string, StoredCredential>
  accounts: Record<string, Record<string, StoredAccount>>
  activeAccounts: Record<string, string>
  agents: Record<string, AgentDefinition>
}>({
  name: 'auth',
  cwd: electronStoreCwd,
  defaults: { credentials: {}, accounts: {}, activeAccounts: {}, agents: {} },
  // TODO(security): add `encryptionKey` once we have a passphrase flow.
  // For now the file is plain JSON on disk — still better than
  // localStorage in a browser profile because it's never synced or
  // exposed to web content.
})

const storedAgents = auth.get('agents') as Record<
  string,
  AgentDefinition & { emoji?: string }
>
let agentsMigrated = false
for (const agent of Object.values(storedAgents)) {
  if (!agent.avatarSeed) {
    agent.avatarSeed = agent.emoji || agent.name || 'agent'
    agentsMigrated = true
  }
  if ('emoji' in agent) {
    delete agent.emoji
    agentsMigrated = true
  }
}
if (agentsMigrated) auth.set('agents', storedAgents)

// ── Window ──────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null

// In dev, expose Chrome DevTools Protocol on a fixed port so we can poke at
// the renderer from a script (e.g. `scripts/cdp-inspect.mjs`). Production
// builds don't need this — DevTools is hidden anyway.
if (process.env['VITE_DEV_SERVER_URL'] && !process.env['VITE_DEV_SERVER_URL'].includes('production')) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
  app.commandLine.appendSwitch('remote-allow-origins', '*')
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 400,
    minHeight: 400,
    show: false,
    backgroundColor: '#0a0c10',
    title: 'BrightCode',
    icon: join(__dirname, '../../build/icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs `electron` for ipcRenderer + contextBridge
      // CORS-safe by default: provider fetches happen in the main process
      // via the proxy (`electron/main/provider-proxy.ts`), so the renderer
      // never makes cross-origin requests that would be blocked by SOP.
    },
  })

  // Open external links in the user's default browser, not in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault()
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    // Open DevTools automatically in dev so users can see console errors
    // and the network tab. In production we leave it closed.
    if (process.env['VITE_DEV_SERVER_URL']) {
      mainWindow?.webContents.openDevTools({ mode: 'detach' })
    }
  })

  // Load the renderer. During dev `vite-plugin-electron` should inject
  // `VITE_DEV_SERVER_URL` (the Vite dev server URL) into process.env before
  // spawning us. As a defensive fallback we hardcode the dev server URL
  // when running unpackaged — the Vite dev server runs on a fixed port
  // (see `vite.config.ts: server.port = 5180`). In production we load the
  // built static files from `dist/`.
  const rendererUrl = getRendererEntryUrl()
  console.log('[brightcode] loading renderer from', rendererUrl)
  void mainWindow.loadURL(rendererUrl)
}

// ── IPC handlers ────────────────────────────────────────────────────────

function broadcastChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(IPC.AUTH_CHANGED)
  }
}

ipcMain.handle(IPC.AUTH_GET, (_e, providerId: string): StoredCredential | null => {
  const all = auth.get('credentials')
  return all[providerId] ?? null
})

ipcMain.handle(IPC.AUTH_SET, (_e, providerId: string, credential: StoredCredential): void => {
  const all = auth.get('credentials')
  all[providerId] = credential
  auth.set('credentials', all)
  broadcastChanged()
})

ipcMain.handle(IPC.AUTH_REMOVE, (_e, providerId: string): void => {
  const all = auth.get('credentials')
  delete all[providerId]
  auth.set('credentials', all)
  broadcastChanged()
})

ipcMain.handle(IPC.AUTH_HAS, (_e, providerId: string): boolean => {
  return providerId in auth.get('credentials')
})

ipcMain.handle(
  IPC.AUTH_LIST,
  (): Array<{ providerId: string; credential: StoredCredential }> => {
    const all = auth.get('credentials')
    return Object.entries(all).map(([providerId, credential]) => ({ providerId, credential }))
  },
)

ipcMain.handle(IPC.AUTH_CLEAR, (): void => {
  auth.set('credentials', {})
  broadcastChanged()
})

// ── Account helpers (migration + format) ──────────────────────────────

function accountToStoredCredential(acc: StoredAccount): StoredCredential {
  return {
    method: acc.authMethod,
    apiKey: acc.apiKey,
    accessToken: acc.accessToken,
    refreshToken: acc.refreshToken,
    expiresAt: acc.expiresAt,
    cliSource: acc.cliSource,
    cliEmail: acc.cliEmail,
  }
}

function migrateCredentialsToAccounts(): void {
  const creds = auth.get('credentials')
  const accounts = auth.get('accounts')
  if (Object.keys(creds).length > 0 && Object.keys(accounts).length === 0) {
    const migrated: Record<string, Record<string, StoredAccount>> = {}
    for (const [providerId, cred] of Object.entries(creds)) {
      migrated[providerId] = {
        default: {
          id: 'default',
          providerId,
          label: 'Default',
          authMethod: cred.method,
          apiKey: cred.apiKey,
          accessToken: cred.accessToken,
          refreshToken: cred.refreshToken,
          expiresAt: cred.expiresAt,
          cliSource: cred.cliSource,
          cliEmail: cred.cliEmail,
          enabled: true,
          lastUsedAt: Date.now(),
          createdAt: Date.now(),
        },
      }
    }
    auth.set('accounts', migrated)
  }
}

const runtimeProviders: IAgentProvider[] = [
  createMainProvider({ id: 'openai', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', apiFormat: 'openai-chat', staticModels: openaiModels }),
  createMainProvider({ id: 'anthropic', name: 'Anthropic', baseURL: 'https://api.anthropic.com', apiFormat: 'anthropic-messages', staticModels: anthropicModels }),
  createMainProvider({ id: 'gemini-cli', name: 'Gemini CLI', baseURL: 'https://generativelanguage.googleapis.com', apiFormat: 'gemini-native', staticModels: geminiModels }),
  createMainProvider({ id: 'antigravity', name: 'Antigravity', baseURL: 'https://cloudcode-pa.googleapis.com', apiFormat: 'gemini-native', staticModels: antigravityModels }),
  createMainProvider({ id: 'opencode-zen', name: 'OpenCode Zen', baseURL: 'https://opencode.ai/zen/v1', apiFormat: 'openai-chat', staticModels: opencodeZenModels, unauthenticatedHeaders: { Authorization: 'Bearer public' } }),
  createMainProvider({ id: 'opencode-go', name: 'OpenCode Go', baseURL: 'https://opencode.ai/zen/go/v1', apiFormat: 'openai-chat', staticModels: opencodeGoModels, modelPrefix: 'opencode-go/' }),
  createMainProvider({ id: 'opencode-go-anthropic', name: 'OpenCode Go', baseURL: 'https://opencode.ai/zen/go', apiFormat: 'anthropic-messages', staticModels: opencodeGoAnthropicModels, credentialProviderId: 'opencode-go', modelPrefix: 'opencode-go/' }),
  createMainProvider({ id: 'minimax', name: 'MiniMax', baseURL: 'https://api.minimax.io/v1', apiFormat: 'openai-chat', staticModels: minimaxModels }),
]

function resolveRuntimeBinding(modelSelection?: string, accountId?: string): BrightCodeAgentsModelBinding | undefined {
  migrateCredentialsToAccounts()
  const requested = modelSelection ?? 'minimax/MiniMax-M3'
  const slash = requested.indexOf('/')
  const requestedProviderId = slash > 0 ? requested.slice(0, slash) : undefined
  const requestedModelId = slash > 0 ? requested.slice(slash + 1) : requested
  const provider = requestedProviderId
    ? runtimeProviders.find((candidate) => candidate.id === requestedProviderId)
    : runtimeProviders.find((candidate) => candidate.listModels().some((model) => model.id === requestedModelId))
  if (!provider) return undefined
  const model = provider.listModels().find((candidate) => candidate.id === requestedModelId)
  if (!model) return undefined
  const credentialProviderId = provider.credentialProviderId ?? provider.id
  const accounts = auth.get('accounts')[credentialProviderId] ?? {}
  const account = accountId
    ? accounts[accountId]
    : (() => {
        const activeId = auth.get('activeAccounts')[credentialProviderId]
        return (activeId ? accounts[activeId] : undefined) ?? accounts['default'] ?? Object.values(accounts)[0]
      })()
  const requiresAuth = model.requiresAuth !== false
  if (requiresAuth && (!account || !account.enabled)) return undefined
  const storedCredential = account ? accountToStoredCredential(account) : undefined
  const credential: ProviderCredential | undefined = storedCredential
    ? {
        method: storedCredential.method,
        apiKey: storedCredential.apiKey,
        accessToken: storedCredential.accessToken,
        refreshToken: storedCredential.refreshToken,
        expiresAt: storedCredential.expiresAt,
        cliSource: storedCredential.cliSource as ProviderCredential['cliSource'],
        cliEmail: storedCredential.cliEmail,
      }
    : undefined
  return { provider, modelId: model.id, credential }
}

function broadcastAccountsChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(IPC.ACCOUNTS_CHANGED)
  }
}

// ── Account IPC handlers ──────────────────────────────────────────────

ipcMain.handle(IPC.ACCOUNTS_LIST_ALL, (): Record<string, Record<string, StoredAccount>> => {
  migrateCredentialsToAccounts()
  return auth.get('accounts')
})

ipcMain.handle(IPC.ACCOUNTS_LIST, (_e, providerId: string): StoredAccount[] => {
  const accounts = auth.get('accounts')
  const prov = accounts[providerId]
  return prov ? Object.values(prov) : []
})

ipcMain.handle(
  IPC.ACCOUNTS_GET,
  (_e, providerId: string, accountId: string): StoredAccount | null => {
    return auth.get('accounts')[providerId]?.[accountId] ?? null
  },
)

ipcMain.handle(
  IPC.ACCOUNTS_ADD,
  (_e, providerId: string, account: StoredAccount): void => {
    const accounts = auth.get('accounts')
    accounts[providerId] = accounts[providerId] ?? {}
    accounts[providerId][account.id] = account
    auth.set('accounts', accounts)
    // Sync default account to old credentials key for backward compat
    if (account.id === 'default') {
      const creds = auth.get('credentials')
      creds[providerId] = accountToStoredCredential(account)
      auth.set('credentials', creds)
    }
    broadcastAccountsChanged()
  },
)

ipcMain.handle(
  IPC.ACCOUNTS_UPDATE,
  (_e, providerId: string, accountId: string, patch: Partial<StoredAccount>): void => {
    const accounts = auth.get('accounts')
    const existing = accounts[providerId]?.[accountId]
    if (!existing) return
    accounts[providerId][accountId] = { ...existing, ...patch }
    auth.set('accounts', accounts)
    // Sync default account to old credentials key
    if (accountId === 'default') {
      const updated = accounts[providerId]['default']
      const creds = auth.get('credentials')
      creds[providerId] = accountToStoredCredential(updated)
      auth.set('credentials', creds)
    }
    broadcastAccountsChanged()
  },
)

ipcMain.handle(
  IPC.ACCOUNTS_REMOVE,
  (_e, providerId: string, accountId: string): void => {
    const accounts = auth.get('accounts')
    if (!accounts[providerId]) return
    delete accounts[providerId][accountId]
    if (Object.keys(accounts[providerId]).length === 0) {
      delete accounts[providerId]
    }
    auth.set('accounts', accounts)
    // Remove from old credentials key too
    if (accountId === 'default' || Object.keys(accounts[providerId] ?? {}).length === 0) {
      const creds = auth.get('credentials')
      delete creds[providerId]
      auth.set('credentials', creds)
    }
    broadcastAccountsChanged()
  },
)

ipcMain.handle(IPC.ACCOUNTS_SET_ACTIVE, (_e, providerId: string, accountId: string): void => {
  const active = auth.get('activeAccounts')
  active[providerId] = accountId
  auth.set('activeAccounts', active)
  broadcastAccountsChanged()
})

ipcMain.handle(IPC.ACCOUNTS_LIST_ACTIVE, (): Record<string, string> => {
  return auth.get('activeAccounts')
})

ipcMain.handle(IPC.ACCOUNTS_GET_ACTIVE, (_e, providerId: string): StoredAccount | null => {
  const active = auth.get('activeAccounts')
  const accountId = active[providerId]
  if (accountId) {
    const account = auth.get('accounts')[providerId]?.[accountId]
    if (account) return account
  }
  const accounts = auth.get('accounts')[providerId]
  if (!accounts) return null
  return accounts['default'] ?? Object.values(accounts)[0] ?? null
})

// ── Agent team IPC handlers ──────────────────────────────────────────

function broadcastAgentsChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(IPC.AGENTS_CHANGED)
  }
}

ipcMain.handle(IPC.AGENTS_LIST, (): AgentDefinition[] => {
  return Object.values(auth.get('agents'))
})

ipcMain.handle(IPC.AGENTS_GET, (_e, id: string): AgentDefinition | null => {
  return auth.get('agents')[id] ?? null
})

ipcMain.handle(IPC.AGENTS_ADD, (_e, input: Omit<AgentDefinition, 'id' | 'createdAt' | 'updatedAt'>): AgentDefinition => {
  const agents = auth.get('agents')
  const id = crypto.randomUUID()
  const ts = Date.now()
  const def: AgentDefinition = { ...input, id, createdAt: ts, updatedAt: ts }
  agents[id] = def
  auth.set('agents', agents)
  broadcastAgentsChanged()
  return def
})

ipcMain.handle(IPC.AGENTS_UPDATE, (_e, id: string, patch: Partial<AgentDefinition>): void => {
  const agents = auth.get('agents')
  const existing = agents[id]
  if (!existing) return
  agents[id] = { ...existing, ...patch, updatedAt: Date.now() }
  auth.set('agents', agents)
  broadcastAgentsChanged()
})

ipcMain.handle(IPC.AGENTS_REMOVE, (_e, id: string): void => {
  const agents = auth.get('agents')
  if (!agents[id]) return
  delete agents[id]
  auth.set('agents', agents)
  broadcastAgentsChanged()
})

// ── CLI detection ───────────────────────────────────────────────────────

ipcMain.handle(IPC.CLI_DETECT, async (_e, providerId: DetectedProviderId): Promise<CLIDetection | null> => {
  switch (providerId) {
    case 'openai':
      return detectCodex()
    case 'anthropic':
      return detectClaudeCode()
    case 'gemini-cli':
      return detectGeminiCLI()
    case 'antigravity':
      return detectAntigravity()
    case 'opencode-go':
    case 'opencode-zen':
    case 'minimax': {
      const all = await detectOpenCode()
      return all.find((d) => d.providerId === providerId) ?? null
    }
    default:
      return null
  }
})

ipcMain.handle(IPC.CLI_DETECT_ALL, (): Promise<CLIDetection[]> => detectAllCLIs())

// ── Renderer log forwarding ────────────────────────────────────────────

ipcMain.on(IPC.RENDERER_LOG, (_e, level: string, args: unknown[]) => {
  const prefix = `[renderer:${level}]`
  const printable = args
    .map((a) => {
      if (a instanceof Error) return a.stack ?? a.message
      if (typeof a === 'string') return a
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
  if (level === 'error') console.error(prefix, printable)
  else if (level === 'warn') console.warn(prefix, printable)
  else console.log(prefix, printable)
})

// ── Provider stream proxy ───────────────────────────────────────────────

registerProviderProxy()

// ── Projects + tasks + oauth + filesystem ops ──────────────────────────

registerProjectsIpc()
registerTasksIpc()
registerOAuthIpc()
registerFsIpc()
registerToolsIpc()
registerSkillsIpc()
registerTerminalIpc()
registerGitIpc()
registerBrightMemoryIpc()
configureAgentRuntimeProviderResolver({ resolve: resolveRuntimeBinding })
registerAgentRuntimeIpc()

// ── App lifecycle ──────────────────────────────────────────────────────

app.whenReady().then(() => {
  registerProjectPreviewProtocol()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
