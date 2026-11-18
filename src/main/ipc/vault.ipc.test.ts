import { describe, expect, it, vi } from 'vitest'

/**
 * `vault:set-runs-with` is transport only: activation first, the settings
 * scope's user, the options passed through unread (main validates them in
 * `moveService.setRunsWith`), and the answer as data through
 * `vaultService.result`, since a thrown code would not reach the renderer.
 */

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
const setRunsWith = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<void> => {}))
const requireActivated = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({ ipcMain: { on: vi.fn() } }))
vi.mock('./_wrap', () => ({ ipcHandle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) }))
vi.mock('../auth/activation', () => ({ userActivation: { requireActivated } }))
vi.mock('../auth/scope', () => ({ getSettingsScopeUserId: () => 'settings-user' }))
vi.mock('../vault/vaultTerminal', () => ({ openVaultTerminal: vi.fn() }))
vi.mock('../vault/moveService', () => ({ moveService: { setRunsWith } }))
vi.mock('../vault/vaultService', () => ({
  vaultService: {
    async result(fn: () => Promise<unknown>) {
      try {
        return { ok: true, data: await fn() }
      } catch (error) {
        const failure = error as { code?: string; message: string }
        return { ok: false, code: failure.code ?? 'internal', message: failure.message }
      }
    }
  }
}))

const { registerVaultHandlers } = await import('./vault.ipc')
registerVaultHandlers()

describe('vault:set-runs-with', () => {
  it('passes the options to main’s validated write for the settings scope, after activation', async () => {
    const options = { model: 'opus', effort: 'high', complexity: null }
    const answer = await handlers.get('vault:set-runs-with')!({}, 'folder:a', options)
    expect(requireActivated).toHaveBeenCalled()
    expect(setRunsWith).toHaveBeenCalledWith('settings-user', 'folder:a', options)
    expect(answer).toEqual({ ok: true, data: undefined })
  })

  it('answers a refusal as data, code and sentence', async () => {
    setRunsWith.mockRejectedValueOnce(Object.assign(new Error('Unlock the vault to change how it runs.'), { code: 'locked' }))
    const answer = await handlers.get('vault:set-runs-with')!({}, 'folder:a', { model: null, effort: null, complexity: 'simple' })
    expect(answer).toEqual({ ok: false, code: 'locked', message: 'Unlock the vault to change how it runs.' })
  })
})
