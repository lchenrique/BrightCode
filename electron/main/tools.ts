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
 *   bash(command, cwd?, timeoutMs?) → { stdout, stderr, exitCode, durationMs }
 *                                      (requires user approval per call)
 *
 * Deliberately NOT exposed (yet):
 *   delete     — needs confirmation UI.
 *   network    — not needed yet.
 */

import { promises as fsp, realpathSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { BrowserWindow, ipcMain } from 'electron'
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
  | 'bash'

export type ToolArgs = {
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
      case 'bash':
        return await runBash(project.path, args.command, args.cwd, args.timeoutMs)
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

/**
 * Pending bash-tool approval requests. Keyed by `approvalId` so the
 * renderer can answer a specific request even if several are open.
 * The Promise resolver runs when the renderer sends
 * `IPC.TOOL_BASH_APPROVAL_RESPOND` with the same `approvalId`.
 *
 * Safety invariants:
 * - Each `approvalId` resolves at most once (duplicate resolves are dropped).
 * - When a second bash call arrives while one is pending, the second
 *   requestId is queued so the renderer can show both sequentially.
 * - `pendingBashApprovals` is the source of truth; renderer state is derived.
 */
type BashApprovalRequest = {
  approvalId: string
  command: string
  workdir: string
  timeoutMs: number
}

const pendingBashApprovals = new Map<
  string,
  BashApprovalRequest & { resolve: (approved: boolean) => void; timer: NodeJS.Timeout }
>()

/**
 * Tracks whether a bash approval is currently visible to the user.
 * When non-null, a second bash tool call must wait for this one to resolve
 * before sending another IPC request, otherwise the dialog would silently
 * swallow the second approval and its promise would hang forever.
 */
let activeApprovalId: string | null = null

const BASH_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000
const BASH_OUTPUT_BYTE_LIMIT = 200_000

export function registerToolsIpc(): void {
  ipcMain.handle(IPC.TOOL_EXECUTE, (_e, req: ToolExecuteRequest) => executeTool(req))
  ipcMain.handle(IPC.TOOL_BASH_APPROVAL_GET_PENDING, (): BashApprovalRequest | null => {
    if (!activeApprovalId) return null
    const pending = pendingBashApprovals.get(activeApprovalId)
    if (!pending) return null
    const { approvalId, command, workdir, timeoutMs } = pending
    return { approvalId, command, workdir, timeoutMs }
  })

  ipcMain.on(
    IPC.TOOL_BASH_APPROVAL_RESPOND,
    (
      _e,
      payload: { approvalId: string; approved: boolean; rememberChoice?: boolean },
    ) => {
      const pending = pendingBashApprovals.get(payload.approvalId)
      if (!pending) return // duplicate or stale — ignore safely
      pendingBashApprovals.delete(payload.approvalId)
      clearTimeout(pending.timer)

      const window = BrowserWindow.getAllWindows()[0]

      // Advance activeApprovalId *before* resolving so any queued bash
      // gets sent before the next model round-trip arrives.
      if (activeApprovalId === payload.approvalId) {
        activeApprovalId = null
        if (window && !window.isDestroyed()) {
          sendNextQueuedApproval(window)
        }
      }

      pending.resolve(payload.approved === true)
    },
  )
}

/**
 * Send an approval request to the renderer and await the response.
 * Returns `false` if the user denies, the timeout elapses, or no
 * window is open to show the modal.
 *
 * If a bash approval is already active (user hasn't responded yet), the
 * second call waits in a queue and is only sent after the first resolves.
 * This prevents the silent "second bash hangs forever" bug.
 */
function requestBashApproval(
  approvalId: string,
  command: string,
  workdir: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window || window.isDestroyed()) {
      resolve(false)
      return
    }

    const request = { approvalId, command, workdir, timeoutMs }
    const timer = setTimeout(() => {
      if (pendingBashApprovals.has(approvalId)) {
        pendingBashApprovals.delete(approvalId)
        const queuedIndex = queuedBashApprovals.findIndex((item) => item.approvalId === approvalId)
        if (queuedIndex >= 0) queuedBashApprovals.splice(queuedIndex, 1)
        if (activeApprovalId === approvalId) {
          activeApprovalId = null
          if (!window.isDestroyed()) {
            window.webContents.send(IPC.TOOL_BASH_APPROVAL_REQUEST, null)
            sendNextQueuedApproval(window)
          }
        }
        resolve(false)
      }
    }, BASH_APPROVAL_TIMEOUT_MS)

    pendingBashApprovals.set(approvalId, { ...request, resolve, timer })

    // If another bash is already awaiting approval, queue this one instead
    // of sending a second IPC request (which would get silently dropped by
    // the single-instance dialog, leaving the promise hanging forever).
    if (activeApprovalId !== null) {
      queuedBashApprovals.push({ approvalId, command, workdir, timeoutMs })
      return
    }

    activeApprovalId = approvalId
    window.webContents.send(IPC.TOOL_BASH_APPROVAL_REQUEST, {
      approvalId,
      command,
      workdir,
      timeoutMs,
    })
  })
}

/** Queue for bash approvals that arrive while another is already pending. */
const queuedBashApprovals: BashApprovalRequest[] = []

function sendNextQueuedApproval(window: BrowserWindow): void {
  let next = queuedBashApprovals.shift()
  while (next && !pendingBashApprovals.has(next.approvalId)) {
    next = queuedBashApprovals.shift()
  }
  if (!next) return
  activeApprovalId = next.approvalId
  window.webContents.send(IPC.TOOL_BASH_APPROVAL_REQUEST, next)
}

async function killProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
    return
  }

  await new Promise<void>((resolve) => {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    })
    killer.once('error', () => {
      child.kill('SIGKILL')
      resolve()
    })
    killer.once('close', () => resolve())
  })
}

async function runBash(
  projectRoot: string,
  command: string,
  cwdRel: string | undefined,
  timeoutMs: number | undefined,
): Promise<ToolResult<{ stdout: string; stderr: string; exitCode: number; durationMs: number }>> {
  if (!command || typeof command !== 'string' || !command.trim()) {
    return { ok: false, error: 'command is required' }
  }
  if (command.length > 8_000) {
    return { ok: false, error: 'command is too long (max 8000 chars)' }
  }

  // Resolve the workdir against the project sandbox. Falls back to the
  // project root if `cwd` is omitted.
  const workdir = cwdRel
    ? resolveInProject(projectRoot, cwdRel)
    : projectRoot

  const approvalId = randomUUID()
  const approved = await requestBashApproval(
    approvalId,
    command,
    workdir,
    timeoutMs ?? 60_000,
  )
  if (!approved) {
    return { ok: false, error: 'User denied the command. Ask before retrying.' }
  }

  // Hard cap the user-supplied timeout.
  const effectiveTimeout = Math.max(1_000, Math.min(timeoutMs ?? 60_000, 5 * 60_000))

  return await new Promise((resolve) => {
    const startedAt = Date.now()
    // shell: true so pipes, redirects, and chained commands work.
    // The user has already approved the exact command — that approval
    // is the authorization layer. We do NOT scan the command here.
    const child = spawn(command, {
      cwd: workdir,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, BRIGHTCODE_TOOL: 'bash' },
    })

    let stdout = ''
    let stderr = ''
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    let stdoutBytes = 0
    let stderrBytes = 0
    let stdoutTruncated = false
    let stderrTruncated = false
    let settled = false
    let timedOut = false

    const finish = (payload: ToolResult<{
      stdout: string
      stderr: string
      exitCode: number
      durationMs: number
    }>) => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      resolve(payload)
    }

    const killTimer = setTimeout(() => {
      timedOut = true
      void killProcessTree(child).finally(() => {
        finish({
          ok: false,
          error: `Command exceeded timeout (${effectiveTimeout}ms) and was killed.`,
        })
      })
    }, effectiveTimeout)

    child.stdout?.on('data', (chunk: Buffer) => {
      const remaining = BASH_OUTPUT_BYTE_LIMIT - stdoutBytes
      if (remaining > 0) stdout += stdoutDecoder.write(chunk.subarray(0, remaining))
      stdoutBytes += chunk.length
      if (stdoutBytes > BASH_OUTPUT_BYTE_LIMIT && !stdoutTruncated) {
        stdoutTruncated = true
        stdout += `\n\n[stdout truncated at ${BASH_OUTPUT_BYTE_LIMIT} bytes]`
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const remaining = BASH_OUTPUT_BYTE_LIMIT - stderrBytes
      if (remaining > 0) stderr += stderrDecoder.write(chunk.subarray(0, remaining))
      stderrBytes += chunk.length
      if (stderrBytes > BASH_OUTPUT_BYTE_LIMIT && !stderrTruncated) {
        stderrTruncated = true
        stderr += `\n\n[stderr truncated at ${BASH_OUTPUT_BYTE_LIMIT} bytes]`
      }
    })

    child.on('error', (err) => {
      finish({ ok: false, error: `Failed to start command: ${err.message}` })
    })
    child.on('close', (code, signal) => {
      const exitCode = typeof code === 'number' ? code : signal ? 128 + (signal as unknown as number) : -1
      const durationMs = Date.now() - startedAt
      if (timedOut) return
      if (!stdoutTruncated) stdout += stdoutDecoder.end()
      if (!stderrTruncated) stderr += stderrDecoder.end()
      const payload: ToolResult<{
        stdout: string
        stderr: string
        exitCode: number
        durationMs: number
      }> =
        exitCode === 0
          ? { ok: true, result: { stdout, stderr, exitCode, durationMs } }
          : {
              ok: false,
              error: `Command exited with code ${exitCode}`,
              // Keep the captured output so the model can see what went wrong.
            }
      // Note: ToolResult's `error` variant is `{ ok: false; error: string }`
      // (no `result`). The model still gets the captured streams via the
      // `result` field when we report success. For non-zero exit, we keep
      // the error short and the model can re-run with a different command
      // if it needs the failed output verbatim.
      if (exitCode !== 0) {
        finish({
          ok: false,
          error: `Command exited with code ${exitCode}. stderr:\n${stderr.slice(
            0,
            4000,
          )}\n\nstdout:\n${stdout.slice(0, 4000)}`,
        })
        return
      }
      finish(payload)
    })
  })
}
