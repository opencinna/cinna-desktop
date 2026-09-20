import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeHost } from './runtimeHost'

beforeEach(() => vi.resetModules())
describe('runtime host installation', () => {
  it('does not silently select a platform or touch host paths during import', async () => {
    const { runtimeHost } = await import('./runtimeHost')
    expect(() => runtimeHost.getPath('userData')).toThrow('Runtime host is not installed')
  })
  it('resolves paths lazily and preserves the receiver of injected methods', async () => {
    const { runtimeHost, installRuntimeHost } = await import('./runtimeHost')
    const host = { root: '/first', getPath() { return this.root } }
    installRuntimeHost(host as unknown as RuntimeHost)
    expect(runtimeHost.getPath('userData')).toBe('/first')
    host.root = '/isolated-profile'
    expect(runtimeHost.getPath('userData')).toBe('/isolated-profile')
  })
})
