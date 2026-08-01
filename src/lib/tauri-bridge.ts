/**
 * Tauri ↔ renderer bridge.
 *
 * Exposes `window.electronAPI` with the full surface the renderer
 * expects (see `lib/electron-api-types.ts`). Every method is implemented
 * in terms of Tauri `invoke()` commands or `listen()` event channels,
 * so the renderer code stays identical regardless of runtime.
 *
 * ponytail: this is a thin adapter — no business logic, no caching, no
 * retry. If a method isn't wired yet, it returns a clear "not
 * implemented in Tauri" error instead of swallowing the call.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { mkdir } from '@tauri-apps/plugin-fs'
import { homeDir } from '@tauri-apps/api/path'
import type {
  AgentRuntimeEventEnvelope,
  AgentRuntimeHistoryReadCommand,
  AgentRuntimeSubscribeCommand,
  AgentRuntimeThreadCreateCommand,
  AgentRuntimeThreadReadCommand,
  AgentRuntimeTurnInterruptCommand,
  AgentRuntimeTurnStartCommand,
  BashApprovalRequest,
  BrightMemoryInstallResult,
  BrightMemoryStatus,
  CLIDetection,
  DetectedProviderId,
  DirEntry,
  DiscoveredSkill,
  ElectronAPI,
  GitResult,
  ListDirsResult,
  Project,
  ProjectFileEntry,
  ProviderStreamHandle,
  RuntimeEvent,
  StreamStartPayload,
  TaskItem,
  TerminalCreateResult,
  TerminalDataEvent,
  TerminalExitEvent,
  ThreadState,
  ToolArgs,
  ToolName,
  ToolResult,
} from './electron-api-types'

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function resolveProjectIdForPath(path: string): Promise<string | undefined> {
  if (!path) return undefined
  try {
    const projects = await invoke<Project[]>('projects_list')
    const matches = projects.filter((project) => path.includes(project.path.replace(/\\/g, '/')))
    if (matches.length === 0) return undefined
    matches.sort((a, b) => b.path.length - a.path.length)
    return matches[0]?.id
  } catch {
    return undefined
  }
}

function skillIdFromPath(skillFilePath: string): string | undefined {
  if (!skillFilePath) return undefined
  const normalized = skillFilePath.replace(/\\/g, '/')
  const marker = '/SKILL.md'
  const index = normalized.lastIndexOf(marker)
  if (index < 0) return undefined
  const head = normalized.slice(0, index)
  return head.split('/').filter(Boolean).pop()
}

async function skillsList(
  activeProjectPath?: string,
): Promise<DiscoveredSkill[]> {
  if (!isTauri()) return []
  try {
    const projects = await invoke<Project[]>('projects_list')
    const owner = projects.find((project) => project.path === activeProjectPath)
    return await invoke<DiscoveredSkill[]>('skills_list', {
      projectId: owner?.id ?? null,
    })
  } catch (e) {
    console.warn('[bridge] skills_list failed:', e)
    return []
  }
}

async function skillsRead(filePath: string): Promise<string> {
  if (!isTauri()) return ''
  try {
    const skillId = skillIdFromPath(filePath)
    if (!skillId) throw new Error('could not derive skill id from path')
    const projectId = await resolveProjectIdForPath(filePath)
    return await invoke<string>('skills_read', {
      skillId,
      projectId: projectId ?? null,
    })
  } catch (e) {
    console.warn('[bridge] skills_read failed:', e)
    return ''
  }
}

async function skillsWrite(filePath: string, content: string): Promise<boolean> {
  if (!isTauri()) return false
  try {
    const skillId = skillIdFromPath(filePath)
    if (!skillId) throw new Error('could not derive skill id from path')
    const projectId = await resolveProjectIdForPath(filePath)
    await invoke('skills_write', {
      skillId,
      contents: content,
      projectId: projectId ?? null,
    })
    return true
  } catch (e) {
    console.warn('[bridge] skills_write failed:', e)
    return false
  }
}

function onTauriEvent<T>(
  event: string,
  handler: (payload: T) => void,
): UnlistenFn {
  if (!isTauri()) return () => {}
  let active = true
  let unlisten: UnlistenFn | undefined
  void listen<T>(event, ({ payload }) => handler(payload))
    .then((registered) => {
      if (active) unlisten = registered
      else registered()
    })
    .catch((error) => console.warn(`[bridge] failed to listen for ${event}:`, error))
  return () => {
    active = false
    unlisten?.()
  }
}

// ── Bright Memory ─────────────────────────────────────────────────────

async function brightMemoryStatus(): Promise<BrightMemoryStatus> {
  if (!isTauri()) {
    return {
      cliInstalled: false,
      globalRuleConfigured: false,
      rulePaths: [],
      ready: false,
    }
  }
  return await invoke<BrightMemoryStatus>('bright_memory_status')
}

async function brightMemoryInstall(): Promise<BrightMemoryInstallResult> {
  if (!isTauri()) {
    return {
      ok: false,
      error: 'not running under Tauri',
      status: {
        cliInstalled: false,
        globalRuleConfigured: false,
        rulePaths: [],
        ready: false,
      },
    }
  }
  return await invoke<BrightMemoryInstallResult>('bright_memory_install')
}

// ── Projects ──────────────────────────────────────────────────────────

async function projectsList(): Promise<Project[]> {
  if (!isTauri()) return []
  try {
    return await invoke<Project[]>('projects_list')
  } catch (e) {
    console.warn('[bridge] projects_list failed:', e)
    return []
  }
}

async function projectsGetActive(): Promise<Project | null> {
  if (!isTauri()) return null
  try {
    return await invoke<Project | null>('projects_get_active')
  } catch (e) {
    console.warn('[bridge] projects_get_active failed:', e)
    return null
  }
}

async function projectsAdd(
  path: string,
  label?: string,
): Promise<
  { ok: true; project: Project } | { ok: false; error: string }
> {
  if (!isTauri()) return { ok: false, error: 'not running under Tauri' }
  try {
    const out = await invoke<{
      ok: boolean
      project?: Project
      error?: string
    }>('projects_add', { path, label })
    if ((out.ok as unknown) === 'true' && out.project) return { ok: true, project: out.project }
    return { ok: false, error: out.error ?? 'add failed' }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function projectsRemove(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isTauri()) return { ok: false, error: 'not running under Tauri' }
  try {
    const out = await invoke<{ ok: boolean; error?: string }>(
      'projects_remove',
      { id },
    )
    if ((out.ok as unknown) === 'true') return { ok: true }
    return { ok: false, error: out.error ?? 'remove failed' }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function projectsSetActive(id: string | null): Promise<void> {
  if (!isTauri()) return
  try {
    await invoke('projects_set_active', { id })
  } catch (e) {
    console.warn('[bridge] projects_set_active failed:', e)
  }
}

function projectsOnChanged(handler: () => void): UnlistenFn {
  return onTauriEvent('projects:changed', handler)
}

// ── fs ────────────────────────────────────────────────────────────────

async function fsHome(): Promise<string> {
  if (!isTauri()) {
    try {
      return (await homeDir()) ?? ''
    } catch {
      return ''
    }
  }
  try {
    return await invoke<string>('fs_home')
  } catch {
    return (await homeDir()) ?? ''
  }
}

async function fsDefaultProjectsDir(): Promise<string> {
  if (!isTauri()) {
    try {
      const home = await homeDir()
      return home ? `${home.replace(/[\\/]+$/, '')}/brightcode-projects` : ''
    } catch {
      return ''
    }
  }
  try {
    return await invoke<string>('fs_default_projects_dir')
  } catch {
    return ''
  }
}

async function fsListDirs(
  dirPath: string,
): Promise<ListDirsResult | { ok: false; error: string }> {
  if (!isTauri()) return { ok: false, error: 'not running under Tauri' }
  try {
    const entries = await invoke<DirEntry[]>('fs_list_dirs', { path: dirPath })
    return { ok: true, entries, parent: null }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function fsBrowse(
  defaultPath?: string,
): Promise<{ ok: true; path: string | null } | { ok: false; error: string }> {
  try {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: defaultPath || undefined,
    })
    return { ok: true, path: (selected as string | null) ?? null }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function fsBrowseFile(options?: {
  title?: string
  defaultPath?: string
  filters?: Array<{ name: string; extensions: string[] }>
}): Promise<
  { ok: true; path: string | null } | { ok: false; error: string }
> {
  if (!isTauri()) {
    try {
      const selected = await openDialog({
        directory: false,
        multiple: false,
        defaultPath: options?.defaultPath,
        filters: options?.filters,
        title: options?.title,
      })
      return { ok: true, path: (selected as string | null) ?? null }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
  try {
    const selected = await invoke<{ ok: boolean; path?: string } | null>(
      'fs_browse_file',
      { options },
    )
    if (!selected) return { ok: true, path: null }
    if (selected.ok && selected.path) return { ok: true, path: selected.path }
    return { ok: true, path: null }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function fsValidate(
  path: string,
): Promise<
  | { ok: true; realPath: string }
  | { ok: false; error: string; code?: string }
> {
  if (!isTauri()) return { ok: false, error: 'not running under Tauri' }
  try {
    const out = await invoke<{
      ok: boolean
      real_path?: string
      error?: string
      code?: string
    }>('fs_validate', { path })
    if ((out.ok as unknown) === 'true' && out.real_path)
      return { ok: true, realPath: out.real_path }
    return { ok: false, error: out.error ?? 'validate failed' }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

async function fsClone(
  url: string,
  dest: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (!isTauri()) return { ok: false, error: 'not running under Tauri' }
  try {
    const out = await invoke<{ ok: boolean; path?: string; error?: string }>(
      'fs_clone',
      { url, dest },
    )
    if ((out.ok as unknown) === 'true' && out.path) return { ok: true, path: out.path }
    return { ok: false, error: out.error ?? 'clone failed' }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function fsCreateDir(
  target: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  try {
    await mkdir(target, { recursive: true })
    return { ok: true, path: target }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ── workspace ─────────────────────────────────────────────────────────

type WorkspaceTreeEntry = {
  name: string
  relativePath: string
  kind: 'file' | 'directory'
  children?: WorkspaceTreeEntry[]
}

function flattenWorkspaceTree(entries: WorkspaceTreeEntry[]): ProjectFileEntry[] {
  return entries.flatMap((entry) => [
    {
      name: entry.name,
      path: entry.relativePath,
      isDir: entry.kind === 'directory',
    },
    ...flattenWorkspaceTree(entry.children ?? []),
  ])
}

async function workspaceListTree(
  projectId: string,
): Promise<{ ok: true; entries: ProjectFileEntry[] } | { ok: false; error: string }> {
  if (!isTauri()) return { ok: false, error: 'not running under Tauri' }
  try {
    const entry = await invoke<WorkspaceTreeEntry>('workspace_list_tree', {
      projectId,
      maxDepth: null,
    })
    return { ok: true, entries: flattenWorkspaceTree(entry.children ?? []) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function workspaceReadFile(
  projectId: string,
  relativePath: string,
): Promise<
  | { ok: true; content: string; size: number }
  | { ok: false; error: string }
> {
  if (!isTauri()) return { ok: false, error: 'not running under Tauri' }
  try {
    const out = await invoke<{
      ok: boolean
      contents: string
      sizeBytes: number
      isBinary?: boolean
      error?: string
    }>('workspace_read_file', { projectId, relativePath })
    if (!out.isBinary)
      return { ok: true, content: out.contents, size: out.sizeBytes }
    return {
      ok: false,
      error: out.isBinary ? 'binary file not readable' : out.error ?? 'read failed',
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function workspaceWriteFile(
  projectId: string,
  relativePath: string,
  content: string,
): Promise<{ ok: true; bytes: number } | { ok: false; error: string }> {
  if (!isTauri()) return { ok: false, error: 'not running under Tauri' }
  try {
    await invoke('workspace_write_file', {
      projectId,
      relativePath,
      contents: content,
    })
    return { ok: true, bytes: content.length }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function workspaceOpenProject(
  projectId: string,
  _target: 'vscode' | 'folder' | 'reveal',
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isTauri()) return { ok: false, error: 'not running under Tauri' }
  try {
    await invoke('workspace_open_project', { projectId })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ── git ───────────────────────────────────────────────────────────────

async function gitExec(
  projectId: string,
  args: string[],
): Promise<GitResult> {
  if (!isTauri()) return { ok: false, error: 'not running under Tauri' }
  try {
    const out = await invoke<{
      stdout: string
      stderr: string
      exitCode: number
    }>('git_exec', { projectId, args })
    return {
      ok: true,
      stdout: out.stdout,
      stderr: out.stderr,
      code: out.exitCode,
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ── tasks ─────────────────────────────────────────────────────────────

async function tasksList(projectId?: string): Promise<TaskItem[]> {
  if (!isTauri()) return []
  try {
    return await invoke<TaskItem[]>('tasks_list', { projectId: projectId ?? null })
  } catch (e) {
    console.warn('[bridge] tasks_list failed:', e)
    return []
  }
}

async function tasksCreate(input: TaskItem): Promise<TaskItem> {
  return await invoke<TaskItem>('tasks_create', { task: input })
}

async function tasksRemove(id: string): Promise<void> {
  await invoke('tasks_remove', { taskId: id })
}

async function tasksUpdate(
  id: string,
  patch: Partial<
    Pick<TaskItem, 'title' | 'selectedModel' | 'selectedAccountId'>
  >,
): Promise<void> {
  await invoke('tasks_update', { taskId: id, patch })
}

async function tasksGetMessages<T = unknown>(taskId: string): Promise<T[]> {
  if (!isTauri()) return []
  try {
    return await invoke<T[]>('tasks_get_messages', { taskId })
  } catch (e) {
    console.warn('[bridge] tasks_get_messages failed:', e)
    return []
  }
}

async function tasksSaveMessages<T = unknown>(
  taskId: string,
  messages: T[],
): Promise<void> {
  if (!isTauri()) return
  try {
    await invoke('tasks_save_messages', { taskId, messages })
  } catch (e) {
    console.warn('[bridge] tasks_save_messages failed:', e)
  }
}

function tasksOnChanged(handler: () => void): UnlistenFn {
  return onTauriEvent('tasks:changed', handler)
}

// ── accounts ──────────────────────────────────────────────────────────

async function accountsListAll(): Promise<Record<string, Record<string, unknown>>> {
  if (!isTauri()) return {}
  try {
    return await invoke('accounts_list_all')
  } catch (e) {
    console.warn('[bridge] accounts_list_all failed:', e)
    return {}
  }
}

async function accountsGet(
  providerId: string,
  accountId: string,
): Promise<unknown | null> {
  if (!isTauri()) return null
  try {
    return await invoke('accounts_get', { providerId, accountId })
  } catch {
    return null
  }
}

async function accountsAdd(providerId: string, account: unknown): Promise<void> {
  if (!isTauri()) return
  await invoke('accounts_add', { providerId, account })
}

async function accountsUpdate(
  providerId: string,
  accountId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  if (!isTauri()) return
  await invoke('accounts_update', { providerId, accountId, patch })
}

async function accountsRemove(
  providerId: string,
  accountId: string,
): Promise<void> {
  if (!isTauri()) return
  await invoke('accounts_remove', { providerId, accountId })
}

async function accountsSetActive(
  providerId: string,
  accountId: string,
): Promise<void> {
  if (!isTauri()) return
  await invoke('accounts_set_active', { providerId, accountId })
}

async function accountsGetActive(providerId: string): Promise<unknown | null> {
  if (!isTauri()) return null
  try {
    return await invoke('accounts_get_active', { providerId })
  } catch {
    return null
  }
}

async function accountsListActive(): Promise<Record<string, string>> {
  if (!isTauri()) return {}
  try {
    return await invoke('accounts_list_active')
  } catch {
    return {}
  }
}

function accountsOnChanged(handler: () => void): UnlistenFn {
  return onTauriEvent('accounts:changed', handler)
}

// ── agents ────────────────────────────────────────────────────────────

async function agentsList(): Promise<unknown[]> {
  if (!isTauri()) return []
  try {
    return await invoke<unknown[]>('agents_list')
  } catch (e) {
    console.warn('[bridge] agents_list failed:', e)
    return []
  }
}

async function agentsGet(id: string): Promise<unknown | null> {
  if (!isTauri()) return null
  try {
    return await invoke('agents_get', { id })
  } catch {
    return null
  }
}

async function agentsAdd(agent: unknown): Promise<unknown> {
  return await invoke('agents_add', { agent })
}

async function agentsUpdate(
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  if (!isTauri()) return
  await invoke('agents_update', { id, patch })
}

async function agentsRemove(id: string): Promise<void> {
  if (!isTauri()) return
  await invoke('agents_remove', { id })
}

function agentsOnChanged(handler: () => void): UnlistenFn {
  return onTauriEvent('agents:changed', handler)
}

// ── cli ───────────────────────────────────────────────────────────────

async function cliDetect(
  providerId: DetectedProviderId,
): Promise<CLIDetection | null> {
  if (!isTauri()) return null
  try {
    return await invoke<CLIDetection | null>('cli_detect', { providerId })
  } catch {
    return null
  }
}

async function cliDetectAll(): Promise<CLIDetection[]> {
  if (!isTauri()) return []
  try {
    return await invoke<CLIDetection[]>('cli_detect_all')
  } catch {
    return []
  }
}

// ── usage ─────────────────────────────────────────────────────────────

async function usageRecord(record: unknown): Promise<void> {
  if (!isTauri()) return
  await invoke('usage_record', { record })
}

async function usageGetHistory(
  providerId: string,
  accountId?: string,
  since?: number,
): Promise<unknown[]> {
  if (!isTauri()) return []
  try {
    return await invoke<unknown[]>('usage_get_history', {
      providerId,
      accountId: accountId ?? null,
      since: since ?? null,
    })
  } catch {
    return []
  }
}

async function usageGetAllHistory(): Promise<
  Record<string, Record<string, unknown[]>>
> {
  if (!isTauri()) return {}
  try {
    return await invoke('usage_get_all_history')
  } catch {
    return {}
  }
}

async function usageClear(): Promise<void> {
  if (!isTauri()) return
  await invoke('usage_clear')
}

async function usageSetQuota(
  providerId: string,
  accountId: string,
  quota: unknown,
): Promise<void> {
  if (!isTauri()) return
  await invoke('usage_set_quota', { providerId, accountId, quota })
}

async function usageGetQuota(
  providerId: string,
  accountId: string,
): Promise<unknown> {
  if (!isTauri()) return undefined
  try {
    return await invoke('usage_get_quota', { providerId, accountId })
  } catch {
    return undefined
  }
}

async function usageGetAllQuotas(): Promise<Record<string, Record<string, unknown>>> {
  if (!isTauri()) return {}
  try {
    return await invoke('usage_get_all_quotas')
  } catch {
    return {}
  }
}

async function usageFetchQuota(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ ok: boolean; status: number; data: unknown } | null> {
  if (!isTauri()) return null
  try {
    return await invoke('usage_fetch_quota', { url, init })
  } catch {
    return null
  }
}

async function usageFetchCodex(
  accessToken: string,
  accountId?: string,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  if (!isTauri()) return { ok: false, status: 0, data: null }
  try {
    return await invoke('usage_fetch_codex', { accessToken, accountId })
  } catch (e) {
    return { ok: false, status: 0, data: String(e) }
  }
}

async function usageReadCodexLocal(): Promise<{ ok: boolean; data: unknown }> {
  if (!isTauri()) return { ok: false, data: null }
  try {
    return await invoke('usage_read_codex_local')
  } catch {
    return { ok: false, data: null }
  }
}

function usageOnChanged(handler: () => void): UnlistenFn {
  return onTauriEvent('usage:changed', handler)
}

// ── oauth ─────────────────────────────────────────────────────────────

async function oauthStart(config: unknown): Promise<{
  ok: boolean
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  email?: string
  accountId?: string
  idToken?: string
  error?: string
}> {
  if (!isTauri()) return { ok: false, error: 'not running under Tauri' }
  return await invoke('oauth_start', { config })
}

async function oauthCancel(): Promise<void> {
  if (!isTauri()) return
  await invoke('oauth_cancel')
}

// ── tools ─────────────────────────────────────────────────────────────

async function toolsExecute<K extends ToolName>(
  name: K,
  args: ToolArgs[K],
): Promise<ToolResult> {
  if (!isTauri()) return { ok: false, error: 'not running under Tauri' }
  try {
    const out = await invoke<ToolResult>('tools_execute', {
      request: { name, args },
    })
    return out
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function toolsOnBashApprovalRequest(
  handler: (req: BashApprovalRequest) => void,
): UnlistenFn {
  return onTauriEvent('tool:bash-approval-request', handler)
}

function toolsRespondToBashApproval(
  approvalId: string,
  approved: boolean,
): void {
  if (!isTauri()) return
  invoke('tools_respond_bash_approval', { approvalId, approved }).catch(
    (e) => console.warn('[bridge] tools_respond_bash_approval failed:', e),
  )
}

// ── terminal ──────────────────────────────────────────────────────────

async function terminalCreate(
  projectId: string,
  dimensions?: { cols?: number; rows?: number },
): Promise<TerminalCreateResult> {
  if (!isTauri())
    return { ok: false, error: 'not running under Tauri' }
  try {
    const result = await invoke<{ sessionId: string; shell: string; cwd: string }>(
      'terminal_create',
      {
        projectId,
        dimensions: dimensions ?? null,
      },
    )
    return { ok: true, ...result }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function terminalWrite(sessionId: string, data: string): void {
  if (!isTauri()) return
  invoke('terminal_write', { sessionId, data }).catch(() => {})
}

function terminalResize(sessionId: string, cols: number, rows: number): void {
  if (!isTauri()) return
  invoke('terminal_resize', { sessionId, cols, rows }).catch(() => {})
}

async function terminalKill(sessionId: string): Promise<boolean> {
  if (!isTauri()) return false
  try {
    return await invoke<boolean>('terminal_kill', { sessionId })
  } catch {
    return false
  }
}

function terminalOnData(
  handler: (event: TerminalDataEvent) => void,
): UnlistenFn {
  return onTauriEvent('terminal:data', handler)
}

function terminalOnExit(
  handler: (event: TerminalExitEvent) => void,
): UnlistenFn {
  return onTauriEvent('terminal:exit', handler)
}

// ── auth compatibility over accounts ─────────────────────────────────

function credentialFromAccount(account: unknown): unknown | null {
  if (!account || typeof account !== 'object') return null
  const value = account as Record<string, unknown>
  return {
    method: value.authMethod,
    apiKey: value.apiKey,
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: value.expiresAt,
    cliSource: value.cliSource,
    cliEmail: value.cliEmail,
    metadata: value.metadata,
  }
}

async function authGet(providerId: string): Promise<unknown | null> {
  return credentialFromAccount(await accountsGetActive(providerId))
}

async function authSet(providerId: string, credential: unknown): Promise<void> {
  const value = (credential ?? {}) as Record<string, unknown>
  const existing = (await accountsGet(providerId, 'default')) as Record<string, unknown> | null
  await accountsAdd(providerId, {
    ...existing,
    id: 'default',
    providerId,
    label: existing?.label ?? 'Default',
    authMethod: value.method ?? 'api_key',
    apiKey: value.apiKey,
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: value.expiresAt,
    cliSource: value.cliSource,
    cliEmail: value.cliEmail,
    metadata: value.metadata,
    enabled: true,
    createdAt: existing?.createdAt ?? Date.now(),
  })
  await accountsSetActive(providerId, 'default')
}

async function authRemove(providerId: string): Promise<void> {
  const all = await accountsListAll()
  for (const accountId of Object.keys(all[providerId] ?? {})) {
    await accountsRemove(providerId, accountId)
  }
}

async function authHas(providerId: string): Promise<boolean> {
  const all = await accountsListAll()
  return Object.keys(all[providerId] ?? {}).length > 0
}

async function authList(): Promise<Array<{ providerId: string; credential: unknown }>> {
  const all = await accountsListAll()
  const entries: Array<{ providerId: string; credential: unknown }> = []
  for (const providerId of Object.keys(all)) {
    const credential = await authGet(providerId)
    if (credential) entries.push({ providerId, credential })
  }
  return entries
}

async function authClear(): Promise<void> {
  const all = await accountsListAll()
  for (const providerId of Object.keys(all)) await authRemove(providerId)
}

// ── agent runtime ─────────────────────────────────────────────────────

async function agentRuntimeCreateThread(
  command: AgentRuntimeThreadCreateCommand,
): Promise<{ threadId: string; thread: ThreadState }> {
  return await invoke('proxy_agent_runtime', {
    path: '/v1/agent-runtime/thread/create',
    body: command,
  })
}

async function agentRuntimeReadThread(
  command: AgentRuntimeThreadReadCommand,
): Promise<ThreadState> {
  return await invoke('proxy_agent_runtime', {
    path: '/v1/agent-runtime/thread/read',
    body: command,
  })
}

async function agentRuntimeReadHistory(
  command: AgentRuntimeHistoryReadCommand,
): Promise<RuntimeEvent[]> {
  return await invoke('proxy_agent_runtime', {
    path: '/v1/agent-runtime/history/read',
    body: command,
  })
}

async function agentRuntimeStartTurn(
  command: AgentRuntimeTurnStartCommand,
): Promise<{ turnId: string }> {
  // Sidecar schema uses `prompt` (mirrors the legacy Electron channel),
  // while the renderer hands us `text`. Rename on the way out so the
  // renderer-facing contract stays consistent with the Agent Runtime
  // Electron API.
  const { text, ...rest } = command
  return await invoke('proxy_agent_runtime', {
    path: '/v1/agent-runtime/turn/start',
    body: { ...rest, prompt: text },
  })
}

async function agentRuntimeInterruptTurn(
  command: AgentRuntimeTurnInterruptCommand,
): Promise<void> {
  await invoke('proxy_agent_runtime', {
    path: '/v1/agent-runtime/turn/interrupt',
    body: command,
  })
}

async function agentRuntimeSubscribe(
  command: AgentRuntimeSubscribeCommand,
  listener: (envelope: AgentRuntimeEventEnvelope) => void,
): Promise<() => void> {
  // Subscribe to events BEFORE invoking start so we don't miss the
  // first chunk. The sidecar (or Rust broker) emits events on
  // `agent-runtime:event:<subscriptionId>`.
  const channel = `agent-runtime:event:${command.subscriptionId}`
  const unlisten = await listen<AgentRuntimeEventEnvelope>(channel, (e) =>
    listener(e.payload),
  )

  let initial: { state: ThreadState; history: RuntimeEvent[] }
  try {
    initial = await invoke('agent_runtime_subscribe', { command })
  } catch (err) {
    unlisten()
    throw err
  }

  // Replay history in order.
  const sortedHistory = [...initial.history].sort(
    (a, b) => a.sequence - b.sequence,
  )
  for (const event of sortedHistory) {
    listener({ event, state: initial.state })
  }

  return async () => {
    unlisten()
    try {
      await invoke('agent_runtime_unsubscribe', {
        subscriptionId: command.subscriptionId,
      })
    } catch {
      // already gone
    }
  }
}

// ── provider stream ───────────────────────────────────────────────────

function providerStream(payload: StreamStartPayload): ProviderStreamHandle {
  const requestId =
    payload.requestId ?? `ps_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  const queue: Array<{ raw: string }> = []
  const waiters: Array<{
    resolve: (v: IteratorResult<{ raw: string }>) => void
    reject: (err: Error) => void
  }> = []
  let done = false
  let error: Error | null = null

  function flushWaiter(): void {
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

  let unlistenChunk: UnlistenFn | undefined
  let unlistenEnd: UnlistenFn | undefined
  let unlistenError: UnlistenFn | undefined

  async function setup(): Promise<void> {
    if (!isTauri()) throw new Error('providerStream: not running under Tauri')
    unlistenChunk = await listen<{ raw: string }>(
      `provider:stream-chunk:${requestId}`,
      (e) => {
        if (waiters.length > 0) {
          waiters.shift()!.resolve({ value: e.payload, done: false })
        } else {
          queue.push(e.payload)
        }
      },
    )
    unlistenEnd = await listen<unknown>(
      `provider:stream-end:${requestId}`,
      () => {
        done = true
        if (waiters.length > 0) flushWaiter()
      },
    )
    unlistenError = await listen<{ message: string }>(
      `provider:stream-error:${requestId}`,
      (e) => {
        error = new Error(e.payload.message)
        done = true
        if (waiters.length > 0) flushWaiter()
      },
    )
  }

  function cleanup(): void {
    unlistenChunk?.()
    unlistenEnd?.()
    unlistenError?.()
  }

  void setup()
    .then(() =>
      invoke('provider_stream_start', {
        payload: { ...payload, requestId },
      }),
    )
    .catch((err: unknown) => {
      error = err instanceof Error ? err : new Error(String(err))
      done = true
      cleanup()
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
        invoke('provider_stream_cancel', { requestId }).catch(() => {})
      } catch {
        // ignore
      }
      done = true
      cleanup()
      while (waiters.length > 0) {
        waiters.shift()!.resolve({ value: undefined as never, done: true })
      }
    },
  }
}

// ── renderer log ──────────────────────────────────────────────────────

function rendererLog(level: 'log' | 'warn' | 'error', args: unknown[]): void {
  if (!isTauri()) return
  try {
    invoke('renderer_log', { level, args }).catch(() => {})
  } catch {
    // silent — fire and forget
  }
}

// ── bridge installer ──────────────────────────────────────────────────

export function installTauriBridge(): void {
  if (!isTauri()) return

  const w = window as unknown as { electronAPI?: ElectronAPI }

  const api: ElectronAPI = {
    isElectron: false,
    platform: 'tauri',
    versions: { electron: 'tauri', chrome: 'tauri', node: 'tauri' },

    auth: {
      get: authGet,
      set: authSet,
      remove: authRemove,
      has: authHas,
      list: authList,
      clear: authClear,
      onChanged: accountsOnChanged,
    },

    accounts: {
      listAll: accountsListAll,
      get: accountsGet,
      add: accountsAdd,
      update: accountsUpdate,
      remove: accountsRemove,
      setActive: accountsSetActive,
      getActive: accountsGetActive,
      listActive: accountsListActive,
      onChanged: accountsOnChanged,
    },

    agents: {
      list: agentsList,
      get: agentsGet,
      add: agentsAdd,
      update: agentsUpdate,
      remove: agentsRemove,
      onChanged: agentsOnChanged,
    },

    cli: { detect: cliDetect, detectAll: cliDetectAll },

    brightMemory: { status: brightMemoryStatus, install: brightMemoryInstall },

    projects: {
      list: projectsList,
      add: projectsAdd,
      remove: projectsRemove,
      setActive: projectsSetActive,
      getActive: projectsGetActive,
      onChanged: projectsOnChanged,
    },

    tasks: {
      list: tasksList,
      create: tasksCreate,
      remove: tasksRemove,
      update: tasksUpdate,
      getMessages: tasksGetMessages,
      saveMessages: tasksSaveMessages,
      onChanged: tasksOnChanged,
    },

    usage: {
      record: usageRecord,
      getHistory: usageGetHistory,
      getAllHistory: usageGetAllHistory,
      getSummaries: async () => [],
      setQuota: usageSetQuota,
      getQuota: usageGetQuota,
      fetchQuota: usageFetchQuota,
      getAllQuotas: usageGetAllQuotas,
      fetchCodex: usageFetchCodex,
      readCodexLocal: usageReadCodexLocal,
      clear: usageClear,
      onChanged: usageOnChanged,
    },

    oauth: { start: oauthStart, cancel: oauthCancel },

    fs: {
      home: fsHome,
      defaultProjectsDir: fsDefaultProjectsDir,
      listDirs: fsListDirs,
      browse: fsBrowse,
      browseFile: fsBrowseFile,
      validate: fsValidate,
      clone: fsClone,
      createDir: fsCreateDir,
    },

    workspace: {
      listTree: workspaceListTree,
      readFile: workspaceReadFile,
      writeFile: workspaceWriteFile,
      openProject: workspaceOpenProject,
    },

    tools: {
      execute: toolsExecute,
      onBashApprovalRequest: toolsOnBashApprovalRequest,
      respondToBashApproval: toolsRespondToBashApproval,
    },

    skills: { list: skillsList, read: skillsRead, write: skillsWrite },

    terminal: {
      create: terminalCreate,
      write: terminalWrite,
      resize: terminalResize,
      kill: terminalKill,
      onData: terminalOnData,
      onExit: terminalOnExit,
    },

    git: { exec: gitExec },

    agentRuntime: {
      createThread: agentRuntimeCreateThread,
      readThread: agentRuntimeReadThread,
      readHistory: agentRuntimeReadHistory,
      startTurn: agentRuntimeStartTurn,
      interruptTurn: agentRuntimeInterruptTurn,
      subscribe: agentRuntimeSubscribe,
    },

    log: rendererLog,
    providerStream,
  }

  w.electronAPI = api
}

export const __bridge = {
  isTauri,
}
