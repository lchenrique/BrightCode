import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { app, ipcMain, type WebContents } from 'electron'
import * as pty from 'node-pty'
import { IPC } from '../shared/ipc-channels'
import { listProjects } from './projects'

type TerminalSession = {
  id: string
  ownerId: number
  process: pty.IPty
}

const sessions = new Map<string, TerminalSession>()
const ownersWithCleanup = new Set<number>()

function terminalEnvironment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  env['TERM'] = 'xterm-256color'
  env['COLORTERM'] = 'truecolor'
  return env
}

function shellConfiguration(): { executable: string; args: string[]; label: string } {
  if (process.platform === 'win32') {
    return {
      executable: 'powershell.exe',
      args: ['-NoLogo'],
      label: 'PowerShell',
    }
  }

  const executable = process.env['SHELL'] || (os.platform() === 'darwin' ? '/bin/zsh' : '/bin/bash')
  return {
    executable,
    args: ['-l'],
    label: executable.split('/').pop() || 'Terminal',
  }
}

function ownsSession(ownerId: number, sessionId: string): TerminalSession | null {
  const session = sessions.get(sessionId)
  return session?.ownerId === ownerId ? session : null
}

function killSession(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session) return
  sessions.delete(sessionId)
  try {
    session.process.kill()
  } catch {
    // The shell may already have exited.
  }
}

function killOwnerSessions(ownerId: number): void {
  for (const session of sessions.values()) {
    if (session.ownerId === ownerId) killSession(session.id)
  }
  ownersWithCleanup.delete(ownerId)
}

function registerOwnerCleanup(contents: WebContents): void {
  if (ownersWithCleanup.has(contents.id)) return
  ownersWithCleanup.add(contents.id)
  contents.once('destroyed', () => killOwnerSessions(contents.id))
}

export function registerTerminalIpc(): void {
  ipcMain.handle(
    IPC.TERMINAL_CREATE,
    (
      event,
      projectId: string,
      dimensions?: { cols?: number; rows?: number },
    ):
      | { ok: true; sessionId: string; shell: string; cwd: string }
      | { ok: false; error: string } => {
      const project = listProjects().find((item) => item.id === projectId)
      if (!project) return { ok: false, error: 'Project not found' }

      const shell = shellConfiguration()
      try {
        const terminalProcess = pty.spawn(shell.executable, shell.args, {
          name: 'xterm-256color',
          cols: clampDimension(dimensions?.cols, 80, 2, 500),
          rows: clampDimension(dimensions?.rows, 24, 1, 300),
          cwd: project.path,
          env: terminalEnvironment(),
          useConpty: process.platform === 'win32',
        })
        const sessionId = randomUUID()
        const session: TerminalSession = {
          id: sessionId,
          ownerId: event.sender.id,
          process: terminalProcess,
        }
        sessions.set(sessionId, session)
        registerOwnerCleanup(event.sender)

        terminalProcess.onData((data) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send(IPC.TERMINAL_DATA, { sessionId, data })
          }
        })
        terminalProcess.onExit(({ exitCode, signal }) => {
          sessions.delete(sessionId)
          if (!event.sender.isDestroyed()) {
            event.sender.send(IPC.TERMINAL_EXIT, {
              sessionId,
              exitCode,
              signal,
            })
          }
        })

        return {
          ok: true,
          sessionId,
          shell: shell.label,
          cwd: project.path,
        }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  )

  ipcMain.on(IPC.TERMINAL_WRITE, (event, sessionId: string, data: string) => {
    if (typeof data !== 'string' || data.length > 1024 * 1024) return
    ownsSession(event.sender.id, sessionId)?.process.write(data)
  })

  ipcMain.on(
    IPC.TERMINAL_RESIZE,
    (
      event,
      sessionId: string,
      dimensions: { cols?: number; rows?: number },
    ) => {
      const session = ownsSession(event.sender.id, sessionId)
      if (!session) return
      try {
        session.process.resize(
          clampDimension(dimensions?.cols, 80, 2, 500),
          clampDimension(dimensions?.rows, 24, 1, 300),
        )
      } catch {
        // Ignore resize races while a process is exiting.
      }
    },
  )

  ipcMain.handle(IPC.TERMINAL_KILL, (event, sessionId: string): boolean => {
    const session = ownsSession(event.sender.id, sessionId)
    if (!session) return false
    killSession(sessionId)
    return true
  })

  app.once('before-quit', () => {
    for (const sessionId of [...sessions.keys()]) killSession(sessionId)
  })
}

function clampDimension(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value!)))
}
