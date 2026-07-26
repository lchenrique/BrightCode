/**
 * File-tool operations exposed to the agent.
 *
 * The agent (LLM) doesn't have filesystem access itself — it asks BrightCode
 * to perform an action by calling `window.electronAPI.tools.execute(...)`.
 * The main process executes the op against the *active project root*
 * (resolved via the projects store) and returns a serialized result.
 *
 * All paths are validated against the active project root before any
 * mutation or read. This is the agent's sandbox — it can read/write/edit
 * files only inside the project the user has selected in the sidebar.
 *
 * Tools exposed:
 *   read_file(path)              → string
 *   write_file(path, content)    → { path, bytes }
 *   edit_file(path, old, new)    → { path, replacements }
 *   list_files(path?, recursive?) → Array<{ name, path, isDir }>
 *   search_files(query, path?)   → Array<{ path, line, snippet }>
 *
 * Deliberately NOT exposed (yet):
 *   bash       — arbitrary shell exec is a security landmine; needs an
 *                explicit per-call approval UI before we wire it up.
 *   delete     — same: needs confirmation.
 *   network    — not needed yet.
 */

import { promises as fsp, realpathSync } from 'node:fs'
import path from 'node:path'
import { ipcMain } from 'electron'
import { IPC } from '../shared/ipc-channels'
import { getActiveProject } from './projects'
import {
  discoverSkills,
  getSkillSelector,
  readSkillForAgent,
  readSkillResourceForAgent,
} from './skills'

// ── Result envelope ────────────────────────────────────────────────────

export type ToolResult<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; error: string }

export type ToolName =
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'list_files'
  | 'search_files'
  | 'list_skills'
  | 'read_skill'
  | 'read_skill_file'

export type ToolArgs = {
  read_file: { path: string }
  write_file: { path: string; content: string }
  edit_file: { path: string; oldText: string; newText: string; replaceAll?: boolean }
  list_files: { path?: string; recursive?: boolean }
  search_files: { query: string; path?: string; includePattern?: string }
  list_skills: { query?: string }
  read_skill: { skill: string }
  read_skill_file: { skill: string; path: string }
}

export type ToolExecuteRequest = {
  [K in ToolName]: { name: K; args: ToolArgs[K] }
}[ToolName]

// ── Public dispatcher ──────────────────────────────────────────────────

export async function executeTool(req: ToolExecuteRequest): Promise<ToolResult> {
  const project = getActiveProject()
  const { name, args } = req

  try {
    if (name === 'list_skills') {
      const query = args.query?.trim().toLocaleLowerCase()
      const skills = await discoverSkills(project?.path)
      const filtered = query
        ? skills.filter((skill) =>
            [
              skill.name,
              skill.description,
              skill.source,
              skill.sourceLabel,
              ...(skill.tags ?? []),
            ]
              .join(' ')
              .toLocaleLowerCase()
              .includes(query),
          )
        : skills
      return {
        ok: true,
        result: filtered.map((skill) => ({
          selector: getSkillSelector(skill),
          name: skill.name,
          description: skill.description,
          source: skill.source,
          sourceLabel: skill.sourceLabel,
          tags: skill.tags,
        })),
      }
    }
    if (name === 'read_skill') {
      return {
        ok: true,
        result: await readSkillForAgent(args.skill, project?.path),
      }
    }
    if (name === 'read_skill_file') {
      return {
        ok: true,
        result: await readSkillResourceForAgent(
          args.skill,
          args.path,
          project?.path,
        ),
      }
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  if (!project) {
    return { ok: false, error: 'No active project — pick one in the sidebar first.' }
  }
  try {
    switch (name) {
      case 'read_file':
        return await readFile(project.path, args.path)
      case 'write_file':
        return await writeFile(project.path, args.path, args.content)
      case 'edit_file':
        return await editFile(
          project.path,
          args.path,
          args.oldText,
          args.newText,
          args.replaceAll ?? false,
        )
      case 'list_files':
        return await listFiles(project.path, args.path ?? '.', args.recursive ?? false)
      case 'search_files':
        return await searchFiles(
          project.path,
          args.query,
          args.path ?? '.',
          args.includePattern,
        )
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// ── Sandbox helper ─────────────────────────────────────────────────────

/**
 * Resolve `rel` against the project root and verify it stays inside the
 * project. Returns the realpath-resolved absolute path, or throws.
 */
function resolveInProject(projectRoot: string, rel: string): string {
  if (!rel || typeof rel !== 'string') {
    throw new Error('path is required')
  }
  // Reject absolute paths — force the agent to use relative ones. This
  // catches the "agent tries to read /etc/passwd" class of mistakes.
  if (path.isAbsolute(rel)) {
    throw new Error(
      'absolute paths are not allowed — pass a path relative to the project root',
    )
  }
  // Normalize to defeat ".." traversal before resolving.
  const normalized = path.posix.normalize(rel.replace(/\\/g, '/'))
  if (normalized.startsWith('..') || normalized === '..' || normalized.startsWith('/')) {
    throw new Error('path escapes the project root')
  }
  const candidate = path.resolve(projectRoot, normalized)
  // Belt-and-suspenders: realpath-check the project root, then prefix
  // check the candidate against it. We can't realpath the candidate if
  // it doesn't exist yet (write_file/edit_file), so we use a startsWith
  // check on the resolved (pre-realpath) path.
  let realRoot: string
  try {
    realRoot = realpathSync(projectRoot)
  } catch {
    realRoot = projectRoot
  }
  if (!candidate.startsWith(realRoot + path.sep) && candidate !== realRoot) {
    throw new Error('path escapes the project root')
  }
  return candidate
}

// ── Tool implementations ───────────────────────────────────────────────

async function readFile(projectRoot: string, relPath: string): Promise<ToolResult<string>> {
  const abs = resolveInProject(projectRoot, relPath)
  try {
    const content = await fsp.readFile(abs, 'utf-8')
    return { ok: true, result: content }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e?.code === 'ENOENT') return { ok: false, error: `File not found: ${relPath}` }
    if (e?.code === 'EISDIR') return { ok: false, error: `Is a directory, not a file: ${relPath}` }
    return { ok: false, error: e?.message ?? 'Read failed' }
  }
}

async function writeFile(
  projectRoot: string,
  relPath: string,
  content: string,
): Promise<ToolResult<{ path: string; bytes: number }>> {
  const abs = resolveInProject(projectRoot, relPath)
  try {
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, content, 'utf-8')
    return { ok: true, result: { path: relPath, bytes: Buffer.byteLength(content, 'utf-8') } }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e?.code === 'EACCES') return { ok: false, error: 'Permission denied' }
    return { ok: false, error: e?.message ?? 'Write failed' }
  }
}

async function editFile(
  projectRoot: string,
  relPath: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
): Promise<ToolResult<{ path: string; replacements: number }>> {
  if (!oldText) return { ok: false, error: 'oldText is required' }
  const abs = resolveInProject(projectRoot, relPath)
  let content: string
  try {
    content = await fsp.readFile(abs, 'utf-8')
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e?.code === 'ENOENT') return { ok: false, error: `File not found: ${relPath}` }
    return { ok: false, error: e?.message ?? 'Read failed' }
  }
  if (!content.includes(oldText)) {
    return { ok: false, error: 'oldText not found in file (no replacement made)' }
  }
  let updated: string
  let replacements: number
  if (replaceAll) {
    const parts = content.split(oldText)
    replacements = parts.length - 1
    updated = parts.join(newText)
  } else {
    const idx = content.indexOf(oldText)
    if (idx < 0) return { ok: false, error: 'oldText not found in file' }
    replacements = 1
    updated = content.slice(0, idx) + newText + content.slice(idx + oldText.length)
  }
  try {
    await fsp.writeFile(abs, updated, 'utf-8')
    return { ok: true, result: { path: relPath, replacements } }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

type FileEntry = { name: string; path: string; isDir: boolean; size?: number }

async function listFiles(
  projectRoot: string,
  relPath: string,
  recursive: boolean,
): Promise<ToolResult<FileEntry[]>> {
  const abs = resolveInProject(projectRoot, relPath)
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fsp.readdir(abs, { withFileTypes: true })
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e?.code === 'ENOENT') return { ok: false, error: `Directory not found: ${relPath}` }
    if (e?.code === 'ENOTDIR') return { ok: false, error: `Not a directory: ${relPath}` }
    return { ok: false, error: e?.message ?? 'readdir failed' }
  }
  const out: FileEntry[] = []
  async function walk(dir: string, base: string) {
    const ents = await fsp.readdir(dir, { withFileTypes: true })
    for (const e of ents) {
      // Skip noisy / dangerous bits by default.
      if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue
      const full = path.join(dir, e.name)
      const rel = path.join(base, e.name).split(path.sep).join('/')
      if (e.isDirectory()) {
        out.push({ name: e.name, path: rel, isDir: true })
        if (recursive) await walk(full, rel)
      } else if (e.isFile()) {
        const stat = await fsp.stat(full).catch(() => null)
        out.push({
          name: e.name,
          path: rel,
          isDir: false,
          size: stat?.size,
        })
      }
    }
  }
  if (recursive) {
    await walk(abs, relPath === '.' ? '' : relPath)
  } else {
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue
      out.push({
        name: e.name,
        path: e.name,
        isDir: e.isDirectory(),
      })
    }
  }
  // Sort: dirs first, then files; alphabetical within each group.
  out.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
  return { ok: true, result: out }
}

type SearchHit = { path: string; line: number; snippet: string }

async function searchFiles(
  projectRoot: string,
  query: string,
  relPath: string,
  includePattern?: string,
): Promise<ToolResult<SearchHit[]>> {
  if (!query) return { ok: false, error: 'query is required' }
  const abs = resolveInProject(projectRoot, relPath)
  const hits: SearchHit[] = []
  const MAX_HITS = 200
  const includeRe = includePattern
    ? globToRegex(includePattern)
    : null

  async function walk(dir: string, base: string) {
    if (hits.length >= MAX_HITS) return
    const ents = await fsp.readdir(dir, { withFileTypes: true }).catch(() => null)
    if (!ents) return
    for (const e of ents) {
      if (hits.length >= MAX_HITS) return
      if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue
      const full = path.join(dir, e.name)
      const rel = (base ? base + '/' : '') + e.name
      if (e.isDirectory()) {
        await walk(full, rel)
      } else if (e.isFile()) {
        if (includeRe && !includeRe.test(e.name)) continue
        // Only search text-y files.
        if (e.name.match(/\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|tar|gz|exe|dll|so|wasm|mp[34]|webm)$/i)) {
          continue
        }
        let content: string
        try {
          content = await fsp.readFile(full, 'utf-8')
        } catch {
          continue
        }
        const lines = content.split(/\r?\n/)
        for (let i = 0; i < lines.length; i++) {
          if (hits.length >= MAX_HITS) return
          const line = lines[i]!
          const idx = line.indexOf(query)
          if (idx >= 0) {
            const start = Math.max(0, idx - 30)
            const end = Math.min(line.length, idx + query.length + 30)
            const snippet =
              (start > 0 ? '…' : '') +
              line.slice(start, end) +
              (end < line.length ? '…' : '')
            hits.push({ path: rel, line: i + 1, snippet })
          }
        }
      }
    }
  }

  await walk(abs, relPath === '.' ? '' : relPath)
  return { ok: true, result: hits }
}

function globToRegex(pattern: string): RegExp {
  // Very small subset: `*` and `?`. Case-insensitive.
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp('^' + escaped + '$', 'i')
}

// ── IPC registration ───────────────────────────────────────────────────

export function registerToolsIpc(): void {
  ipcMain.handle(IPC.TOOL_EXECUTE, (_e, req: ToolExecuteRequest) => executeTool(req))
}
