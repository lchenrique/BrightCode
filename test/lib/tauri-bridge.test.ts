import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
vi.mock('@tauri-apps/api/path', () => ({ homeDir: vi.fn(async () => 'C:/Users/test') }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))
vi.mock('@tauri-apps/plugin-fs', () => ({ mkdir: vi.fn() }))

async function installBridge() {
  vi.resetModules()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { __TAURI_INTERNALS__: {} },
  })
  const { installTauriBridge } = await import('../../src/lib/tauri-bridge')
  installTauriBridge()
  return window.electronAPI!
}

describe('Tauri renderer bridge', () => {
  beforeEach(() => {
    mocks.invoke.mockReset().mockResolvedValue(undefined)
    mocks.listen.mockReset().mockImplementation(async () => vi.fn())
  })

  it('exposes synchronous listener cleanup while Tauri registers asynchronously', async () => {
    const api = await installBridge()
    const cleanup = api.projects.onChanged(vi.fn())

    expect(cleanup).toBeTypeOf('function')
    cleanup()
    await vi.waitFor(() => expect(mocks.listen).toHaveBeenCalledWith('projects:changed', expect.any(Function)))
  })

  it('registers provider listeners before invoking nested stream payload', async () => {
    const api = await installBridge()
    api.providerStream({
      requestId: 'stream-1',
      providerId: 'minimax',
      apiFormat: 'openai-chat',
      url: 'https://api.minimax.io/v1/chat/completions',
      method: 'POST',
      headers: { authorization: 'Bearer test' },
      body: '{}',
    })

    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalled())
    expect(mocks.listen).toHaveBeenCalledTimes(3)
    expect(mocks.invoke).toHaveBeenCalledWith('provider_stream_start', {
      payload: {
        requestId: 'stream-1',
        providerId: 'minimax',
        apiFormat: 'openai-chat',
        url: 'https://api.minimax.io/v1/chat/completions',
        method: 'POST',
        headers: { authorization: 'Bearer test' },
        body: '{}',
      },
    })
    const invokeOrder = mocks.invoke.mock.invocationCallOrder[0]!
    expect(mocks.listen.mock.invocationCallOrder.every((order) => order < invokeOrder)).toBe(true)
  })
})
