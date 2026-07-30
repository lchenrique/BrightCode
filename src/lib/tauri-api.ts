import { invoke } from '@tauri-apps/api/core'

export async function getAppVersion(): Promise<string> {
  return invoke<string>('app_version')
}
