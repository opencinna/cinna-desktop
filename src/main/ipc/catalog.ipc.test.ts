vi.mock('../host/runtimeHost', async () => {
  const { createDesktopHost } = await import('../host/desktop/runtimeHost')
  return { runtimeHost: createDesktopHost() }
})
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { unwrapCatalogOutcome, type CatalogOutcome } from '../../shared/catalog'

/**
 * `catalog:list` and `catalog:quick-install` must deliver their failure
 * **code** to the renderer. A thrown code is stripped by `ipcMain.handle` and
 * `contextBridge` (see `_wrap.ts`), which left the catalog's Re-authenticate
 * button and the install's "session expired" message unreachable. So the
 * handlers resolve with the code as data, and the renderer rebuilds the error.
 */

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('./_wrap', () => ({
  ipcHandle: (channel: string, fn: (...args: unknown[]) => unknown) => {
    handlers.set(channel, fn)
  }
}))
vi.mock('../auth/activation', () => ({ userActivation: { requireActivated: () => undefined } }))
vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => 'u-cinna' }))

const listMock = vi.hoisted(() => vi.fn())
const installMock = vi.hoisted(() => vi.fn())
vi.mock('../services/catalogService', () => ({
  catalogService: { list: listMock, quickInstall: installMock }
}))
vi.mock('electron', () => ({ net: { fetch: vi.fn() }, shell: {}, app: { on: () => undefined } }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { registerCatalogHandlers } = await import('./catalog.ipc')
const { CinnaApiError } = await import('../errors')
const { CinnaReauthRequired } = await import('../auth/cinna-oauth')

beforeEach(() => {
  vi.clearAllMocks()
  handlers.clear()
  registerCatalogHandlers()
})

const invoke = (channel: string, ...args: unknown[]): Promise<CatalogOutcome<unknown>> =>
  Promise.resolve(handlers.get(channel)!({}, ...args)) as Promise<CatalogOutcome<unknown>>

describe('catalog handlers return a failure code as data', () => {
  it('wraps a successful list', async () => {
    listMock.mockResolvedValue([{ bundleId: 'b' }])
    expect(await invoke('catalog:list')).toEqual({ success: true, value: [{ bundleId: 'b' }] })
    expect(listMock).toHaveBeenCalledWith('u-cinna')
  })

  it('returns an expired session from the api layer as reauth_required', async () => {
    listMock.mockRejectedValue(new CinnaApiError('reauth_required', 'Session expired'))
    expect(await invoke('catalog:list')).toEqual({
      success: false,
      code: 'reauth_required',
      message: 'Session expired'
    })
  })

  it('returns a raw, not yet normalised, expired session as reauth_required', async () => {
    installMock.mockRejectedValue(new CinnaReauthRequired())
    const result = await invoke('catalog:quick-install', 'acme/invoices')
    expect(result).toMatchObject({ success: false, code: 'reauth_required' })
    expect(installMock).toHaveBeenCalledWith('u-cinna', 'acme/invoices')
  })

  it('still throws an uncoded failure, so the wrapper logs it', async () => {
    installMock.mockRejectedValue(new Error('socket hang up'))
    await expect(invoke('catalog:quick-install', 'acme/invoices')).rejects.toThrow('socket hang up')
  })

  it('round-trips: the renderer rebuilds an error that still carries the code', async () => {
    listMock.mockRejectedValue(new CinnaApiError('reauth_required', 'Session expired'))
    const outcome = await invoke('catalog:list')
    // What crosses IPC is plain data; cloning it is what the boundary does.
    const received = structuredClone(outcome)
    let thrown: unknown
    try {
      unwrapCatalogOutcome(received)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as { code?: string }).code).toBe('reauth_required')
    expect((thrown as Error).message).toBe('Session expired')
  })
})
