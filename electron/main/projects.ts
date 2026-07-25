/**
 * Project registry — the persisted list of folders the user has added
 * to BrightCode, plus which one is currently "active" (i.e. the cwd for
 * the agent they're talking to).
 *
 * Backed by `electron-store` so projects survive across app restarts.
 * Lives in the main process; the renderer talks to it via IPC.
 *
 * The "default project folder" (`~/BrightCodeProjects/`) is created on
 * demand the first time the user clicks "Create new project" without a
 * destination path — see `ensureDefaultProjectsDir()` in `./fs-ops.ts`.
 */

import { realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { BrowserWindow, ipcMain } from 'electron'
import Store from 'electron-store'
import { IPC } from '../shared/ipc-channels'

// electron-store is CJS in v8; this interop makes the default import work.
const StoreCtor = (Store as unknown as { default?: typeof Store }).default ?? Store

export type Project = {
  id: string
  /** Display name shown in the sidebar. Defaults to the folder basename. */
  label: string
  /** Absolute, realpath-resolved path to the project root. */
  path: string
  /** When the project was first added. */
  createdAt: number
}

type StoredProjectsState = {
  projects: Project[]
  activeProjectId: string | null
}

const projectsStore = new StoreCtor<StoredProjectsState>({
  name: 'projects',
  defaults: { projects: [], activeProjectId: null },
  // TODO(security): add `encryptionKey` once we have a passphrase flow.
})

// ── Public API ─────────────────────────────────────────────────────────

export function listProjects(): Project[] {
  return projectsStore.get('projects')
}

export function getActiveProject(): Project | null {
  const projects = projectsStore.get('projects')
  const id = projectsStore.get('activeProjectId')
  if (id) {
    const found = projects.find((p) => p.id === id)
    if (found) return found
  }
  if (projects.length > 0) {
    const first = projects[0]
    projectsStore.set('activeProjectId', first.id)
    return first
  }
  // Create a default project so agent tools always have a valid working directory
  try {
    const defaultDir = path.join(os.homedir(), 'BrightCodeProjects', 'DefaultProject')
    require('node:fs').mkdirSync(defaultDir, { recursive: true })
    const real = require('node:fs').realpathSync(defaultDir)
    const defaultProj: Project = {
      id: randomUUID(),
      label: 'Default Project',
      path: real,
      createdAt: Date.now(),
    }
    projectsStore.set('projects', [defaultProj])
    projectsStore.set('activeProjectId', defaultProj.id)
    broadcastChanged()
    return defaultProj
  } catch {
    return null
  }
}

export type AddProjectResult =
  | { ok: true; project: Project }
  | { ok: false; error: string }

export async function addProject(rawPath: string, labelOverride?: string): Promise<AddProjectResult> {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    return { ok: false, error: 'Path is required' }
  }
  // Resolve to a real path so symlinks/relative inputs collapse to a stable
  // canonical form. Catches EACCES/ENOENT too.
  let real: string
  try {
    real = await realpath(rawPath)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e?.code === 'ENOENT') return { ok: false, error: 'Directory not found' }
    if (e?.code === 'EACCES') return { ok: false, error: 'Access denied' }
    return { ok: false, error: e?.message ?? 'Failed to resolve path' }
  }

  // Reject duplicates (same realpath as an existing project).
  const existing = projectsStore.get('projects')
  if (existing.some((p) => p.path === real)) {
    return { ok: false, error: 'Project is already added' }
  }

  const label = labelOverride?.trim() || path.basename(real) || real
  const project: Project = {
    id: randomUUID(),
    label,
    path: real,
    createdAt: Date.now(),
  }
  existing.push(project)
  projectsStore.set('projects', existing)

  // First project becomes active automatically.
  if (existing.length === 1) {
    projectsStore.set('activeProjectId', project.id)
  }

  broadcastChanged()
  return { ok: true, project }
}

export type RemoveResult = { ok: true } | { ok: false; error: string }

export function removeProject(id: string): RemoveResult {
  const existing = projectsStore.get('projects')
  const idx = existing.findIndex((p) => p.id === id)
  if (idx < 0) return { ok: false, error: 'Project not found' }
  const removed = existing.splice(idx, 1)
  void removed
  projectsStore.set('projects', existing)

  // If we just removed the active project, fall back to the first remaining
  // (or null if the list is empty).
  const activeId = projectsStore.get('activeProjectId')
  if (activeId === id) {
    projectsStore.set('activeProjectId', existing[0]?.id ?? null)
  }
  broadcastChanged()
  return { ok: true }
}

export function setActiveProject(id: string | null): void {
  if (id !== null && !projectsStore.get('projects').some((p) => p.id === id)) {
    return // silently ignore unknown ids
  }
  projectsStore.set('activeProjectId', id)
  broadcastChanged()
}

// ── Internals ──────────────────────────────────────────────────────────

function broadcastChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(IPC.PROJECTS_CHANGED)
  }
}

// ── IPC registration ───────────────────────────────────────────────────

export function registerProjectsIpc(): void {
  ipcMain.handle(IPC.PROJECTS_LIST, (): Project[] => listProjects())
  ipcMain.handle(IPC.PROJECTS_GET_ACTIVE, (): Project | null => getActiveProject())
  ipcMain.handle(IPC.PROJECTS_ADD, (_e, path: string, label?: string) =>
    addProject(path, label),
  )
  ipcMain.handle(IPC.PROJECTS_REMOVE, (_e, id: string) => removeProject(id))
  ipcMain.handle(IPC.PROJECTS_SET_ACTIVE, (_e, id: string | null) => {
    setActiveProject(id)
  })
}
