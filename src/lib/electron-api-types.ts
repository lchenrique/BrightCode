/**
 * Renderer-side type definitions for the BrightCode IPC surface.
 *
 * Mirrors `electron/preload/index.ts` (Electron API shape) so the renderer
 * can talk to the bridge uniformly whether it's running under Tauri or
 * legacy Electron. The bridge installer in `tauri-bridge.ts` exposes an
 * object that conforms to `ElectronAPI` on `window.electronAPI`.
 */

// ── Shared primitives ─────────────────────────────────────────────────

export type DetectedProviderId =
  | 'openai'
  | 'anthropic'
  | 'gemini-cli'
  | 'antigravity'
  | 'opencode-go'
  | 'opencode-zen'
  | 'minimax'

export interface CLIDetection {
  providerId: DetectedProviderId
  source: string
  accountLabel?: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  projectId?: string
  accountId?: string
}

// ── Bright Memory ─────────────────────────────────────────────────────

export interface BrightMemoryStatus {
  cliInstalled: boolean
  cliVersion?: string | null
  globalRuleConfigured: boolean
  rulePaths: string[]
  ready: boolean
}

export type BrightMemoryInstallResult =
  | { ok: true; status: BrightMemoryStatus }
  | { ok: false; error: string; status: BrightMemoryStatus }

// ── Projects ──────────────────────────────────────────────────────────

export interface Project {
  id: string
  label: string
  path: string
  createdAt: number
}

export interface DirEntry {
  name: string
  path: string
}

export interface ListDirsResult {
  ok: true
  entries: DirEntry[]
  parent: string | null
}

// ── Workspace ─────────────────────────────────────────────────────────

export interface ProjectFileEntry {
  name: string
  path: string
  isDir: boolean
  size?: number
}

// ── Skills ────────────────────────────────────────────────────────────

export interface DiscoveredSkill {
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

// ── Tasks ─────────────────────────────────────────────────────────────

export interface TaskItem {
  id: string
  projectId: string | null
  title: string
  selectedModel?: string
  selectedAccountId?: string
  createdAt: number
  updatedAt: number
}

// ── Terminal ──────────────────────────────────────────────────────────

export type TerminalCreateResult =
  | { ok: true; sessionId: string; shell: string; cwd: string }
  | { ok: false; error: string }

export interface TerminalDataEvent {
  sessionId: string
  data: string
}

export interface TerminalExitEvent {
  sessionId: string
  exitCode: number
  signal?: number
}

// ── Agent runtime ─────────────────────────────────────────────────────

export interface AgentRuntimeThreadCreateCommand {
  threadId?: string
}

export interface AgentRuntimeThreadReadCommand {
  threadId: string
}

export interface AgentRuntimeHistoryReadCommand {
  threadId: string
  afterSequence?: number
}

export interface AgentRuntimeTurnStartCommand {
  threadId: string
  text: string
  modelId?: string
  accountId?: string
  images?: Array<{ kind: 'url' | 'base64'; value: string }>
}

export interface AgentRuntimeTurnInterruptCommand {
  threadId: string
  turnId?: string
}

export interface AgentRuntimeSubscribeCommand {
  threadId: string
  subscriptionId: string
  afterSequence?: number
}

export interface RuntimeEvent {
  sequence: number
  type: string
  payload: unknown
}

export interface ThreadState {
  threadId: string
  generation: number
  sequence: number
  turns: Record<string, unknown>
  turnOrder: string[]
  items: Record<string, unknown>
  itemOrder: string[]
  approvals: Record<string, unknown>
  usage: {
    inputTokens: number
    outputTokens: number
    cachedTokens: number
    costUSD: number
    perTurn: Record<string, unknown>
  }
  idle: boolean
}

export interface AgentRuntimeEventEnvelope {
  event: RuntimeEvent
  state: ThreadState
}

// ── Git ───────────────────────────────────────────────────────────────

export type GitResult =
  | { ok: true; stdout: string; stderr: string; code: number }
  | { ok: false; error: string }

// ── Tools ─────────────────────────────────────────────────────────────

export type ToolName =
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'list_files'
  | 'search_files'
  | 'list_skills'
  | 'read_skill'
  | 'read_skill_file'
  | 'bash'

export interface ToolArgs {
  read_file: { path: string }
  write_file: { path: string; content: string }
  edit_file: {
    path: string
    oldText: string
    newText: string
    replaceAll?: boolean
  }
  list_files: { path?: string; recursive?: boolean }
  search_files: { query: string; path?: string; includePattern?: string }
  list_skills: { query?: string }
  read_skill: { skill: string }
  read_skill_file: { skill: string; path: string }
  bash: { command: string; cwd?: string; timeoutMs?: number }
}

export type ToolExecuteRequest = {
  [K in ToolName]: { name: K; args: ToolArgs[K] }
}[ToolName]

export type ToolResult<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; error: string }

export interface BashApprovalRequest {
  approvalId: string
  command: string
  workdir: string
  timeoutMs: number
}

// ── Provider stream ───────────────────────────────────────────────────

export interface StreamStartPayload {
  requestId?: string
  providerId: string
  apiFormat: string
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

export interface ProviderStreamHandle {
  requestId: string
  chunks: AsyncIterable<{ raw: string }>
  cancel: () => void
}

// ── The full surface ─────────────────────────────────────────────────

export interface ElectronAPI {
  isElectron: boolean
  platform: string
  versions: { electron: string; chrome: string; node: string }

  auth: {
    get(providerId: string): Promise<unknown | null>
    set(providerId: string, credential: unknown): Promise<void>
    remove(providerId: string): Promise<void>
    has(providerId: string): Promise<boolean>
    list(): Promise<Array<{ providerId: string; credential: unknown }>>
    clear(): Promise<void>
    onChanged(handler: () => void): () => void
  }

  accounts: {
    listAll(): Promise<Record<string, Record<string, unknown>>>
    get(providerId: string, accountId: string): Promise<unknown | null>
    add(providerId: string, account: unknown): Promise<void>
    update(
      providerId: string,
      accountId: string,
      patch: Record<string, unknown>,
    ): Promise<void>
    remove(providerId: string, accountId: string): Promise<void>
    setActive(providerId: string, accountId: string): Promise<void>
    getActive(providerId: string): Promise<unknown | null>
    listActive(): Promise<Record<string, string>>
    onChanged(handler: () => void): () => void
  }

  agents: {
    list(): Promise<unknown[]>
    get(id: string): Promise<unknown | null>
    add(agent: unknown): Promise<unknown>
    update(id: string, patch: Record<string, unknown>): Promise<void>
    remove(id: string): Promise<void>
    onChanged(handler: () => void): () => void
  }

  cli: {
    detect(providerId: DetectedProviderId): Promise<CLIDetection | null>
    detectAll(): Promise<CLIDetection[]>
  }

  brightMemory: {
    status(): Promise<BrightMemoryStatus>
    install(): Promise<BrightMemoryInstallResult>
  }

  projects: {
    list(): Promise<Project[]>
    add(
      path: string,
      label?: string,
    ): Promise<{ ok: true; project: Project } | { ok: false; error: string }>
    remove(id: string): Promise<{ ok: true } | { ok: false; error: string }>
    setActive(id: string | null): Promise<void>
    getActive(): Promise<Project | null>
    onChanged(handler: () => void): () => void
  }

  tasks: {
    list(projectId?: string): Promise<TaskItem[]>
    create(input: TaskItem): Promise<TaskItem>
    remove(id: string): Promise<void>
    update(
      id: string,
      patch: Partial<Pick<TaskItem, 'title' | 'selectedModel' | 'selectedAccountId'>>,
    ): Promise<void>
    getMessages<T = unknown>(taskId: string): Promise<T[]>
    saveMessages<T = unknown>(taskId: string, messages: T[]): Promise<void>
    onChanged(handler: () => void): () => void
  }

  usage: {
    record(record: unknown): Promise<void>
    getHistory(
      providerId: string,
      accountId?: string,
      since?: number,
    ): Promise<unknown[]>
    getAllHistory(): Promise<Record<string, Record<string, unknown[]>>>
    getSummaries(): Promise<unknown[]>
    setQuota(
      providerId: string,
      accountId: string,
      quota: unknown,
    ): Promise<void>
    getQuota(providerId: string, accountId: string): Promise<unknown>
    fetchQuota(
      url: string,
      init: { method?: string; headers?: Record<string, string>; body?: string },
    ): Promise<{ ok: boolean; status: number; data: unknown } | null>
    getAllQuotas(): Promise<Record<string, Record<string, unknown>>>
    fetchCodex(
      accessToken: string,
      accountId?: string,
    ): Promise<{ ok: boolean; status: number; data: unknown }>
    readCodexLocal(): Promise<{ ok: boolean; data: unknown }>
    clear(): Promise<void>
    onChanged(handler: () => void): () => void
  }

  oauth: {
    start(config: unknown): Promise<{
      ok: boolean
      accessToken?: string
      refreshToken?: string
      expiresAt?: number
      email?: string
      accountId?: string
      idToken?: string
      error?: string
    }>
    cancel(): Promise<void>
  }

  fs: {
    home(): Promise<string>
    defaultProjectsDir(): Promise<string>
    listDirs(
      dirPath: string,
    ): Promise<ListDirsResult | { ok: false; error: string }>
    browse(
      defaultPath?: string,
    ): Promise<{ ok: true; path: string | null } | { ok: false; error: string }>
    browseFile(options?: {
      title?: string
      defaultPath?: string
      filters?: Array<{ name: string; extensions: string[] }>
    }): Promise<{ ok: true; path: string | null } | { ok: false; error: string }>
    validate(
      path: string,
    ): Promise<
      | { ok: true; realPath: string }
      | { ok: false; error: string; code?: string }
    >
    clone(
      url: string,
      dest: string,
    ): Promise<{ ok: true; path: string } | { ok: false; error: string }>
    createDir(
      target: string,
    ): Promise<{ ok: true; path: string } | { ok: false; error: string }>
  }

  workspace: {
    listTree(
      projectId: string,
    ): Promise<
      | { ok: true; entries: ProjectFileEntry[] }
      | { ok: false; error: string }
    >
    readFile(
      projectId: string,
      relativePath: string,
    ): Promise<
      | { ok: true; content: string; size: number }
      | { ok: false; error: string }
    >
    writeFile(
      projectId: string,
      relativePath: string,
      content: string,
    ): Promise<{ ok: true; bytes: number } | { ok: false; error: string }>
    openProject(
      projectId: string,
      target: 'vscode' | 'folder' | 'reveal',
    ): Promise<{ ok: true } | { ok: false; error: string }>
  }

  tools: {
    execute<K extends ToolName>(
      name: K,
      args: ToolArgs[K],
    ): Promise<ToolResult>
    onBashApprovalRequest(
      handler: (req: BashApprovalRequest) => void,
    ): () => void
    respondToBashApproval(approvalId: string, approved: boolean): void
  }

  skills: {
    list(activeProjectPath?: string): Promise<DiscoveredSkill[]>
    read(filePath: string): Promise<string>
    write(filePath: string, content: string): Promise<boolean>
  }

  terminal: {
    create(
      projectId: string,
      dimensions?: { cols?: number; rows?: number },
    ): Promise<TerminalCreateResult>
    write(sessionId: string, data: string): void
    resize(sessionId: string, cols: number, rows: number): void
    kill(sessionId: string): Promise<boolean>
    onData(handler: (event: TerminalDataEvent) => void): () => void
    onExit(handler: (event: TerminalExitEvent) => void): () => void
  }

  git: {
    exec(projectId: string, args: string[]): Promise<GitResult>
  }

  agentRuntime: {
    createThread(
      command: AgentRuntimeThreadCreateCommand,
    ): Promise<{ threadId: string; thread: ThreadState }>
    readThread(command: AgentRuntimeThreadReadCommand): Promise<ThreadState>
    readHistory(command: AgentRuntimeHistoryReadCommand): Promise<RuntimeEvent[]>
    startTurn(
      command: AgentRuntimeTurnStartCommand,
    ): Promise<{ turnId: string }>
    interruptTurn(command: AgentRuntimeTurnInterruptCommand): Promise<void>
    subscribe(
      command: AgentRuntimeSubscribeCommand,
      listener: (envelope: AgentRuntimeEventEnvelope) => void,
    ): Promise<() => void>
  }

  log(level: 'log' | 'warn' | 'error', args: unknown[]): void
  providerStream(payload: StreamStartPayload): ProviderStreamHandle
}
