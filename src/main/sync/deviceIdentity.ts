/**
 * Which of the account's registered devices is **this** one.
 *
 * A pure module with no runtime imports, like `identity.ts` beside it, because
 * the answer decides something the rest of the sync code trusts completely and
 * it needs to be testable without an account, a keypair or a server.
 *
 * ## Why this is not a one-liner in `syncService`
 *
 * It used to be: `devices.find(matchesMyKey) ?? devices[0]`. That positional
 * fallback was harmless for as long as `sync_state.device_id` only selected a
 * key envelope — pick the wrong one and auto-unlock falls back to matching on
 * the public key instead.
 *
 * It stopped being harmless when tasks began to sync. `sync_state.device_id` is
 * what `taskService`'s `thisDeviceId` feeds to `taskRunsHere`, so it is now the
 * input to **write authority over a run**: a device that adopted another
 * device's id would see every task that device holds as its own, pass
 * `requireRunsHere`, and run work the other machine is already streaming — with
 * no take-over write anywhere, which is the one thing §5.4 of the agent-runtime
 * plan says cannot happen.
 */

/** The slice of the server's device record this decision needs. */
export interface RegisteredDevice {
  id: string
  public_key?: string | null
}

/**
 * The account's device that is this one, or **null** when that cannot be
 * established.
 *
 * Two ways to be sure, and they are not the same kind of sure:
 *
 *  - **The public key matches.** Proof. Always preferred.
 *  - **There is exactly one device on the account.** Not proof, but it is the
 *    shape `init` produces — it registers this device in the same request that
 *    creates the account — and the only candidate is necessarily this one.
 *
 * Anything else is a guess between several real devices, and `null` is the
 * right answer to that: `taskRunsHere` reads a null device id as "this device
 * has authority over what it can see", which is correct for a machine that has
 * not yet been identified and cannot be holding a claim against anyone.
 */
export function identifyThisDevice(
  devices: readonly RegisteredDevice[] | null | undefined,
  myPublicKey: string
): RegisteredDevice | null {
  const list = devices ?? []
  const byKey = list.find((d) => !!d.public_key && d.public_key === myPublicKey)
  if (byKey) return byKey
  return list.length === 1 ? list[0] : null
}
