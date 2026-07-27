/**
 * Electron preload script.
 *
 * Runs in an isolated context with access to both the DOM and a subset of
 * Node APIs (`ipcRenderer`, `contextBridge`). We expose ONLY the surface
 * the renderer needs — no raw `ipcRenderer`, no Node globals. This is the
 * standard sandboxed-bridge pattern recommended for Electron security.
 */

import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'

// The IPC boundary is untyped by design — the main process trusts whatever
// shape it gets, and the renderer re-narrows via the canonical type in
// `src/lib/providers/auth/store`. We accept `any` here to avoid a circular
// import across the process boundary.
type CredentialInput = any
type AccountInput = any

const auth = {
  get(providerId: string): Promise<CredentialInput | null> {
    return ipcRenderer.invoke(IPC.AUTH_GET, providerId)
  },
  set(providerId: string, credential: CredentialInput): Promise<void> {
    return ipcRenderer.invoke(IPC.AUTH_SET, providerId, credential)
  },
  remove(providerId: string): Promise<void> {
    return ipcRenderer.invoke(IPC.AUTH_REMOVE, providerId)
  },
  has(providerId: string): Promise<boolean> {
    return ipcRenderer.invoke(IPC.AUTH_HAS, providerId)
  },
  list(): Promise<Array<{ providerId: string; credential: CredentialInput }>> {
    return ipcRenderer.invoke(IPC.AUTH_LIST)
  },
  clear(): Promise<void> {
    return ipcRenderer.invoke(IPC.AUTH_CLEAR)
  },
  /** Subscribe to credential changes from the main process. */
  onChanged(handler: () => void): () => void {
    const wrapped = () => handler()
    ipcRenderer.on(IPC.AUTH_CHANGED, wrapped)
    return () => ipcRenderer.off(IPC.AUTH_CHANGED, wrapped)
  },
}

type DetectedProviderId = 'openai' | 'anthropic' | 'gemini-cli' | 'antigravity'

interface CLIDetection {
  providerId: DetectedProviderId
  source: string
  accountLabel?: string
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  projectId?: string
  accountId?: string
}

const cli = {
  detect(providerId: DetectedProviderId): Promise<CLIDetection | null> {
    return ipcRenderer.invoke(IPC.CLI_DETECT, providerId)
  },
  detectAll(): Promise<CLIDetection[]> {
    return ipcRenderer.invoke(IPC.CLI_DETECT_ALL)
  },
}

// ── Projects ───────────────────────────────────────────────────────────

interface Project {
  id: string
  label: string
  path: string
  createdAt: number
}

interface DirEntry {
  name: string
  path: string
}

interface ListDirsResult {
  ok: true
  entries: DirEntry[]
  parent: string | null
}

interface ProjectFileEntry {
  name: string
  path: string
  isDir: boolean
  size?: number
}

const projects = {
  list(): Promise<Project[]> {
    return ipcRenderer.invoke(IPC.PROJECTS_LIST)
  },
  add(path: string, label?: string): Promise<
    { ok: true; project: Project } | { ok: false; error: string }
  > {
    return ipcRenderer.invoke(IPC.PROJECTS_ADD, path, label)
  },
  remove(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return ipcRenderer.invoke(IPC.PROJECTS_REMOVE, id)
  },
  setActive(id: string | null): Promise<void> {
    return ipcRenderer.invoke(IPC.PROJECTS_SET_ACTIVE, id)
  },
  getActive(): Promise<Project | null> {
    return ipcRenderer.invoke(IPC.PROJECTS_GET_ACTIVE)
  },
  onChanged(handler: () => void): () => void {
    const wrapped = () => handler()
    ipcRenderer.on(IPC.PROJECTS_CHANGED, wrapped)
    return () => ipcRenderer.off(IPC.PROJECTS_CHANGED, wrapped)
  },
}

// ── Tasks ──────────────────────────────────────────────────────────────

interface TaskItem {
  id: string
  projectId: string | null
  title: string
  selectedModel?: string
  selectedAccountId?: string
  createdAt: number
  updatedAt: number
}

const tasks = {
  list(): Promise<TaskItem[]> {
    return ipcRenderer.invoke(IPC.TASKS_LIST)
  },
  create(input: {
    id?: string
    projectId: string | null
    title: string
    selectedModel?: string
    selectedAccountId?: string
    createdAt?: number
    updatedAt?: number
  }): Promise<TaskItem> {
    return ipcRenderer.invoke(IPC.TASKS_CREATE, input)
  },
  remove(id: string): Promise<void> {
    return ipcRenderer.invoke(IPC.TASKS_REMOVE, id)
  },
  update(
    id: string,
    patch: Partial<Pick<TaskItem, 'title' | 'projectId' | 'selectedModel' | 'selectedAccountId'>>,
  ): Promise<void> {
    return ipcRenderer.invoke(IPC.TASKS_UPDATE, id, patch)
  },
  getMessages<T = unknown>(taskId: string): Promise<T[]> {
    return ipcRenderer.invoke(IPC.TASKS_GET_MESSAGES, taskId)
  },
  saveMessages(taskId: string, messages: unknown[]): Promise<void> {
    return ipcRenderer.invoke(IPC.TASKS_SAVE_MESSAGES, taskId, messages)
  },
  onChanged(handler: () => void): () => void {
    const wrapped = () => handler()
    ipcRenderer.on(IPC.TASKS_CHANGED, wrapped)
    return () => ipcRenderer.off(IPC.TASKS_CHANGED, wrapped)
  },
}

// ── Multi-account ─────────────────────────────────────────────────────

const accounts = {
  list(providerId: string): Promise<AccountInput[]> {
    return ipcRenderer.invoke(IPC.ACCOUNTS_LIST, providerId)
  },
  listAll(): Promise<Record<string, Record<string, AccountInput>>> {
    return ipcRenderer.invoke(IPC.ACCOUNTS_LIST_ALL)
  },
  get(providerId: string, accountId: string): Promise<AccountInput | null> {
    return ipcRenderer.invoke(IPC.ACCOUNTS_GET, providerId, accountId)
  },
  add(providerId: string, account: AccountInput): Promise<void> {
    return ipcRenderer.invoke(IPC.ACCOUNTS_ADD, providerId, account)
  },
  update(providerId: string, accountId: string, patch: Record<string, unknown>): Promise<void> {
    return ipcRenderer.invoke(IPC.ACCOUNTS_UPDATE, providerId, accountId, patch)
  },
  remove(providerId: string, accountId: string): Promise<void> {
    return ipcRenderer.invoke(IPC.ACCOUNTS_REMOVE, providerId, accountId)
  },
  setActive(providerId: string, accountId: string): Promise<void> {
    return ipcRenderer.invoke(IPC.ACCOUNTS_SET_ACTIVE, providerId, accountId)
  },
  getActive(providerId: string): Promise<AccountInput | null> {
    return ipcRenderer.invoke(IPC.ACCOUNTS_GET_ACTIVE, providerId)
  },
  listActive(): Promise<Record<string, string>> {
    return ipcRenderer.invoke(IPC.ACCOUNTS_LIST_ACTIVE)
  },
  onChanged(handler: () => void): () => void {
    const wrapped = () => handler()
    ipcRenderer.on(IPC.ACCOUNTS_CHANGED, wrapped)
    return () => ipcRenderer.off(IPC.ACCOUNTS_CHANGED, wrapped)
  },
}

// ── Agent teams ───────────────────────────────────────────────────────

const agents = {
  list(): Promise<any[]> {
    return ipcRenderer.invoke(IPC.AGENTS_LIST)
  },
  get(id: string): Promise<any | null> {
    return ipcRenderer.invoke(IPC.AGENTS_GET, id)
  },
  add(agent: any): Promise<any> {
    return ipcRenderer.invoke(IPC.AGENTS_ADD, agent)
  },
  update(id: string, patch: Record<string, unknown>): Promise<void> {
    return ipcRenderer.invoke(IPC.AGENTS_UPDATE, id, patch)
  },
  remove(id: string): Promise<void> {
    return ipcRenderer.invoke(IPC.AGENTS_REMOVE, id)
  },
  onChanged(handler: () => void): () => void {
    const wrapped = () => handler()
    ipcRenderer.on(IPC.AGENTS_CHANGED, wrapped)
    return () => ipcRenderer.off(IPC.AGENTS_CHANGED, wrapped)
  },
}

// ── Usage tracking ────────────────────────────────────────────────────

interface UsageRecordInput {
  id: string
  providerId: string
  accountId: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheRead?: number
  cacheWrite?: number
  estimatedCost?: number
  timestamp: number
  source: 'provider' | 'cli' | '9router' | 'estimated'
}

interface QuotaSnapshotInput {
  providerId: string
  accountId: string
  quotaRemaining?: number
  quotaLimit?: number
  quotaResetAt?: number
  rateLimitRemaining?: number
  rateLimitResetAt?: number
  source: 'provider' | 'cli' | '9router' | 'unavailable'
  collectedAt: number
}

interface UsageSummaryInput {
  providerId: string
  accountId: string
  model: string
  totalInputTokens: number
  totalOutputTokens: number
  totalRequests: number
  totalCacheRead?: number
  totalCacheWrite?: number
  estimatedCost: number
  lastUsedAt: number
  quota?: QuotaSnapshotInput
}

const usage = {
  record(record: UsageRecordInput): Promise<void> {
    return ipcRenderer.invoke(IPC.USAGE_RECORD, record)
  },
  getHistory(providerId: string, accountId?: string, since?: number): Promise<UsageRecordInput[]> {
    return ipcRenderer.invoke(IPC.USAGE_GET_HISTORY, providerId, accountId, since)
  },
  getAllHistory(): Promise<Record<string, Record<string, UsageRecordInput[]>>> {
    return ipcRenderer.invoke(IPC.USAGE_GET_ALL_HISTORY)
  },
  getSummaries(): Promise<UsageSummaryInput[]> {
    return ipcRenderer.invoke(IPC.USAGE_GET_SUMMARIES)
  },
  setQuota(providerId: string, accountId: string, quota: QuotaSnapshotInput): Promise<void> {
    return ipcRenderer.invoke(IPC.USAGE_SET_QUOTA, providerId, accountId, quota)
  },
  getQuota(providerId: string, accountId: string): Promise<QuotaSnapshotInput | undefined> {
    return ipcRenderer.invoke(IPC.USAGE_GET_QUOTA, providerId, accountId)
  },
  fetchQuota(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ ok: boolean; status: number; data: unknown } | null> {
    return ipcRenderer.invoke(IPC.USAGE_FETCH_QUOTA, url, init)
  },
  getAllQuotas(): Promise<Record<string, Record<string, QuotaSnapshotInput>>> {
    return ipcRenderer.invoke(IPC.USAGE_GET_ALL_QUOTAS)
  },
  fetchCodex(accessToken: string, accountId?: string): Promise<{ ok: boolean; status: number; data: unknown }> {
    return ipcRenderer.invoke(IPC.USAGE_FETCH_CODEX, accessToken, accountId)
  },
  readCodexLocal(): Promise<{ ok: boolean; data: unknown }> {
    return ipcRenderer.invoke(IPC.USAGE_READ_CODEX_LOCAL)
  },
  clear(): Promise<void> {
    return ipcRenderer.invoke(IPC.USAGE_CLEAR)
  },
  onChanged(handler: () => void): () => void {
    const wrapped = () => handler()
    ipcRenderer.on(IPC.USAGE_CHANGED, wrapped)
    return () => ipcRenderer.off(IPC.USAGE_CHANGED, wrapped)
  },
}

// ── OAuth ──────────────────────────────────────────────────────────────

interface OAuthConfigInput {
  providerId: string
  clientId: string
  authorizeUrl: string
  tokenUrl: string
  scopes: string[]
  codeChallengeMethod?: 'S256' | 'plain'
  contentType?: 'application/x-www-form-urlencoded' | 'application/json'
  extraAuthParams?: Record<string, string>
  fixedPort?: number
  callbackPath?: string
  callbackHost?: string
}

interface OAuthResultOutput {
  ok: boolean
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  email?: string
  accountId?: string
  idToken?: string
  error?: string
}

const oauth = {
  start(config: OAuthConfigInput): Promise<OAuthResultOutput> {
    return ipcRenderer.invoke(IPC.OAUTH_START, config)
  },
  cancel(): Promise<void> {
    return ipcRenderer.invoke(IPC.OAUTH_CANCEL)
  },
}

// ── Filesystem ops ─────────────────────────────────────────────────────

const fs = {
  home(): Promise<string> {
    return ipcRenderer.invoke(IPC.FS_HOME)
  },
  defaultProjectsDir(): Promise<string> {
    return ipcRenderer.invoke(IPC.FS_DEFAULT_PROJECTS_DIR)
  },
  listDirs(dirPath: string): Promise<ListDirsResult | { ok: false; error: string }> {
    return ipcRenderer.invoke(IPC.FS_LIST_DIRS, dirPath)
  },
  browse(defaultPath?: string): Promise<
    { ok: true; path: string | null } | { ok: false; error: string }
  > {
    return ipcRenderer.invoke(IPC.FS_BROWSE, defaultPath)
  },
  browseFile(options?: {
    title?: string
    defaultPath?: string
    filters?: Array<{ name: string; extensions: string[] }>
  }): Promise<
    { ok: true; path: string | null } | { ok: false; error: string }
  > {
    return ipcRenderer.invoke(IPC.FS_BROWSE_FILE, options)
  },
  validate(path: string): Promise<
    | { ok: true; realPath: string }
    | { ok: false; error: string; code?: string }
  > {
    return ipcRenderer.invoke(IPC.FS_VALIDATE, path)
  },
  clone(url: string, dest: string): Promise<
    { ok: true; path: string } | { ok: false; error: string }
  > {
    return ipcRenderer.invoke(IPC.FS_CLONE, url, dest)
  },
  createDir(target: string): Promise<
    { ok: true; path: string } | { ok: false; error: string }
  > {
    return ipcRenderer.invoke(IPC.FS_CREATE_DIR, target)
  },
}

const workspace = {
  listTree(projectId: string): Promise<
    { ok: true; entries: ProjectFileEntry[] } | { ok: false; error: string }
  > {
    return ipcRenderer.invoke(IPC.FS_PROJECT_TREE, projectId)
  },
  readFile(projectId: string, relativePath: string): Promise<
    { ok: true; content: string; size: number } | { ok: false; error: string }
  > {
    return ipcRenderer.invoke(IPC.FS_PROJECT_READ, projectId, relativePath)
  },
  writeFile(projectId: string, relativePath: string, content: string): Promise<
    { ok: true; bytes: number } | { ok: false; error: string }
  > {
    return ipcRenderer.invoke(IPC.FS_PROJECT_WRITE, projectId, relativePath, content)
  },
  openProject(
    projectId: string,
    target: 'vscode' | 'folder' | 'reveal',
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return ipcRenderer.invoke(IPC.FS_PROJECT_OPEN, projectId, target)
  },
}

// ── Agent tools ────────────────────────────────────────────────────────
//
// Tools are run in the main process against the active project root.
// The renderer (LLM agent) calls `window.electronAPI.tools.execute(...)`
// and gets back a uniform `{ ok, result } | { ok: false, error }` envelope.

type ToolName =
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'list_files'
  | 'search_files'
  | 'list_skills'
  | 'read_skill'
  | 'read_skill_file'
  | 'bash'

type ToolArgs = {
  read_file: { path: string }
  write_file: { path: string; content: string }
  edit_file: { path: string; oldText: string; newText: string; replaceAll?: boolean }
  list_files: { path?: string; recursive?: boolean }
  search_files: { query: string; path?: string; includePattern?: string }
  list_skills: { query?: string }
  read_skill: { skill: string }
  read_skill_file: { skill: string; path: string }
  bash: { command: string; cwd?: string; timeoutMs?: number }
}

type ToolExecuteRequest = {
  [K in ToolName]: { name: K; args: ToolArgs[K] }
}[ToolName]

type ToolResult<T = unknown> = { ok: true; result: T } | { ok: false; error: string }

interface BashApprovalRequest {
  approvalId: string
  command: string
  workdir: string
  timeoutMs: number
}

const tools = {
  async execute<K extends ToolName>(
    name: K,
    args: ToolArgs[K],
  ): Promise<ToolResult> {
    const req: ToolExecuteRequest = { name, args } as ToolExecuteRequest
    return ipcRenderer.invoke(IPC.TOOL_EXECUTE, req)
  },
  /**
   * Subscribe to bash-tool approval requests from the main process.
   * The handler receives `{ approvalId, command, workdir, timeoutMs }`
   * and should call `respondToBashApproval(approvalId, approved)`
   * to unblock the tool call.
   */
  onBashApprovalRequest(
    handler: (req: BashApprovalRequest) => void,
  ): () => void {
    const wrapped = (_event: unknown, payload: BashApprovalRequest) =>
      handler(payload)
    ipcRenderer.on(IPC.TOOL_BASH_APPROVAL_REQUEST, wrapped)
    return () => ipcRenderer.off(IPC.TOOL_BASH_APPROVAL_REQUEST, wrapped)
  },
  respondToBashApproval(approvalId: string, approved: boolean): void {
    ipcRenderer.send(IPC.TOOL_BASH_APPROVAL_RESPOND, { approvalId, approved })
  },
}

function rendererLog(level: 'log' | 'warn' | 'error', args: unknown[]): void {
  // Fire and forget — never throw back to the caller.
  try {
    ipcRenderer.send(IPC.RENDERER_LOG, level, args)
  } catch {
    // IPC channel not available (e.g. running in plain browser dev) — silent.
  }
}

interface StreamStartPayload {
  requestId?: string
  providerId: string
  apiFormat: string
  /** Pre-built upstream URL (the renderer's format handler knows the path). */
  url: string
  /** HTTP method, typically POST. */
  method: string
  headers: Record<string, string>
  /** Pre-serialized JSON body of the upstream request. Empty string for GET. */
  body: string
}

interface ProviderStreamHandle {
  requestId: string
  /** Async iterable of raw SSE `data:` strings from the upstream. */
  chunks: AsyncIterable<{ raw: string }>
  /** Cancel the in-flight stream. */
  cancel: () => void
}

function startProviderStream(payload: StreamStartPayload): ProviderStreamHandle {
  const requestId = `ps_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const channel = (suffix: string) => `${suffix}:${requestId}`

  const queue: Array<{ raw: string }> = []
  const waiters: Array<{
    resolve: (v: IteratorResult<{ raw: string }>) => void
    reject: (err: Error) => void
  }> = []
  let done = false
  let error: Error | null = null

  function flushWaiter() {
    if (waiters.length === 0) return
    const waiter = waiters.shift()!
    if (error) {
      waiter.reject(error)
      return
    }
    if (queue.length > 0) {
      waiter.resolve({ value: queue.shift()!, done: false })
      return
    }
    if (done) {
      waiter.resolve({ value: undefined as never, done: true })
    }
  }

  // Subscribe BEFORE invoking start so we don't miss the first chunk.
  const chunkListener = (_e: unknown, _id: string, p: { raw: string }) => {
    if (_id !== requestId) return
    if (waiters.length > 0) {
      waiters.shift()!.resolve({ value: p, done: false })
    } else {
      queue.push(p)
    }
  }
  const endListener = (_e: unknown, _id: string) => {
    if (_id !== requestId) return
    done = true
    if (waiters.length > 0) flushWaiter()
  }
  const errorListener = (_e: unknown, _id: string, message: string) => {
    if (_id !== requestId) return
    error = new Error(message)
    done = true
    if (waiters.length > 0) flushWaiter()
  }
  function cleanup() {
    ipcRenderer.removeListener(channel(IPC.PROVIDER_STREAM_CHUNK), chunkListener as never)
    ipcRenderer.removeListener(channel(IPC.PROVIDER_STREAM_END), endListener as never)
    ipcRenderer.removeListener(channel(IPC.PROVIDER_STREAM_ERROR), errorListener as never)
  }

  ipcRenderer.on(channel(IPC.PROVIDER_STREAM_CHUNK), chunkListener as never)
  ipcRenderer.on(channel(IPC.PROVIDER_STREAM_END), endListener as never)
  ipcRenderer.on(channel(IPC.PROVIDER_STREAM_ERROR), errorListener as never)

  // Kick off the request.
  void ipcRenderer
    .invoke(IPC.PROVIDER_STREAM_START, { ...payload, requestId })
    .catch((err: unknown) => {
      error = err instanceof Error ? err : new Error(String(err))
      done = true
      if (waiters.length > 0) flushWaiter()
    })

  const chunks: AsyncIterable<{ raw: string }> = {
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise<IteratorResult<{ raw: string }>>((resolve, reject) => {
            if (error) {
              reject(error)
              return
            }
            if (queue.length > 0) {
              resolve({ value: queue.shift()!, done: false })
              return
            }
            if (done) {
              resolve({ value: undefined as never, done: true })
              return
            }
            waiters.push({ resolve, reject })
          }),
      }
    },
  }

  return {
    requestId,
    chunks,
    cancel: () => {
      try {
        ipcRenderer.send(IPC.PROVIDER_STREAM_CANCEL, requestId)
      } catch {
        // ignore
      }
      done = true
      cleanup()
      // Wake up any pending iterator
      while (waiters.length > 0) {
        waiters.shift()!.resolve({ value: undefined as never, done: true })
      }
    },
  }
}

// ── Skills ─────────────────────────────────────────────────────────────

interface DiscoveredSkill {
  id: string
  selector?: string
  name: string
  description: string
  source: 'codex' | 'agents' | 'gemini' | 'opencode' | 'project'
  sourceLabel: string
  folderPath: string
  skillFilePath: string
  author?: string
  version?: string
  tags?: string[]
  content?: string
}

const skills = {
  list(activeProjectPath?: string): Promise<DiscoveredSkill[]> {
    return ipcRenderer.invoke(IPC.SKILLS_LIST, activeProjectPath)
  },
  read(filePath: string): Promise<string> {
    return ipcRenderer.invoke(IPC.SKILLS_READ, filePath)
  },
  write(filePath: string, content: string): Promise<boolean> {
    return ipcRenderer.invoke(IPC.SKILLS_WRITE, filePath, content)
  },
}

type TerminalCreateResult =
  | { ok: true; sessionId: string; shell: string; cwd: string }
  | { ok: false; error: string }

type TerminalDataEvent = { sessionId: string; data: string }
type TerminalExitEvent = {
  sessionId: string
  exitCode: number
  signal?: number
}

const terminal = {
  create(
    projectId: string,
    dimensions?: { cols?: number; rows?: number },
  ): Promise<TerminalCreateResult> {
    return ipcRenderer.invoke(IPC.TERMINAL_CREATE, projectId, dimensions)
  },
  write(sessionId: string, data: string): void {
    ipcRenderer.send(IPC.TERMINAL_WRITE, sessionId, data)
  },
  resize(sessionId: string, cols: number, rows: number): void {
    ipcRenderer.send(IPC.TERMINAL_RESIZE, sessionId, { cols, rows })
  },
  kill(sessionId: string): Promise<boolean> {
    return ipcRenderer.invoke(IPC.TERMINAL_KILL, sessionId)
  },
  onData(handler: (event: TerminalDataEvent) => void): () => void {
    const wrapped = (_event: unknown, payload: TerminalDataEvent) =>
      handler(payload)
    ipcRenderer.on(IPC.TERMINAL_DATA, wrapped)
    return () => ipcRenderer.off(IPC.TERMINAL_DATA, wrapped)
  },
  onExit(handler: (event: TerminalExitEvent) => void): () => void {
    const wrapped = (_event: unknown, payload: TerminalExitEvent) =>
      handler(payload)
    ipcRenderer.on(IPC.TERMINAL_EXIT, wrapped)
    return () => ipcRenderer.off(IPC.TERMINAL_EXIT, wrapped)
  },
}

const electronAPI = {
  /** True when running inside the Electron wrapper. False in plain web dev. */
  isElectron: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  auth,
  accounts,
  agents,
  cli,
  projects,
  tasks,
  usage,
  oauth,
  fs,
  workspace,
  tools,
  skills,
  terminal,
  /** Forward a log message to the main process stdout. */
  log: rendererLog,
  /**
   * Stream a completion from a provider via the main process. Returns
   * an async iterable of raw `data:` payloads (the renderer's format
   * handler turns them into StreamChunks). Cancel via the returned
   * `cancel()`.
   */
  providerStream: startProviderStream,
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

// Also expose a global type for TS in the renderer.
export type ElectronAPI = typeof electronAPI
export type {
  CLIDetection,
  DetectedProviderId,
  Project,
  DirEntry,
  ListDirsResult,
  ProjectFileEntry,
  ToolName,
  ToolArgs,
  ToolExecuteRequest,
  ToolResult,
  BashApprovalRequest,
  DiscoveredSkill,
  TerminalCreateResult,
  TerminalDataEvent,
  TerminalExitEvent,
}
