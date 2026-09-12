import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * **Which runtime this machine decides on, and when it is allowed to decide.**
 *
 * The decision is written once and then honoured for ever, so every case here is
 * about a *first* launch — the only moment the answer is up for grabs. The one
 * that matters most is the upgrade: an install that already runs folder agents
 * must keep running them the way it has, because the alternative is moving
 * somebody's agents from the API key they chose onto a subscription, and onto
 * Claude Code's own permission reviewer, on the strength of an app update.
 */

const store = vi.hoisted(() => ({ value: '' as string, broken: false }))
vi.mock('../appSettingsService', () => ({
  appSettingsService: {
    getAll: () => {
      if (store.broken) throw new Error('the database is not open')
      return { localAgentsDefaultEngine: store.value }
    },
    set: (_key: string, value: string) => {
      if (store.broken) throw new Error('the database is not open')
      store.value = value
    }
  }
}))

const machine = vi.hoisted(() => ({
  claude: false,
  folderAgents: 0,
  /** Held open by a test that needs detection to still be running. */
  gate: null as Promise<void> | null
}))
vi.mock('./toolDetectionService', () => ({
  toolDetectionService: {
    list: async () => {
      if (machine.gate) await machine.gate
      return [{ id: 'claude', available: machine.claude }]
    },
    snapshot: () => [{ id: 'claude', available: machine.claude }]
  }
}))
vi.mock('../../db/agents', () => ({
  agentRepo: { countFolderAgents: () => machine.folderAgents }
}))
vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

/** A fresh module per case: the settling pass is memoized for the app's life. */
async function service(): Promise<typeof import('./defaultEngineService').defaultEngineService> {
  vi.resetModules()
  return (await import('./defaultEngineService')).defaultEngineService
}

beforeEach(() => {
  store.value = ''
  store.broken = false
  machine.claude = false
  machine.folderAgents = 0
  machine.gate = null
})

describe('locking the default runtime', () => {
  it('takes the runtime it finds on a machine with no agents yet', async () => {
    machine.claude = true
    const locked = await (await service()).lockIfUnset()
    expect(locked).toBe('claude')
    expect(store.value).toBe('claude')
  })

  it('falls back to the OpenCode runner when it finds nothing', async () => {
    // The only choice that is true on a machine with no developer tooling: Cinna
    // downloads that binary for itself.
    expect(await (await service()).lockIfUnset()).toBe('opencode')
    expect(store.value).toBe('opencode')
  })

  it('leaves an install that already runs folder agents where it is', async () => {
    // The upgrade case, and the reason this is not simply "whatever is
    // installed wins". Mutation: dropping the `countFolderAgents` guard fails
    // this and re-homes every existing agent onto the user's Claude plan.
    machine.claude = true
    machine.folderAgents = 5
    expect(await (await service()).lockIfUnset()).toBe('opencode')
    expect(store.value).toBe('opencode')
  })

  it('never moves a decision that has already been made', async () => {
    // Including one the user made themselves: this returns null and writes
    // nothing, which is also how the caller knows the agent rows do not need
    // re-indexing.
    store.value = 'opencode'
    machine.claude = true
    expect(await (await service()).lockIfUnset()).toBeNull()
    expect(store.value).toBe('opencode')
  })

  it('keeps a runtime the user picked while detection was still running', async () => {
    // Detection is a login-shell probe and the picker is live meanwhile. The
    // lock re-reads the setting after the await: a choice made in that window
    // is a decision already made, not an empty slot to fill.
    machine.claude = true
    let release!: () => void
    machine.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = (await service()).lockIfUnset()
    store.value = 'opencode'
    release()
    expect(await pending).toBeNull()
    expect(store.value).toBe('opencode')
  })

  it('settles once, however many callers ask', async () => {
    // Startup fires it and `settings:get-all` awaits it. Two passes would mean
    // two login-shell probes, and — worse — a second one could write a
    // different answer than the first.
    machine.claude = true
    const subject = await service()
    const [first, second] = await Promise.all([subject.lockIfUnset(), subject.lockIfUnset()])
    expect(first).toBe('claude')
    // The second call joined the same pass rather than starting its own; only
    // one of them can be the writer.
    expect(second).toBe('claude')
    expect(await subject.lockIfUnset()).toBe('claude')
  })

  it('answers with the OpenCode runner when the settings store cannot be read', async () => {
    store.broken = true
    const subject = await service()
    // Never throws: this runs on the startup path, and a desktop that does not
    // open is a worse outcome than a runtime decided on the next launch. The
    // next one retries, because nothing was written.
    expect(await subject.lockIfUnset()).toBeNull()
    expect(subject.current()).toBe('opencode')
  })
})

describe('reading the default runtime', () => {
  it('is the stored answer, and asks the machine nothing once there is one', async () => {
    store.value = 'claude'
    const subject = await service()
    expect(subject.current()).toBe('claude')
    expect(await subject.resolved()).toEqual({ engine: 'claude' })
  })

  it('answers from what the machine has while the decision is still unmade', async () => {
    /**
     * The window between launch and the lock, which the synchronous readers —
     * the scanner, the DTO mapper, the engine's config assembly — can land in.
     * It answers from the detection snapshot, so it agrees with the value the
     * lock is about to write rather than contradicting it for a second.
     *
     * Where it *cannot* agree is when no pass has finished yet: an empty
     * snapshot reads as "no claude", which is the OpenCode runner — the
     * conservative direction, and what the lock's own re-index exists to
     * correct.
     */
    machine.claude = true
    expect((await service()).current()).toBe('claude')
    machine.claude = false
    expect((await service()).current()).toBe('opencode')
  })
})
