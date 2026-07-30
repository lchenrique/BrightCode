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

export function installTauriBridge(): void {
  if (!isTauri()) return
  const w = window as unknown as { electronAPI?: { fs?: Record<string, unknown> } }
  const existing = w.electronAPI ?? {}
  const fs = (existing.fs ?? {}) as Record<string, unknown>
  w.electronAPI = {
    ...existing,
    fs: { ...fs, browse, defaultProjectsDir, createDir },
  }
}

export const __bridge = { browse, defaultProjectsDir, createDir, isTauri }
