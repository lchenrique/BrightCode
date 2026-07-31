import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { mkdir } from '@tauri-apps/plugin-fs'
import { homeDir } from '@tauri-apps/api/path'

type FsOk<T> = { ok: true; [k: string]: unknown } & T
type FsErr = { ok: false; error: string }
type FsResult = FsOk<{ path: string | null }> | FsErr

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function browse(defaultPath?: string): Promise<FsResult> {
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

async function browseFile(): Promise<FsResult> {
  try {
    const selected = await invoke<{ ok: boolean; path?: string } | null>(
      'fs_browse_file',
    )
    if (!selected) return { ok: true, path: null }
    if (selected.ok && selected.path) return { ok: true, path: selected.path }
    return { ok: true, path: null }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function defaultProjectsDir(): Promise<string> {
  try {
    return await invoke<string>('fs_default_projects_dir')
  } catch {
    try {
      const home = await homeDir()
      return home ? `${home.replace(/[\\/]+$/, '')}/brightcode-projects` : ''
    } catch {
      return ''
    }
  }
}

async function home(): Promise<string> {
  try {
    return await invoke<string>('fs_home')
  } catch {
    try {
      return (await homeDir()) ?? ''
    } catch {
      return ''
    }
  }
}

async function listDirs(path: string): Promise<
  | { ok: true; entries: Array<{ name: string; path: string }> }
  | { ok: false; error: string }
> {
  try {
    const entries = await invoke<Array<{ name: string; path: string }>>(
      'fs_list_dirs',
      { path },
    )
    return { ok: true, entries }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function validate(path: string): Promise<
  | { ok: true; exists: boolean; isDir: boolean; isFile: boolean }
  | { ok: false; error: string }
> {
  try {
    const out = await invoke<{
      ok: boolean
      exists?: boolean
      is_dir?: boolean
      is_file?: boolean
      error?: string
    }>('fs_validate', { path })
    if (!out.ok) return { ok: false, error: out.error ?? 'validate failed' }
    return {
      ok: true,
      exists: out.exists ?? false,
      isDir: out.is_dir ?? false,
      isFile: out.is_file ?? false,
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function cloneRepo(
  url: string,
  dest: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  try {
    const out = await invoke<{ ok: boolean; path?: string; error?: string }>(
      'fs_clone',
      { url, dest },
    )
    if (out.ok && out.path) return { ok: true, path: out.path }
    return { ok: false, error: out.error ?? 'clone failed' }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function createDir(target: string): Promise<{ ok: true; path: string } | FsErr> {
  try {
    await mkdir(target, { recursive: true })
    return { ok: true, path: target }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Minimal ThreadState subset returned by `proxy_agent_runtime`.
export interface AgentRuntimeThreadState {
  threadId: string
  generation: number
  sequence: number
  idle: boolean
  [k: string]: unknown
}

export interface AgentRuntimeThreadCreateResponse {
  threadId: string
  thread: AgentRuntimeThreadState
}

async function agentRuntimeThreadCreate(
  input: { threadId?: string } = {},
): Promise<AgentRuntimeThreadCreateResponse> {
  if (!isTauri()) {
    throw new Error('agentRuntimeThreadCreate: not running under Tauri')
  }
  return await invoke('proxy_agent_runtime', {
    path: '/v1/agent-runtime/thread/create',
    body: input,
  })
}

// ── Projects ────────────────────────────────────────────────────────────

export interface ProjectRecord {
  id: string
  label: string
  path: string
  createdAt: number
}

async function projectsList(): Promise<ProjectRecord[]> {
  if (!isTauri()) return []
  try {
    return await invoke<ProjectRecord[]>('projects_list')
  } catch (e) {
    console.warn('[bridge] projects_list failed:', e)
    return []
  }
}

async function projectsGetActive(): Promise<ProjectRecord | null> {
  if (!isTauri()) return null
  try {
    return await invoke<ProjectRecord | null>('projects_get_active')
  } catch (e) {
    console.warn('[bridge] projects_get_active failed:', e)
    return null
  }
}

async function projectsAdd(
  path: string,
  label?: string,
): Promise<
  | { ok: true; project: ProjectRecord }
  | { ok: false; error: string }
> {
  if (!isTauri()) return { ok: false, error: 'not running under Tauri' }
  try {
    const out = await invoke<{
      ok: boolean
      project?: ProjectRecord
      error?: string
    }>('projects_add', { path, label })
    if (out.ok && out.project) return { ok: true, project: out.project }
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
    if (out.ok) return { ok: true }
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

async function projectsOnChanged(handler: () => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {}
  const unlisten = await listen('projects:changed', () => handler())
  return unlisten
}

// ── Bright Memory ──────────────────────────────────────────────────────

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

async function brightMemoryStatus(): Promise<BrightMemoryStatus> {
  if (!isTauri()) {
    return {
      cliInstalled: false,
      globalRuleConfigured: false,
      rulePaths: [],
      ready: false,
    }
  }
  try {
    return await invoke<BrightMemoryStatus>('bright_memory_status')
  } catch (e) {
    console.warn('[bridge] bright_memory_status failed:', e)
    return {
      cliInstalled: false,
      globalRuleConfigured: false,
      rulePaths: [],
      ready: false,
    }
  }
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
  try {
    return await invoke<BrightMemoryInstallResult>('bright_memory_install')
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      error,
      status: {
        cliInstalled: false,
        globalRuleConfigured: false,
        rulePaths: [],
        ready: false,
      },
    }
  }
}

export function installTauriBridge(): void {
  if (!isTauri()) return
  const w = window as unknown as {
    electronAPI?: {
      fs?: Record<string, unknown>
      agentRuntime?: Record<string, unknown>
      projects?: Record<string, unknown>
      brightMemory?: Record<string, unknown>
    }
  }
  const existing = w.electronAPI ?? {}
  const fs = (existing.fs ?? {}) as Record<string, unknown>
  const agentRuntime = (existing.agentRuntime ?? {}) as Record<string, unknown>
  const projects = (existing.projects ?? {}) as Record<string, unknown>
  const brightMemory = (existing.brightMemory ?? {}) as Record<string, unknown>
  w.electronAPI = {
    ...existing,
    fs: {
      ...fs,
      browse,
      browseFile,
      home,
      defaultProjectsDir,
      listDirs,
      validate,
      cloneRepo,
      createDir,
    },
    agentRuntime: { ...agentRuntime, threadCreate: agentRuntimeThreadCreate },
    projects: {
      ...projects,
      list: projectsList,
      getActive: projectsGetActive,
      add: projectsAdd,
      remove: projectsRemove,
      setActive: projectsSetActive,
      onChanged: projectsOnChanged,
    },
    brightMemory: {
      ...brightMemory,
      status: brightMemoryStatus,
      install: brightMemoryInstall,
    },
  }
}

export const __bridge = {
  browse,
  browseFile,
  home,
  defaultProjectsDir,
  listDirs,
  validate,
  cloneRepo,
  createDir,
  projectsList,
  projectsGetActive,
  projectsAdd,
  projectsRemove,
  projectsSetActive,
  projectsOnChanged,
  brightMemoryStatus,
  brightMemoryInstall,
  agentRuntimeThreadCreate,
  isTauri,
}
