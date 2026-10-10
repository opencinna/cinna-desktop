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
const itemsMock = vi.hoisted(() => vi.fn())
const itemDetailMock = vi.hoisted(() => vi.fn())
vi.mock('../services/libraryService', () => ({
  libraryService: { items: itemsMock, itemDetail: itemDetailMock }
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

/**
 * The one-catalog dialog's reads: the whole listing from main's cache, and one
 * item's versions. Both under the profile scope, and both return a failure's
 * code as data so the detail can say it in place.
 */
describe('catalog:items and catalog:item', () => {
  it('reads the cached listing, and lists again only when the renderer asks', async () => {
    const listing = { host: 'https://core.test', items: [], fetchedAt: '2026-10-10T00:00:00.000Z', available: true }
    itemsMock.mockResolvedValue(listing)
    expect(await invoke('catalog:items', { refresh: true })).toEqual({ success: true, value: listing })
    expect(itemsMock).toHaveBeenLastCalledWith('u-cinna', true)
    await invoke('catalog:items')
    expect(itemsMock).toHaveBeenLastCalledWith('u-cinna', false)
    // Only a real `true` refreshes.
    await invoke('catalog:items', { refresh: 'yes' })
    expect(itemsMock).toHaveBeenLastCalledWith('u-cinna', false)
  })

  it('reads one item by uuid, and nothing else as the uuid', async () => {
    itemDetailMock.mockResolvedValue({ uuid: 'u1', revisions: [] })
    expect(await invoke('catalog:item', { uuid: 'u1' })).toEqual({ success: true, value: { uuid: 'u1', revisions: [] } })
    expect(itemDetailMock).toHaveBeenLastCalledWith('u-cinna', 'u1')
    await invoke('catalog:item', { uuid: 42 })
    expect(itemDetailMock).toHaveBeenLastCalledWith('u-cinna', '')
  })

  it('returns a refused detail and an expired session as codes', async () => {
    itemDetailMock.mockRejectedValue(new CinnaApiError('request_failed', 'Not Found', undefined, 404))
    expect(await invoke('catalog:item', { uuid: 'gone' })).toEqual({
      success: false,
      code: 'request_failed',
      message: 'Not Found'
    })
    itemsMock.mockRejectedValue(new CinnaReauthRequired())
    expect(await invoke('catalog:items', { refresh: true })).toMatchObject({ success: false, code: 'reauth_required' })
  })
})
