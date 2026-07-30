import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

import { invoke } from '@tauri-apps/api/core'
import { getAppVersion } from '../../src/lib/tauri-api'

describe('tauri-api', () => {
  it('getAppVersion invokes app_version command', async () => {
    vi.mocked(invoke).mockResolvedValue('0.1.0')
    const version = await getAppVersion()
    expect(invoke).toHaveBeenCalledWith('app_version')
    expect(version).toBe('0.1.0')
  })
})
