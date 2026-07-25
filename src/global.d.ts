/**
 * Ambient declarations for Electron's preload bridge.
 *
 * In a regular browser dev session `window.electronAPI` is undefined; in
 * the Electron wrapper the preload script injects it before the React
 * app boots.
 */

import type { ElectronAPI } from '../electron/preload'

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}

export {}
