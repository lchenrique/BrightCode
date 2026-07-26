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
    createdAt?: number
    updatedAt?: number
  }): Promise<TaskItem> {
    return ipcRenderer.invoke(IPC.TASKS_CREATE, input)
  },
  remove(id: string): Promise<void> {
    return ipcRenderer.invoke(IPC.TASKS_REMOVE, id)
  },
  update(id: string, patch: Partial<Pick<TaskItem, 'title' | 'projectId'>>): Promise<void> {
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
}

interface OAuthResultOutput {
  ok: boolean
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  email?: string
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

type ToolName = 'read_file' | 'write_file' | 'edit_file' | 'list_files' | 'search_files'

type ToolArgs = {
  read_file: { path: string }
  write_file: { path: string; content: string }
  edit_file: { path: string; oldText: string; newText: string; replaceAll?: boolean }
  list_files: { path?: string; recursive?: boolean }
  search_files: { query: string; path?: string; includePattern?: string }
}

type ToolExecuteRequest = {
  [K in ToolName]: { name: K; args: ToolArgs[K] }
}[ToolName]

type ToolResult<T = unknown> = { ok: true; result: T } | { ok: false; error: string }

const tools = {
  async execute<K extends ToolName>(
    name: K,
    args: ToolArgs[K],
  ): Promise<ToolResult> {
    const req: ToolExecuteRequest = { name, args } as ToolExecuteRequest
    return ipcRenderer.invoke(IPC.TOOL_EXECUTE, req)
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
  cli,
  projects,
  tasks,
  oauth,
  fs,
  workspace,
  tools,
  skills,
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
  DiscoveredSkill,
}
