/**
 * Git operations for the Environmental Info panel.
 *
 * Spawns `git` in the registered project root. No shell, no injection risk —
 * `args` is a string array passed directly to `spawn('git', args)`.
 */

import { spawn } from 'node:child_process'
import { ipcMain } from 'electron'
import { IPC } from '../shared/ipc-channels'
import { listProjects } from './projects'

export type GitResult =
  | { ok: true; stdout: string; stderr: string; code: number }
  | { ok: false; error: string }

/**
 * Run git in the project directory.
 * `args` is the argv array passed to `git`, e.g. ['status', '--porcelain'].
 */
function execGit(projectId: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const project = listProjects().find((p) => p.id === projectId)
    if (!project) {
      resolve({ ok: false, error: 'Project not found' })
      return
    }

    const child = spawn('git', args, {
      cwd: project.path,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', (err) => {
      resolve({ ok: false, error: `Failed to start git: ${err.message}` })
    })

    child.on('close', (code) => {
      resolve({ ok: true, stdout, stderr, code: code ?? -1 })
    })
  })
}

export function registerGitIpc(): void {
  ipcMain.handle(
    IPC.GIT_EXEC,
    (_event, projectId: string, args: string[]): Promise<GitResult> => {
      return execGit(projectId, args)
    },
  )
}
