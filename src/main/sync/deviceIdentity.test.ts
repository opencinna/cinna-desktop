import { describe, it, expect } from 'vitest'
import { identifyThisDevice } from './deviceIdentity'

/**
 * The decision that used to be `?? devices[0]`.
 *
 * It is tested on its own rather than through `syncService.init`, because
 * reaching it there means standing up the envelope crypto, the device keypair
 * codec, the server API and QR generation — a mock surface large enough to
 * flatter the thing it is checking. What has to be right is a rule about a
 * list, and this is that rule.
 *
 * The stake is not "which envelope do we unwrap". It is which tasks this device
 * believes it may write: `sync_state.device_id` feeds `taskRunsHere`, so an id
 * borrowed from another machine hands this one write authority over every run
 * that machine holds.
 */
describe('identifying this device among the account’s devices', () => {
  const mine = { id: 'dev-mine', public_key: 'pk-mine' }
  const theirs = { id: 'dev-theirs', public_key: 'pk-theirs' }

  it('matches on the public key, wherever it is in the list', () => {
    expect(identifyThisDevice([theirs, mine], 'pk-mine')).toBe(mine)
  })

  it('takes the only device on the account when there is exactly one', () => {
    // The shape `init` produces: it registers this device in the same request
    // that creates the account, so the sole candidate is necessarily this one.
    expect(identifyThisDevice([{ id: 'dev-1', public_key: null }], 'pk-mine')?.id).toBe('dev-1')
  })

  /** The finding. Guessing here is guessing about write authority. */
  it('refuses to guess between several devices it cannot identify', () => {
    expect(identifyThisDevice([theirs, { id: 'dev-other' }], 'pk-mine')).toBeNull()
  })

  it('is null for an absent or empty list', () => {
    expect(identifyThisDevice(undefined, 'pk-mine')).toBeNull()
    expect(identifyThisDevice(null, 'pk-mine')).toBeNull()
    expect(identifyThisDevice([], 'pk-mine')).toBeNull()
  })

  /**
   * An empty key matches nothing. It should never reach here — an empty `myPub`
   * would be a bug in the codec above — but the failure mode if it did is the
   * finding all over again: an empty-for-empty match hands this device an
   * arbitrary row's id, and with it write authority over that machine's runs.
   * Cheap to refuse, silent if not.
   */
  it('never matches on an empty public key', () => {
    expect(identifyThisDevice([{ id: 'a', public_key: '' }, { id: 'b' }], '')).toBeNull()
  })
})
