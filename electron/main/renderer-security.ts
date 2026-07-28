import { app, BrowserWindow, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, normalize } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function comparablePath(value: string): string {
  const normalized = normalize(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function getRendererEntryUrl(): string {
  const devUrl = process.env['VITE_DEV_SERVER_URL']
    ?? (!app.isPackaged ? 'http://localhost:5180' : undefined)
  if (devUrl) return devUrl
  return pathToFileURL(join(__dirname, '../../dist/index.html')).href
}

export function isTrustedRendererUrl(value: string): boolean {
  try {
    const candidate = new URL(value)
    const entry = new URL(getRendererEntryUrl())
    if (entry.protocol !== 'file:') {
      return candidate.origin === entry.origin
    }
    if (candidate.protocol !== 'file:') return false
    return comparablePath(fileURLToPath(candidate)) === comparablePath(fileURLToPath(entry))
  } catch {
    return false
  }
}

export function assertTrustedIpcSender(event: IpcMainInvokeEvent): WebContents {
  const sender = event.sender
  if (sender.isDestroyed()) throw new Error('Renderer is no longer available.')
  if (!BrowserWindow.fromWebContents(sender)) throw new Error('Untrusted IPC sender.')
  if (event.senderFrame !== sender.mainFrame) throw new Error('Agent Runtime IPC requires the main frame.')
  if (!isTrustedRendererUrl(event.senderFrame.url)) throw new Error('Untrusted renderer URL.')
  return sender
}
