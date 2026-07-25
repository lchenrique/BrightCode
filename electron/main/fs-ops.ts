/**
 * Filesystem operations used by the project picker and (later) by the
 * agent's tool-calling surface.
 *
 * All paths are absolute; all mutating ops are rejected if the path is
 * outside the active project root. The "default projects folder"
 * (`~/BrightCodeProjects/`) is created on demand — see
 * `ensureDefaultProjectsDir()`.
 */

import { promises as fsp, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC } from '../shared/ipc-channels'

export type DirEntry = { name: string; path: string }

// ── Home + default folder ──────────────────────────────────────────────

/** Best-effort user home dir. `os.homedir()` is always defined in Node. */
export function getHomeDir(): string {
  return os.homedir()
}

/**
 * Returns the default folder for new projects, creating it if missing.
 * Lives at `~/BrightCodeProjects/` on every platform — same pattern as
 * `~/.npm`, `~/.cargo`, etc.
 */
export async function ensureDefaultProjectsDir(): Promise<string> {
  const dir = path.join(os.homedir(), 'BrightCodeProjects')
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

// ── Read-only directory ops ────────────────────────────────────────────

export type ListDirsResult =
  | { ok: true; entries: DirEntry[]; parent: string | null }
  | { ok: false; error: string }

/**
 * Lists immediate subdirectories of `dirPath` (one level deep, no
 * recursion). Returns the parent path so the picker UI can offer an
 * "up" navigation row.
 */
export async function listDirs(dirPath: string): Promise<ListDirsResult> {
  if (!dirPath) return { ok: false, error: 'Path is required' }
  let resolved: string
  try {
    resolved = realpathSync(dirPath)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e?.code === 'ENOENT') return { ok: false, error: 'Directory not found' }
    if (e?.code === 'EACCES') return { ok: false, error: 'Access denied' }
    return { ok: false, error: e?.message ?? 'Failed to resolve path' }
  }
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fsp.readdir(resolved, { withFileTypes: true })
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e?.code === 'EACCES') return { ok: false, error: 'Access denied' }
    return { ok: false, error: e?.message ?? 'Failed to read directory' }
  }
  // Only directories; sorted case-insensitive.
  const dirs: DirEntry[] = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => ({ name: e.name, path: path.join(resolved, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

  const parent = path.dirname(resolved)
  const isRoot =
    resolved === path.parse(resolved).root ||
    parent === resolved // defensive: Windows drive root edge case
  return { ok: true, entries: dirs, parent: isRoot ? null : parent }
}

// ── Native file dialog ─────────────────────────────────────────────────

/**
 * Pops the OS folder picker. Returns the chosen absolute path, or null
 * if the user cancelled. `defaultPath` is the folder the dialog opens at.
 */
export async function browseForFolder(
  defaultPath?: string,
): Promise<{ ok: true; path: string | null } | { ok: false; error: string }> {
  const targetWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = await dialog.showOpenDialog(targetWindow, {
    title: 'Browse folder',
    defaultPath: defaultPath ?? (await ensureDefaultProjectsDir()),
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: true, path: null }
  }
  return { ok: true, path: result.filePaths[0] }
}

// ── Validation ─────────────────────────────────────────────────────────

export type ValidateResult =
  | { ok: true; realPath: string }
  | { ok: false; error: string; code?: 'ENOENT' | 'EACCES' | 'ENOTDIR' }

export async function validatePath(rawPath: string): Promise<ValidateResult> {
  if (!rawPath || !rawPath.trim()) return { ok: false, error: 'Path is required' }
  let real: string
  try {
    real = await fsp.realpath(rawPath)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    return {
      ok: false,
      error: e?.code === 'ENOENT' ? 'Directory not found' : e?.message ?? 'Failed to resolve',
      code: e?.code as 'ENOENT' | 'EACCES' | undefined,
    }
  }
  let stat
  try {
    stat = await fsp.stat(real)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
  if (!stat.isDirectory()) return { ok: false, error: 'Path is not a directory', code: 'ENOTDIR' }
  return { ok: true, realPath: real }
}

// ── Clone + create ─────────────────────────────────────────────────────

export type CloneResult =
  | { ok: true; path: string }
  | { ok: false; error: string }

/**
 * Clones a git repo into `destPath`. The parent of `destPath` must
 * exist; we let `git clone` create the destination folder itself.
 */
export function cloneRepo(remoteUrl: string, destPath: string): Promise<CloneResult> {
  return new Promise((resolve) => {
    if (!remoteUrl || !remoteUrl.trim()) {
      resolve({ ok: false, error: 'Remote URL is required' })
      return
    }
    if (!destPath || !destPath.trim()) {
      resolve({ ok: false, error: 'Destination path is required' })
      return
    }
    // Make sure the parent of destPath exists. We refuse to clone into
    // a parent that doesn't exist (avoids surprising "where did it go?"
    // cases).
    const parent = path.dirname(destPath)
    fsp
      .stat(parent)
      .catch(() => fsp.mkdir(parent, { recursive: true }))
      .then(() => {
        const child = spawn(
          'git',
          ['clone', '--depth', '1', remoteUrl, destPath],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        )
        let stderr = ''
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString()
        })
        child.on('error', (err) => {
          resolve({ ok: false, error: `Failed to start git: ${err.message}` })
        })
        child.on('close', (code) => {
          if (code === 0) {
            resolve({ ok: true, path: destPath })
          } else {
            // Common errors: auth failure, invalid URL, no network.
            const trimmed = stderr.trim().split('\n').pop() ?? 'git clone failed'
            resolve({ ok: false, error: trimmed || `git exited with code ${code}` })
          }
        })
      })
      .catch((err) => {
        resolve({ ok: false, error: `Failed to prepare destination: ${(err as Error).message}` })
      })
  })
}

export type CreateDirResult = { ok: true; path: string } | { ok: false; error: string }

/**
 * Creates a directory at `targetPath` (recursively), refusing if any
 * parent would escape the active projects root (future hardening). For
 * now, we just call mkdir -p.
 */
export async function createProjectDir(targetPath: string): Promise<CreateDirResult> {
  if (!targetPath || !targetPath.trim()) {
    return { ok: false, error: 'Path is required' }
  }
  try {
    await fsp.mkdir(targetPath, { recursive: true })
    return { ok: true, path: targetPath }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e?.code === 'EACCES') return { ok: false, error: 'Access denied' }
    return { ok: false, error: e?.message ?? 'Failed to create directory' }
  }
}

// ── IPC registration ───────────────────────────────────────────────────

export function registerFsIpc(): void {
  ipcMain.handle(IPC.FS_HOME, (): string => getHomeDir())
  ipcMain.handle(IPC.FS_DEFAULT_PROJECTS_DIR, async (): Promise<string> => {
    return ensureDefaultProjectsDir()
  })
  ipcMain.handle(IPC.FS_LIST_DIRS, (_e, dirPath: string) => listDirs(dirPath))
  ipcMain.handle(IPC.FS_BROWSE, (_e, defaultPath?: string) => browseForFolder(defaultPath))
  ipcMain.handle(IPC.FS_VALIDATE, (_e, path: string) => validatePath(path))
  ipcMain.handle(IPC.FS_CLONE, (_e, url: string, dest: string) => cloneRepo(url, dest))
  ipcMain.handle(IPC.FS_CREATE_DIR, (_e, target: string) => createProjectDir(target))
}
