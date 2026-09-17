import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `app:open-external` answers a refused link with a code the renderer turns
 * into a sentence, so each failure has to come back as its own code: a valid
 * https address the OS would not open is not "not a link".
 */

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('./_wrap', () => ({
  ipcHandle: (channel: string, fn: (...args: unknown[]) => unknown) => {
    handlers.set(channel, fn)
  }
}))

const openExternal = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ shell: { openExternal } }))
vi.mock('../services/appIconService', () => ({ appIconService: { apply: vi.fn() } }))

const { registerAppHandlers } = await import('./app.ipc')
registerAppHandlers()
const open = (url: string): Promise<unknown> =>
  handlers.get('app:open-external')!({}, url) as Promise<unknown>

describe('app:open-external', () => {
  beforeEach(() => {
    openExternal.mockReset()
  })

  it('opens an https link', async () => {
    openExternal.mockResolvedValue(undefined)
    expect(await open('https://example.com/task/1')).toEqual({ success: true })
    expect(openExternal).toHaveBeenCalledWith('https://example.com/task/1')
  })

  it('calls a string that does not parse an invalid link, without asking the OS', async () => {
    expect(await open('not a url')).toEqual({ success: false, error: 'invalid_url' })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('refuses any scheme but http and https', async () => {
    expect(await open('file:///etc/passwd')).toEqual({ success: false, error: 'unsupported_protocol' })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('reports an OS refusal of a valid link as open_failed, not invalid_url', async () => {
    openExternal.mockRejectedValue(new Error('No application is associated'))
    expect(await open('https://example.com/task/1')).toEqual({ success: false, error: 'open_failed' })
  })
})
