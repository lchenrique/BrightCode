/**
 * Ambient declarations for the renderer ↔ Tauri bridge.
 *
 * In a regular browser dev session the `tauri-bridge` installer is a
 * no-op and `window.electronAPI` is undefined. Under Tauri the bridge
 * installer (`src/lib/tauri-bridge.ts`) exposes an object conforming to
 * `ElectronAPI` so the renderer code keeps working unchanged.
 */

import type { ElectronAPI } from './lib/electron-api-types'

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}

export {}
