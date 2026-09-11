import { describe, it, expect, vi } from 'vitest'
import { describeAdapterContract, type AdapterWorld } from './adapterContract'
import { CAPABILITY_SHAPES, createFakeRemote } from './testSupport/fakeRemote'
import { createFakeCinnaServer } from './testSupport/fakeCinnaServer'
import { createCinnaTaskAdapter } from './cinnaTaskAdapter'
import { adapterFor, hasAdapter } from './index'
import { createNullAdapter } from './nullAdapter'
import { UnsupportedRemoteOperation, type RemoteBinding } from './adapter'
import type { TaskDto } from '../../../shared/tasks'

/**
 * The contract, run over every adapter this build has — which today is **no
 * real one**, and that is the point of the step.
 *
 * §5.6's named risk is a seam shaped by a single implementation: `cinna` is the
 * only remote this phase ships, and an interface drawn around it acquires its
 * field names and breaks on the second integration. The mitigation is here, in
 * three parts — the capability set, so a poorer remote is *expressible* rather
 * than broken; this suite, written before the adapter that has to pass it; and
 * the four worked examples run as subjects, so "Linear has no asks" and
 * "GitHub Issues has no agent assignee" are executed rather than asserted in a
 * comment. If one of them needed a new field, the shape would be wrong and this
 * file would be where it showed.
 *
 * `cinnaTaskAdapter` joined as one more row in step 9, and it is the only
 * subject here that is not a fake: it runs the real mapping against a fake
 * *cinna server* that speaks the real routes and refuses the way the real one
 * does. Six green fakes prove the capability set can describe six services;
 * only this row proves a real mapping survives the seam.
 */

const USER = '__default__'

function makeTask(overrides: Partial<TaskDto> = {}): TaskDto {
  const now = new Date('2026-09-11T10:00:00.000Z')
  return {
    id: 'tsk_local',
    title: 'Reconcile payouts',
    goal: 'Reconcile payouts for the last 7 days',
    description: 'The ledger and the bank disagree by £12.',
    status: 'new',
    priority: 'normal',
    router: 'direct',
    origin: 'local',
    executor: 'desktop',
    executorDevice: null,
    chatId: null,
    assignee: { agentId: 'agt_1', name: 'Ledger agent', kind: 'agent' },
    parentTaskId: null,
    subtaskCount: 0,
    subtaskCompletedCount: 0,
    remote: null,
    handoffNote: null,
    artifacts: [],
    budget: null,
    errorMessage: null,
    jobId: null,
    jobRunId: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    ...overrides
  }
}

function fakeWorld(shape: keyof typeof CAPABILITY_SHAPES, ready = true): () => AdapterWorld {
  return () => {
    const remote = createFakeRemote({
      id: `fake-${shape}`,
      capabilities: CAPABILITY_SHAPES[shape],
      ready
    })
    return {
      adapter: remote.adapter,
      userId: USER,
      ready,
      task: makeTask(),
      subtask: makeTask({ id: 'tsk_child', parentTaskId: 'tsk_local' }),
      bind: async () =>
        remote.adapter.capabilities().create
          ? remote.adapter.create(USER, makeTask(), null)
          : remote.seed(makeTask()),
      requests: remote.requests,
      failTransport: () => remote.behave('transport'),
      denyOwnership: () => remote.behave('not_ours'),
      refuseWrite: () => remote.behave('rejected'),
      plantAsk: (binding: RemoteBinding) => {
        const id = 'ask-1'
        remote.plantAsk(binding.id, {
          id,
          request: {
            kind: 'question',
            questions: [
              {
                question: 'Which ledger?',
                multiSelect: false,
                options: [{ label: 'Sales' }, { label: 'Payouts' }]
              }
            ]
          }
        })
        return id
      }
    }
  }
}

// The four worked examples from §5.6, each as a subject.
describeAdapterContract('a full service', fakeWorld('full'))
describeAdapterContract('Linear — status, no asks, no execute', fakeWorld('linear'))
describeAdapterContract('GitHub Issues — no agent assignee, no nesting', fakeWorld('github'))
describeAdapterContract('Claude Managed Agents — asks, no comments', fakeWorld('managed'))
// Pull-only: bound by discovering a task, never by putting one there.
describeAdapterContract('a remote the desktop may only read', fakeWorld('readOnly'))

// A linked service is not the only state a profile is in.
describeAdapterContract('a profile that is not connected', fakeWorld('full', false))

/**
 * cinna-core — **the real adapter**, over a fake server rather than a fake
 * adapter.
 *
 * Everything below the transport is production code: the route paths, the
 * payload field names, the status-write refusal, the two-request `fetch`, the
 * translation of an unanswered tool-question message into an `InputRequest`,
 * and the error taxonomy that decides whether a failure costs the binding.
 */
function cinnaWorld(ready = true): () => AdapterWorld {
  return () => {
    const server = createFakeCinnaServer({ ready })
    const adapter = createCinnaTaskAdapter(server.world)
    return {
      adapter,
      userId: USER,
      ready,
      task: makeTask(),
      subtask: makeTask({ id: 'tsk_child', parentTaskId: 'tsk_local' }),
      bind: () => adapter.create(USER, makeTask(), null),
      requests: server.requests,
      failTransport: () => server.behave('transport'),
      denyOwnership: () => server.behave('not_ours'),
      refuseWrite: () => server.behave('rejected'),
      plantAsk: (binding: RemoteBinding) => server.plantAsk(binding.id)
    }
  }
}

describeAdapterContract('cinna-core, over its real routes', cinnaWorld())
describeAdapterContract('cinna-core on an unlinked profile', cinnaWorld(false))

// And the adapter for a service this build does not have must pass the same
// clauses: a task bound to it still has to open.
describeAdapterContract('a service this build does not have', () => {
  const adapter = createNullAdapter('linear')
  return {
    adapter,
    userId: USER,
    ready: false,
    task: makeTask(),
    subtask: makeTask({ id: 'tsk_child', parentTaskId: 'tsk_local' }),
    bind: async () => ({ adapter: 'linear', id: 'r-1', key: 'ENG-1', url: null, state: {} }),
    requests: () => 0,
    failTransport: () => {},
    denyOwnership: () => {},
    refuseWrite: () => {},
    plantAsk: () => {
      throw new Error('the null adapter has no asks; the clause should not have run')
    }
  }
})

/**
 * Each test gets a **fresh module**, because the registry is module state: a
 * test that registers an adapter would otherwise decide what "empty" means for
 * every test collected after it, and the order those run in is not something
 * this file controls.
 */
describe('the adapter registry', () => {
  async function freshRegistry(): Promise<typeof import('./index')> {
    vi.resetModules()
    return import('./index')
  }

  /**
   * The scenario the null adapter makes comfortable, and which is therefore the
   * one a missed registration would hide behind: a cinna-bound task would open
   * perfectly, show "a service this version of Cinna does not know about", sync
   * nothing, and log nothing, because nothing failed. Asserting the id is
   * *present* is the only thing that tells a shipped adapter from a dropped
   * side-effect import.
   */
  it('has the adapters this build ships, from the imports at the foot of the registry', async () => {
    const registry = await freshRegistry()
    expect(registry.hasAdapter('cinna')).toBe(true)
    expect(registry.allAdapters().map((a) => a.id)).toEqual(['cinna'])
    expect(registry.adapterFor('cinna').id).toBe('cinna')
  })

  it('resolves an unknown id to an adapter rather than to nothing', () => {
    const adapter = adapterFor('some-service-from-a-newer-build')
    expect(adapter.id).toBe('some-service-from-a-newer-build')
    expect(hasAdapter('some-service-from-a-newer-build')).toBe(false)
  })

  /**
   * The id is kept so the reason can name the service the task claims to be
   * on, and so `binding.adapter === adapter.id` holds here exactly as it does
   * for a real adapter — the invariant every caller leans on.
   */
  it('says which service a task it cannot reach is on', async () => {
    const availability = await adapterFor('linear').availability(USER)
    expect(availability.ready).toBe(false)
    expect(availability.reason).toContain('linear')
  })

  it('refuses every operation on an unknown service as the call-site bug it is', async () => {
    const adapter = adapterFor('linear')
    const binding: RemoteBinding = {
      adapter: 'linear',
      id: 'r-1',
      key: 'ENG-1',
      url: null,
      state: {}
    }
    await expect(adapter.pushStatus(USER, binding, 'in_progress')).rejects.toBeInstanceOf(
      UnsupportedRemoteOperation
    )
    await expect(adapter.fetch(USER, binding)).rejects.toBeInstanceOf(UnsupportedRemoteOperation)
    expect(adapter.deepLink(binding)).toBeNull()
  })

  it('is the same null adapter every time, so identity means something', () => {
    // Nothing keys on adapter identity today; something will, and a factory
    // minting a fresh object per call is the kind of trap that only shows up in
    // a `useMemo` dependency or a `Map`.
    expect(adapterFor('linear')).toBe(adapterFor('linear'))
    expect(adapterFor('linear')).not.toBe(adapterFor('github'))
  })

  it('refuses two adapters claiming one id, rather than letting the last one win', async () => {
    const registry = await freshRegistry()
    registry.registerAdapter(createFakeRemote({ id: 'contested' }).adapter)
    expect(() => registry.registerAdapter(createFakeRemote({ id: 'contested' }).adapter)).toThrow(
      /claim the id/
    )
  })

  it('lets the same adapter register twice, since a double import is not a collision', async () => {
    const registry = await freshRegistry()
    const remote = createFakeRemote({ id: 'imported-twice' })
    registry.registerAdapter(remote.adapter)
    expect(() => registry.registerAdapter(remote.adapter)).not.toThrow()
  })

  it('hands back the registered adapter once there is one', async () => {
    const registry = await freshRegistry()
    const remote = createFakeRemote({ id: 'registered-fake' })
    registry.registerAdapter(remote.adapter)

    expect(registry.adapterFor('registered-fake')).toBe(remote.adapter)
    expect(registry.hasAdapter('registered-fake')).toBe(true)
    expect(registry.allAdapters()).toContain(remote.adapter)
    // And an id it does not have is still the null adapter.
    expect(registry.hasAdapter('linear')).toBe(false)
    expect(registry.adapterFor('linear').capabilities().create).toBe(false)
  })
})
