import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionActivityItem } from '../../shared/sessionActivity'
import { createSessionActivityHub } from './sessionActivityHub'
import {
  installSessionActivityStopper,
  stopSessionActivity,
  type SessionActivityStopOutcome,
  type SessionActivityStopper
} from './sessionActivityStop'

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

/**
 * Stop, engine-neutral: the hub decides what can be asked, a provider's
 * stopper does the asking, and every refusal comes back as data.
 */

const CHAT = 'chat-1'
const uninstalls: (() => void)[] = []
afterEach(() => { for (const off of uninstalls.splice(0)) off() })

function install(provider: string, stop: SessionActivityStopper['stop']): SessionActivityStopper {
  const stopper = { stop: vi.fn(stop) }
  uninstalls.push(installSessionActivityStopper(provider, stopper))
  return stopper
}

function hubWith(canStop = true) {
  const hub = createSessionActivityHub()
  hub.report(CHAT, 'agent', { type: 'upsert', id: 'ses:bg', kind: 'background', title: 'sleep 120', canStop })
  return hub
}

const answer = (outcome: SessionActivityStopOutcome | null) => async () => outcome

describe('stopSessionActivity', () => {
  it('answers ok when the provider stopped the item, and hands it the item', async () => {
    const hub = hubWith()
    const stopper = install('p', answer('stopped'))

    expect(await stopSessionActivity(CHAT, 'ses:bg', hub)).toEqual({ ok: true })
    expect(stopper.stop).toHaveBeenCalledWith(CHAT, expect.objectContaining<Partial<SessionActivityItem>>({ id: 'ses:bg', agentId: 'agent', state: 'running' }))
  })

  it.each([
    ['already_ended', 'This process had already ended.'],
    ['unavailable', 'The agent did not answer. Try again in a moment.']
  ] as const)('passes a %s answer on with its sentence', async (outcome, reason) => {
    install('p', answer(outcome))
    expect(await stopSessionActivity(CHAT, 'ses:bg', hubWith())).toEqual({ ok: false, code: outcome, reason })
  })

  it('says already_ended for an item the hub has ended, without asking anyone', async () => {
    const hub = hubWith()
    hub.report(CHAT, 'agent', { type: 'end', id: 'ses:bg', state: 'completed' })
    const stopper = install('p', answer('stopped'))

    expect(await stopSessionActivity(CHAT, 'ses:bg', hub)).toMatchObject({ ok: false, code: 'already_ended', reason: 'This process had already ended.' })
    expect(stopper.stop).not.toHaveBeenCalled()
  })

  it.each([
    ['an unknown item', true, 'ses:nope'],
    ['an item that cannot be stopped', false, 'ses:bg']
  ])('refuses %s as not_stoppable', async (_label, canStop, id) => {
    const stopper = install('p', answer('stopped'))
    expect(await stopSessionActivity(CHAT, id, hubWith(canStop))).toMatchObject({
      ok: false, code: 'not_stoppable', reason: 'This process can no longer be stopped from here.'
    })
    expect(stopper.stop).not.toHaveBeenCalled()
  })

  it('asks the next provider when one does not know the item, and refuses when none does', async () => {
    const hub = hubWith()
    install('a', answer(null))
    expect(await stopSessionActivity(CHAT, 'ses:bg', hub)).toMatchObject({ ok: false, code: 'not_stoppable' })
    install('b', answer('stopped'))
    expect(await stopSessionActivity(CHAT, 'ses:bg', hub)).toEqual({ ok: true })
  })

  it('turns a throwing stopper into unavailable', async () => {
    install('p', async () => { throw new Error('boom') })
    expect(await stopSessionActivity(CHAT, 'ses:bg', hubWith())).toMatchObject({ ok: false, code: 'unavailable' })
  })

  it('says already_ended when the item ended while an unanswered stop waited', async () => {
    const hub = hubWith()
    install('p', async () => {
      hub.report(CHAT, 'agent', { type: 'end', id: 'ses:bg', state: 'completed' })
      return 'unavailable'
    })
    expect(await stopSessionActivity(CHAT, 'ses:bg', hub)).toMatchObject({ ok: false, code: 'already_ended' })
  })

  it('replaces a provider installed twice, and uninstalls only its own', async () => {
    const hub = hubWith()
    const first = { stop: vi.fn(answer('unavailable')) }
    const offFirst = installSessionActivityStopper('p', first)
    install('p', answer('stopped'))
    offFirst()
    expect(await stopSessionActivity(CHAT, 'ses:bg', hub)).toEqual({ ok: true })
    expect(first.stop).not.toHaveBeenCalled()
  })
})
