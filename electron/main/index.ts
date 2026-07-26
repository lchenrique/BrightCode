/**
 * Electron main process.
 *
 * Responsibilities:
 *   - Create the BrowserWindow that hosts the renderer.
 *   - Persist provider credentials to `electron-store` (encrypted at rest
 *     by the OS in production builds; plain JSON in dev — see TODO).
 *   - Expose a thin IPC surface so the renderer can read/write credentials
 *     without touching Node directly.
 *
 * The renderer is loaded from Vite's dev server during development and
 * from the built `dist/index.html` in production. Hot reload is wired up
 * automatically by `vite-plugin-electron`.
 */

import { app, BrowserWindow, ipcMain, protocol, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Store from 'electron-store'
import { IPC } from '../shared/ipc-channels'
import {
  detectAllCLIs,
  detectAntigravity,
  detectClaudeCode,
  detectCodex,
  detectGeminiCLI,
  detectOpenCode,
  type CLIDetection,
  type DetectedProviderId,
} from './cli-detect'
import { registerProviderProxy } from './provider-proxy'
import { registerProjectsIpc } from './projects'
import { registerTasksIpc } from './tasks'
import { registerOAuthIpc } from './oauth'
import {
  PROJECT_PREVIEW_SCHEME,
  registerFsIpc,
  registerProjectPreviewProtocol,
} from './fs-ops'
import { registerToolsIpc } from './tools'
import { registerSkillsIpc } from './skills'

// electron-store is CJS in v8; this interop makes the default import work.
const StoreCtor = (Store as unknown as { default?: typeof Store }).default ?? Store

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

protocol.registerSchemesAsPrivileged([
  {
    scheme: PROJECT_PREVIEW_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
])

// ── Persistent credential store ────────────────────────────────────────
//
// We keep the same shape the renderer used in the browser dev mode
// (localStorage) so the API surface doesn't need to change between modes.
// `name` controls the file on disk: ~/.config/brightcode/auth.json (macOS)
// or %APPDATA%/brightcode/auth.json (Windows).
type StoredCredential = {
  method: 'api_key' | 'oauth' | 'cli_detected'
  apiKey?: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  cliSource?: string
  cliEmail?: string
}

const auth = new StoreCtor<{
  credentials: Record<string, StoredCredential>
}>({
  name: 'auth',
  defaults: { credentials: {} },
  // TODO(security): add `encryptionKey` once we have a passphrase flow.
  // For now the file is plain JSON on disk — still better than
  // localStorage in a browser profile because it's never synced or
  // exposed to web content.
})

// ── Window ──────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null

// In dev, expose Chrome DevTools Protocol on a fixed port so we can poke at
// the renderer from a script (e.g. `scripts/cdp-inspect.mjs`). Production
// builds don't need this — DevTools is hidden anyway.
if (process.env['VITE_DEV_SERVER_URL'] && !process.env['VITE_DEV_SERVER_URL'].includes('production')) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
  app.commandLine.appendSwitch('remote-allow-origins', '*')
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 400,
    minHeight: 400,
    show: false,
    backgroundColor: '#0a0c10',
    title: 'BrightCode',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs `electron` for ipcRenderer + contextBridge
      // CORS-safe by default: provider fetches happen in the main process
      // via the proxy (`electron/main/provider-proxy.ts`), so the renderer
      // never makes cross-origin requests that would be blocked by SOP.
    },
  })

  // Open external links in the user's default browser, not in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    // Open DevTools automatically in dev so users can see console errors
    // and the network tab. In production we leave it closed.
    if (process.env['VITE_DEV_SERVER_URL']) {
      mainWindow?.webContents.openDevTools({ mode: 'detach' })
    }
  })

  // Load the renderer. During dev `vite-plugin-electron` should inject
  // `VITE_DEV_SERVER_URL` (the Vite dev server URL) into process.env before
  // spawning us. As a defensive fallback we hardcode the dev server URL
  // when running unpackaged — the Vite dev server runs on a fixed port
  // (see `vite.config.ts: server.port = 5180`). In production we load the
  // built static files from `dist/`.
  const devUrl =
    process.env['VITE_DEV_SERVER_URL'] ??
    (!app.isPackaged ? 'http://localhost:5180' : undefined)
  if (devUrl) {
    console.log('[brightcode] loading renderer from', devUrl)
    void mainWindow.loadURL(devUrl)
  } else {
    const indexPath = join(__dirname, '../renderer/index.html')
    console.log('[brightcode] loading renderer from file', indexPath)
    void mainWindow.loadFile(indexPath)
  }
}

// ── IPC handlers ────────────────────────────────────────────────────────

function broadcastChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(IPC.AUTH_CHANGED)
  }
}

ipcMain.handle(IPC.AUTH_GET, (_e, providerId: string): StoredCredential | null => {
  const all = auth.get('credentials')
  return all[providerId] ?? null
})

ipcMain.handle(IPC.AUTH_SET, (_e, providerId: string, credential: StoredCredential): void => {
  const all = auth.get('credentials')
  all[providerId] = credential
  auth.set('credentials', all)
  broadcastChanged()
})

ipcMain.handle(IPC.AUTH_REMOVE, (_e, providerId: string): void => {
  const all = auth.get('credentials')
  delete all[providerId]
  auth.set('credentials', all)
  broadcastChanged()
})

ipcMain.handle(IPC.AUTH_HAS, (_e, providerId: string): boolean => {
  return providerId in auth.get('credentials')
})

ipcMain.handle(
  IPC.AUTH_LIST,
  (): Array<{ providerId: string; credential: StoredCredential }> => {
    const all = auth.get('credentials')
    return Object.entries(all).map(([providerId, credential]) => ({ providerId, credential }))
  },
)

ipcMain.handle(IPC.AUTH_CLEAR, (): void => {
  auth.set('credentials', {})
  broadcastChanged()
})

// ── CLI detection ───────────────────────────────────────────────────────

ipcMain.handle(IPC.CLI_DETECT, async (_e, providerId: DetectedProviderId): Promise<CLIDetection | null> => {
  switch (providerId) {
    case 'openai':
      return detectCodex()
    case 'anthropic':
      return detectClaudeCode()
    case 'gemini-cli':
      return detectGeminiCLI()
    case 'antigravity':
      return detectAntigravity()
    case 'opencode-go':
    case 'opencode-zen':
    case 'minimax': {
      const all = await detectOpenCode()
      return all.find((d) => d.providerId === providerId) ?? null
    }
    default:
      return null
  }
})

ipcMain.handle(IPC.CLI_DETECT_ALL, (): Promise<CLIDetection[]> => detectAllCLIs())

// ── Renderer log forwarding ────────────────────────────────────────────

ipcMain.on(IPC.RENDERER_LOG, (_e, level: string, args: unknown[]) => {
  const prefix = `[renderer:${level}]`
  const printable = args
    .map((a) => {
      if (a instanceof Error) return a.stack ?? a.message
      if (typeof a === 'string') return a
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
  if (level === 'error') console.error(prefix, printable)
  else if (level === 'warn') console.warn(prefix, printable)
  else console.log(prefix, printable)
})

// ── Provider stream proxy ───────────────────────────────────────────────

registerProviderProxy()

// ── Projects + tasks + oauth + filesystem ops ──────────────────────────

registerProjectsIpc()
registerTasksIpc()
registerOAuthIpc()
registerFsIpc()
registerToolsIpc()
registerSkillsIpc()

// ── App lifecycle ──────────────────────────────────────────────────────

app.whenReady().then(() => {
  registerProjectPreviewProtocol()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
