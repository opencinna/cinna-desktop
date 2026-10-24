import { describe, it, expect, afterEach, vi } from 'vitest'

vi.mock('../../db/users', () => ({ userRepo: { get: () => undefined } }))
vi.mock('../../db/addonPolicies', () => ({ addonPolicyRepo: { get: () => null, set: () => undefined } }))
vi.mock('../../auth/scope', () => ({ getProfileScopeUserId: () => 'profile' }))

const { addonPolicies, storedPolicy } = await import('./policy')
const { DEFAULT_ADDON_POLICY } = await import('../../../shared/addons/directory')

/**
 * Core's addon policy is the active Cinna account's: kept across a restart
 * so an unreachable core does not open everything up, and the default with
 * no account (signed out, a local-only profile) whatever an account had.
 */

const STRICT = { externalDirectories: false, customMcp: false, pluginHooks: false, stdioMcp: false }
const SCOPE = '__default__'

/** A store on disk that outlives the in-memory map (a "restart" is `_configure` again over it). */
function disk() {
  const rows = new Map<string, unknown>()
  return {
    rows,
    load: vi.fn((account: string) => rows.get(account) ?? null),
    save: vi.fn((account: string, policy: unknown) => {
      rows.set(account, JSON.parse(JSON.stringify(policy)))
    })
  }
}

afterEach(() => addonPolicies._reset())

describe('addonPolicies', () => {
  it('applies the last policy core sent after a restart with core unreachable', () => {
    const store = disk()
    addonPolicies._configure({ account: () => 'p1@https://core', load: store.load, save: store.save })
    expect(addonPolicies.get(SCOPE)).toEqual(DEFAULT_ADDON_POLICY)
    addonPolicies.set(SCOPE, STRICT)
    expect(store.save).toHaveBeenCalledWith('p1@https://core', STRICT)

    // Restart: memory gone, the store kept.
    addonPolicies._configure({ account: () => 'p1@https://core', load: store.load, save: store.save })
    expect(addonPolicies.get(SCOPE)).toEqual(STRICT)
    expect(addonPolicies.store().get(SCOPE)).toEqual(STRICT)
  })

  it('is the default with no account, and an account never sent a policy reads the default too', () => {
    const store = disk()
    store.rows.set('p1@https://core', STRICT)
    let account: string | null = 'p1@https://core'
    addonPolicies._configure({ account: () => account, load: store.load, save: store.save })
    expect(addonPolicies.get(SCOPE)).toEqual(STRICT)
    account = null
    expect(addonPolicies.get(SCOPE)).toEqual(DEFAULT_ADDON_POLICY)
    expect(addonPolicies.store().get(SCOPE)).toBeUndefined()
    // Nothing is written for no account.
    addonPolicies.set(SCOPE, STRICT)
    expect(store.save).not.toHaveBeenCalled()
    account = 'p2@https://other'
    expect(addonPolicies.get(SCOPE)).toEqual(DEFAULT_ADDON_POLICY)
  })

  it('writes only a changed policy, and survives a store that cannot be read or written', () => {
    const store = disk()
    addonPolicies._configure({ account: () => 'p1@https://core', load: store.load, save: store.save })
    addonPolicies.set(SCOPE, STRICT)
    addonPolicies.set(SCOPE, { ...STRICT })
    expect(store.save).toHaveBeenCalledTimes(1)

    addonPolicies._configure({
      account: () => 'p1@https://core',
      load: () => {
        throw new Error('no database')
      },
      save: () => {
        throw new Error('no database')
      }
    })
    expect(addonPolicies.get(SCOPE)).toEqual(DEFAULT_ADDON_POLICY)
    addonPolicies.set(SCOPE, STRICT)
    expect(addonPolicies.get(SCOPE)).toEqual(STRICT)
  })

  it('files a policy under the account its read started for, not the one active when core answered', () => {
    const store = disk()
    let account: string | null = 'a@https://core'
    addonPolicies._configure({ account: () => account, load: store.load, save: store.save })
    const started = addonPolicies.store().account()
    account = 'b@https://core'
    addonPolicies.store().set(SCOPE, STRICT, started)
    expect(store.save).toHaveBeenCalledWith('a@https://core', STRICT)
    expect(addonPolicies.get(SCOPE)).toEqual(DEFAULT_ADDON_POLICY)
    account = 'a@https://core'
    expect(addonPolicies.get(SCOPE)).toEqual(STRICT)
    // A read started with no account files nothing.
    addonPolicies.store().set(SCOPE, DEFAULT_ADDON_POLICY, null)
    expect(store.save).toHaveBeenCalledTimes(1)
  })

  it('reads a stored policy only when every flag is a boolean', () => {
    expect(storedPolicy(STRICT)).toEqual(STRICT)
    expect(storedPolicy({ ...STRICT, stdioMcp: 'no' })).toBeNull()
    expect(storedPolicy({ externalDirectories: false })).toBeNull()
    expect(storedPolicy('x')).toBeNull()
  })
})
