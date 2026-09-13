import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalDevState } from '../../../shared/localDevState'

vi.mock('./logger.store', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn() })
}))

import { useLocalDevStore } from './localDev.store'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const oldReady: LocalDevState = {
  phase: 'ready', workspacePath: '/profile-a/workspace', cliVersion: '0.4.0',
  cinnaBinPath: '/managed/bin/cinna', protocol: 'json'
}
let onState: (state: LocalDevState) => void
const api = {
  onState: vi.fn((callback: (state: LocalDevState) => void) => { onState = callback; return () => {} }),
  getState: vi.fn(async (): Promise<LocalDevState> => ({ phase: 'idle' })),
  consent: vi.fn(async (_host: string, _accepted: boolean): Promise<LocalDevState> => oldReady),
  resetConsent: vi.fn(async (_host: string): Promise<LocalDevState> => oldReady),
  repair: vi.fn(async (): Promise<LocalDevState> => oldReady)
}

beforeEach(() => {
  vi.clearAllMocks()
  window.api = { localDev: api } as unknown as typeof window.api
  useLocalDevStore.getState().set({ phase: 'idle' })
  useLocalDevStore.setState({ subscribed: false })
})

describe('local development IPC response ordering', () => {
  it('keeps a newer pushed state when the initial snapshot arrives late', async () => {
    const snapshot = deferred<LocalDevState>()
    api.getState.mockReturnValueOnce(snapshot.promise)
    const subscribe = useLocalDevStore.getState().subscribe()
    onState({ phase: 'consent', host: 'profile-b.example.com' })
    snapshot.resolve(oldReady)
    await subscribe
    expect(useLocalDevStore.getState().state).toEqual({ phase: 'consent', host: 'profile-b.example.com' })
  })

  it.each(['consent', 'resetConsent', 'repair'] as const)(
    'ignores a former profile %s reply after idle and a newer state', async (action) => {
      await useLocalDevStore.getState().subscribe()
      const reply = deferred<LocalDevState>()
      api[action].mockReturnValueOnce(reply.promise)
      const pending = action === 'consent'
        ? useLocalDevStore.getState().consent('profile-a.example.com', true)
        : action === 'resetConsent'
          ? useLocalDevStore.getState().resetConsent('profile-a.example.com')
          : useLocalDevStore.getState().repair()
      onState({ phase: 'idle' })
      onState({ phase: 'consent', host: 'profile-b.example.com' })
      reply.resolve(oldReady)
      await pending
      expect(useLocalDevStore.getState().state).toEqual({ phase: 'consent', host: 'profile-b.example.com' })
      expect(useLocalDevStore.getState().answeredHosts).toEqual([])
    }
  )

  it('keeps a newer same-host consent marker when the former profile answer rejects', async () => {
    await useLocalDevStore.getState().subscribe()
    const oldReply = deferred<LocalDevState>()
    const newReply = deferred<LocalDevState>()
    api.consent.mockReturnValueOnce(oldReply.promise).mockReturnValueOnce(newReply.promise)
    const oldAnswer = useLocalDevStore.getState().consent('shared.example.com', true)
    onState({ phase: 'idle' })
    const newAnswer = useLocalDevStore.getState().consent('shared.example.com', true)
    oldReply.reject(new Error('Old profile deactivated'))
    await oldAnswer
    expect(useLocalDevStore.getState().answeredHosts).toEqual(['shared.example.com'])
    newReply.resolve({ phase: 'declined', host: 'shared.example.com' })
    await newAnswer
  })

  it('accepts the current action reply when no newer state has arrived', async () => {
    await useLocalDevStore.getState().subscribe()
    await useLocalDevStore.getState().repair()
    expect(useLocalDevStore.getState().state).toEqual(oldReady)
  })
})
