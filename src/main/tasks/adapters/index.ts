/**
 * The adapter registry — the one place an implementation is named.
 *
 * `adapterFor(id)` is total: every id resolves to something adapter-shaped, so
 * no caller has a branch for "this build has no adapter for that". An id this
 * build does not implement gets a {@link createNullAdapter null adapter} that
 * reports `ready: false` with a sentence naming the service, and refuses every
 * operation.
 *
 * Adding a service is a file in this folder and an **import at the bottom of
 * this one**. Nothing else in `src/` learns its name — that is what the
 * kind-branch ratchet's `remoteAdapter` category counts, and it is the whole
 * point of the seam.
 *
 * **Register from here, not from app boot**, and the reason is that the failure
 * mode is invisible. If a build ships `cinnaTaskAdapter` but the wiring line is
 * missed — or a tree-shake drops a side-effect-only import — then every
 * cinna-bound task opens perfectly, shows the null adapter's "a service this
 * version of Cinna does not know about", and syncs nothing; `allAdapters()` is
 * empty so the pull loop iterates nothing and never errors; and nothing is
 * logged, because nothing failed. It is indistinguishable from a build that
 * genuinely lacks the adapter, which is exactly what the null adapter exists to
 * make comfortable. Importing here means the registry file is the one place a
 * reader has to look, and the one place that can go wrong.
 *
 * The seam and its contract suite landed a step before the first
 * implementation, deliberately, so the interface was not shaped by one remote's
 * field names. `cinna` joined in step 9 as one import and one line.
 */

import { createNullAdapter } from './nullAdapter'
import { cinnaTaskAdapter } from './cinnaTaskAdapter.wiring'
import type { RemoteTaskAdapter } from './adapter'

/** Every adapter this build has, by id. */
const ADAPTERS = new Map<string, RemoteTaskAdapter>()

/**
 * Registered at module load, from the imports at the foot of this file.
 *
 * A duplicate id **throws**. Two adapters answering to one name is a collision
 * with no symptom — whichever registered last wins, silently, and the tasks
 * bound to the other one quietly start talking to it.
 */
export function registerAdapter(adapter: RemoteTaskAdapter): void {
  const existing = ADAPTERS.get(adapter.id)
  if (existing && existing !== adapter) {
    throw new Error(`Two remote task adapters both claim the id \`${adapter.id}\``)
  }
  ADAPTERS.set(adapter.id, adapter)
}

/**
 * One null adapter per unknown id, so `adapterFor(x) === adapterFor(x)` holds
 * the way it does for a real adapter. Nothing keys on adapter identity today;
 * something will, and a factory that mints a fresh object per call is the kind
 * of trap that only shows up in a `useMemo` dependency or a `Map`.
 */
const nullAdapters = new Map<string, RemoteTaskAdapter>()

/**
 * The adapter for an id. Never null, never throws.
 *
 * A null adapter is built per id rather than shared, so its reason can name the
 * service the task claims to be on and `binding.adapter === adapter.id` holds
 * the same way it does for a real one.
 */
export function adapterFor(id: string): RemoteTaskAdapter {
  const registered = ADAPTERS.get(id)
  if (registered) return registered
  const existing = nullAdapters.get(id)
  if (existing) return existing
  const created = createNullAdapter(id)
  nullAdapters.set(id, created)
  return created
}

/** Whether this build actually implements an id — for diagnostics, not dispatch. */
export function hasAdapter(id: string): boolean {
  return ADAPTERS.has(id)
}

/** Every implemented adapter. The contract suite runs over this plus its fakes. */
export function allAdapters(): RemoteTaskAdapter[] {
  return [...ADAPTERS.values()]
}

export * from './adapter'

// Implementations register themselves by being imported here, and nowhere else.
registerAdapter(cinnaTaskAdapter)
