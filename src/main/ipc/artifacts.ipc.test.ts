import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The artifacts adapter: every channel is gated on activation and hands the
 * renderer's payload to the service untouched (the service validates it), so
 * nothing the renderer sends is trusted here — and the answer, a refusal
 * included, comes back as data.
 */

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('./_wrap', () => ({
  ipcHandle: (channel: string, fn: (...args: unknown[]) => unknown) => {
    handlers.set(channel, fn)
  }
}))
const requireActivated = vi.hoisted(() => vi.fn())
vi.mock('../auth/activation', () => ({ userActivation: { requireActivated } }))
const service = vi.hoisted(() => ({
  support: vi.fn(),
  inspect: vi.fn(),
  publish: vi.fn(),
  cards: vi.fn(),
  detail: vi.fn(),
  setVisibility: vi.fn(),
  createLink: vi.fn(),
  revokeLink: vi.fn(),
  local: vi.fn()
}))
const approvals = vi.hoisted(() => ({ list: vi.fn(), answer: vi.fn() }))
vi.mock('../services/artifacts/artifactService', () => ({ artifactService: service, artifactApprovals: approvals }))
vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => 'profile-1' }))

const { registerArtifactHandlers } = await import('./artifacts.ipc')
registerArtifactHandlers()

const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)

beforeEach(() => {
  requireActivated.mockReset()
  for (const fn of [...Object.values(service), ...Object.values(approvals)]) fn.mockReset()
})

describe('artifacts IPC', () => {
  it('registers exactly the artifact channels', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'artifacts:answer-approval',
      'artifacts:approvals',
      'artifacts:cards',
      'artifacts:create-link',
      'artifacts:detail',
      'artifacts:inspect',
      'artifacts:local',
      'artifacts:publish',
      'artifacts:revoke-link',
      'artifacts:set-visibility',
      'artifacts:support'
    ])
  })

  it('passes each payload through in the shape the service takes', async () => {
    const input = { agentId: 'folder:a', path: '/abs/q3', title: 'Q3', visibility: 'link', operationId: 'op', anchor: { chatId: 'c', messageId: 'm' } }
    service.publish.mockResolvedValue({ ok: false, code: 'gone', message: 'gone' })
    expect(await call('artifacts:publish', input)).toEqual({ ok: false, code: 'gone', message: 'gone' })
    expect(service.publish).toHaveBeenCalledWith(input)

    await call('artifacts:inspect', { agentId: 'folder:a', path: '/abs/q3', entry: 'b.html' })
    expect(service.inspect).toHaveBeenCalledWith({ agentId: 'folder:a', path: '/abs/q3', entry: 'b.html' })
    await call('artifacts:cards', 'chat-1')
    expect(service.cards).toHaveBeenCalledWith('chat-1')
    await call('artifacts:detail', 'id-1')
    expect(service.detail).toHaveBeenCalledWith('id-1')
    await call('artifacts:set-visibility', { artifactId: 'id-1', visibility: 'instance' })
    expect(service.setVisibility).toHaveBeenCalledWith('id-1', 'instance')
    await call('artifacts:create-link', { artifactId: 'id-1', withCode: 'yes' })
    expect(service.createLink).toHaveBeenCalledWith('id-1', { withCode: false })
    await call('artifacts:revoke-link', { artifactId: 'id-1', linkId: 'l-1' })
    expect(service.revokeLink).toHaveBeenCalledWith('id-1', 'l-1')
    await call('artifacts:set-visibility', undefined)
    expect(service.setVisibility).toHaveBeenLastCalledWith(undefined, undefined)
    expect(requireActivated).toHaveBeenCalledTimes(8)
  })

  it('answers an approval for the active profile only, with the edits read field by field', async () => {
    approvals.answer.mockResolvedValue({ ok: true })
    approvals.list.mockReturnValue([{ requestId: 'art_1' }])
    expect(await call('artifacts:approvals', 'chat-1')).toEqual([{ requestId: 'art_1' }])
    expect(approvals.list).toHaveBeenCalledWith('profile-1', 'chat-1')
    expect(await call('artifacts:approvals', 5)).toEqual([])
    await call('artifacts:answer-approval', { requestId: 'art_1', decision: 'deny' })
    expect(approvals.answer).toHaveBeenLastCalledWith('profile-1', 'art_1', 'deny', undefined)
    await call('artifacts:answer-approval', {
      requestId: 'art_1', decision: 'publish',
      edits: { title: 'T', description: 'D', entry: '', artifactId: 'id', visibility: 'public', extra: 1 }
    })
    expect(approvals.answer).toHaveBeenLastCalledWith('profile-1', 'art_1', 'publish', { title: 'T', description: 'D', entry: null, artifactId: 'id', visibility: 'private' })
    expect(await call('artifacts:answer-approval', { requestId: 'art_1', decision: 'maybe' })).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(approvals.answer).toHaveBeenCalledTimes(2)
    await call('artifacts:local', 'id-9')
    expect(service.local).toHaveBeenCalledWith('id-9')
  })

  it('refuses before the service when the app is not activated', async () => {
    requireActivated.mockImplementation(() => {
      throw new Error('not activated')
    })
    expect(() => call('artifacts:support')).toThrow('not activated')
    expect(() => call('artifacts:cards', 'c')).toThrow('not activated')
    expect(service.support).not.toHaveBeenCalled()
    expect(service.cards).not.toHaveBeenCalled()
  })
})
