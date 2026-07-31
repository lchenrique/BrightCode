import { invoke } from '@tauri-apps/api/core'
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

async function defaultProjectsDir(): Promise<string> {
  try {
    const home = await homeDir()
    return home ? `${home.replace(/[\\/]+$/, '')}/brightcode-projects` : ''
  } catch {
    return ''
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
// Mirrors `node-sidecar/handlers/thread-create.ts`. We can't
// import the real interface (different tsconfig), so this stays
// in sync by hand. ponytail: extract to a shared package once we
// have one.
export interface AgentRuntimeThreadState {
  threadId: string
  generation: number
  sequence: number
  idle: boolean
  // The full interface has more fields — listed as `unknown` so the
  // renderer doesn't accidentally depend on Phase 2-subsystem shape.
  [k: string]: unknown
}

export interface AgentRuntimeThreadCreateResponse {
  threadId: string
  thread: AgentRuntimeThreadState
}

/**
 * Phase 2 single command: create an Agent Runtime thread via the
 * Tauri→Rust→sidecar pipeline. Throws on non-Tauri contexts so
 * callers (renderer, tests) fail loudly instead of silently going
 * to the Electron path.
 */
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

export function installTauriBridge(): void {
  if (!isTauri()) return
  const w = window as unknown as {
    electronAPI?: { fs?: Record<string, unknown>; agentRuntime?: Record<string, unknown> }
  }
  const existing = w.electronAPI ?? {}
  const fs = (existing.fs ?? {}) as Record<string, unknown>
  const agentRuntime = (existing.agentRuntime ?? {}) as Record<string, unknown>
  w.electronAPI = {
    ...existing,
    fs: { ...fs, browse, defaultProjectsDir, createDir },
    agentRuntime: { ...agentRuntime, threadCreate: agentRuntimeThreadCreate },
  }
}

export const __bridge = {
  browse,
  defaultProjectsDir,
  createDir,
  agentRuntimeThreadCreate,
  isTauri,
}

