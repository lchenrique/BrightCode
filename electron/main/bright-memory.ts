import { spawn } from 'node:child_process'
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ipcMain } from 'electron'
import { IPC } from '../shared/ipc-channels'

const REPOSITORY_URL = 'https://github.com/lchenrique/bright-memory.git'
const RELEASE_BRANCH = 'cloud-self-host-distribution'
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000
const MAX_OUTPUT_LENGTH = 256 * 1024
const WINDOWS_SAFE_ARGUMENT = /^[A-Za-z0-9._:/\\@#-]+$/

export interface BrightMemoryStatus {
  cliInstalled: boolean
  cliVersion?: string
  globalRuleConfigured: boolean
  rulePaths: string[]
  ready: boolean
}

export type BrightMemoryInstallResult =
  | { ok: true; status: BrightMemoryStatus }
  | { ok: false; error: string; status: BrightMemoryStatus }

interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

const GLOBAL_RULE_FILES = [
  join(homedir(), '.agents', 'skills', 'bright-memory', 'SKILL.md'),
  join(homedir(), '.codex', 'AGENTS.md'),
  join(homedir(), '.claude', 'CLAUDE.md'),
  join(homedir(), '.claude', 'skills', 'bright-memory', 'SKILL.md'),
  join(homedir(), '.gemini', 'GEMINI.md'),
  join(homedir(), '.gemini', 'skills', 'bright-memory', 'SKILL.md'),
  join(homedir(), '.minimax', 'skills', 'bright-memory', 'SKILL.md'),
] as const

function executableName(name: string): string {
  return process.platform === 'win32' && name === 'npm' ? 'npm' : name
}

function appendLimited(current: string, chunk: Buffer): string {
  const next = current + chunk.toString('utf8')
  return next.length <= MAX_OUTPUT_LENGTH
    ? next
    : next.slice(next.length - MAX_OUTPUT_LENGTH)
}

function runCommand(
  executable: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let command = executableName(executable)
    let commandArgs = [...args]

    if (process.platform === 'win32') {
      const allArguments = [command, ...commandArgs]
      if (!allArguments.every((argument) => WINDOWS_SAFE_ARGUMENT.test(argument))) {
        reject(new Error('Installer command contains an unsafe argument'))
        return
      }
      command = process.env['ComSpec'] || 'cmd.exe'
      commandArgs = ['/d', '/s', '/c', allArguments.join(' ')]
    }

    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`${executable} timed out`))
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendLimited(stderr, chunk)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

async function readConfiguredRulePaths(): Promise<string[]> {
  const configured: string[] = []
  for (const path of GLOBAL_RULE_FILES) {
    try {
      const stats = await lstat(path)
      if (!stats.isFile()) continue
      const content = await readFile(path, 'utf8')
      const hasManagedMarker = content.includes('bright-memory:start')
        || content.includes('bright-memory:managed-skill')
      if (
        hasManagedMarker
        && content.includes('bright-memory ensure')
        && content.includes('bright-memory save')
      ) {
        configured.push(path)
      }
    } catch {
      // Missing or unreadable agent homes are valid; setup targets detected agents only.
    }
  }
  return configured
}

export async function detectBrightMemoryStatus(): Promise<BrightMemoryStatus> {
  let cliVersion: string | undefined
  try {
    const version = await runCommand('bright-memory', ['--version'], {
      timeoutMs: 15_000,
    })
    if (version.code === 0 && version.stdout.trim()) {
      cliVersion = version.stdout.trim().split(/\r?\n/, 1)[0]
    }
  } catch {
    // CLI is absent or not on PATH.
  }

  const rulePaths = await readConfiguredRulePaths()
  const cliInstalled = cliVersion !== undefined
  const globalRuleConfigured = rulePaths.length > 0
  return {
    cliInstalled,
    ...(cliVersion === undefined ? {} : { cliVersion }),
    globalRuleConfigured,
    rulePaths,
    ready: cliInstalled && globalRuleConfigured,
  }
}

async function requireSuccessfulCommand(
  executable: string,
  args: readonly string[],
  cwd?: string,
): Promise<void> {
  const result = await runCommand(executable, args, { cwd })
  if (result.code === 0) return
  const detail = result.stderr.trim() || result.stdout.trim()
  throw new Error(detail ? detail.slice(-1_000) : `${executable} exited with code ${result.code}`)
}

async function installLatestCli(): Promise<void> {
  const nodeVersion = await runCommand('node', ['--version'])
  const nodeMajor = Number.parseInt(nodeVersion.stdout.trim().replace(/^v/, '').split('.')[0] ?? '', 10)
  if (nodeVersion.code !== 0 || !Number.isFinite(nodeMajor) || nodeMajor < 22) {
    throw new Error('Bright Memory requires Node.js 22 or newer')
  }
  await requireSuccessfulCommand('git', ['--version'])
  await requireSuccessfulCommand('npm', ['--version'])

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'bright-memory-install-'))
  const repositoryDirectory = join(temporaryDirectory, 'repo')
  try {
    await requireSuccessfulCommand('git', [
      'clone',
      '--depth',
      '1',
      '--branch',
      RELEASE_BRANCH,
      REPOSITORY_URL,
      'repo',
    ], temporaryDirectory)
    await requireSuccessfulCommand('npm', ['ci'], repositoryDirectory)
    await requireSuccessfulCommand('npm', ['run', 'build'], repositoryDirectory)
    await requireSuccessfulCommand(
      'npm',
      ['install', '--global', './bright-memory-cli'],
      repositoryDirectory,
    )
  } finally {
    const resolvedTemporaryDirectory = resolve(temporaryDirectory)
    if (
      dirname(resolvedTemporaryDirectory) === resolve(tmpdir())
      && resolvedTemporaryDirectory.startsWith(resolve(tmpdir(), 'bright-memory-install-'))
    ) {
      await rm(resolvedTemporaryDirectory, { recursive: true, force: true })
        .catch(() => undefined)
    }
  }
}

let activeInstallation: Promise<BrightMemoryInstallResult> | null = null

async function installBrightMemory(): Promise<BrightMemoryInstallResult> {
  if (activeInstallation) return activeInstallation

  activeInstallation = (async () => {
    try {
      const currentStatus = await detectBrightMemoryStatus()
      if (currentStatus.ready) return { ok: true, status: currentStatus }

      await installLatestCli()
      const setup = await runCommand('bright-memory', ['setup'], { timeoutMs: 30_000 })
      if (setup.code !== 0) {
        throw new Error(setup.stderr.trim() || 'Bright Memory global setup failed')
      }

      const status = await detectBrightMemoryStatus()
      if (!status.ready) {
        throw new Error('Bright Memory installed, but the global rule could not be verified')
      }
      return { ok: true, status }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        status: await detectBrightMemoryStatus(),
      }
    } finally {
      activeInstallation = null
    }
  })()

  return activeInstallation
}

export function registerBrightMemoryIpc(): void {
  ipcMain.handle(
    IPC.BRIGHT_MEMORY_STATUS,
    (): Promise<BrightMemoryStatus> => detectBrightMemoryStatus(),
  )
  ipcMain.handle(
    IPC.BRIGHT_MEMORY_INSTALL,
    (): Promise<BrightMemoryInstallResult> => installBrightMemory(),
  )
}
