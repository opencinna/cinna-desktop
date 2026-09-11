import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * One invariant, asserted against the source of `syncService.ts`: **the only
 * way this profile acquires a sync device id is `adoptDeviceId`, and that
 * function adopts the tasks nobody had claimed.**
 *
 * ## Why a source-level test rather than a behavioural one
 *
 * The hazard is the one the step-9a review named and which this file exists to
 * answer: `adoptUnclaimed` is exercised directly by
 * `sync/taskCollection.test.ts`, so deleting its *call site* — a single line
 * inside a private function — would leave the whole suite green, and the
 * failure it guards is silent (two devices each believing they own the same
 * run, until both start it).
 *
 * Reaching the call behaviourally means driving `init` or
 * `registerDeviceEnvelope` through `syncApi.registerDevice`, the device
 * keypair codec, the envelope crypto and QR generation — a mock surface large
 * enough to flatter the code it is checking, which is the other lesson this
 * phase keeps re-learning. What actually has to stay true is structural, and
 * this states it structurally. The ratchet in `agents/kindBranches.test.ts`
 * reads the tree the same way and for the same kind of reason.
 *
 * **What it does not prove**: that `adoptDeviceId` is reached at run time on
 * any particular path. It proves there is nowhere else a device id can come
 * from, and that the one place it can adopts. `taskService.adoptUnclaimed`'s
 * own behaviour is pinned in `sync/taskCollection.test.ts`.
 */

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'syncService.ts'),
  'utf8'
)

/** The body of a top-level `function name(...) { ... }`, by brace matching. */
function functionBody(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start, `${name} is not a top-level function in syncService.ts`).toBeGreaterThan(-1)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1)
  }
  throw new Error(`unbalanced braces reading ${name}`)
}

describe('acquiring a sync device id adopts the tasks that had no claim', () => {
  it('has exactly one place that gives sync_state.device_id a value', () => {
    // `deviceId: null` is excluded: `disconnect` clears the id and keeps the
    // row, which is a release rather than an acquisition and has nothing to
    // adopt. What must stay singular is the *setting* of one.
    const writes = (source.match(/patchState\([^)]*\{[^}]*\bdeviceId\b[^}]*\}/g) ?? []).filter(
      (call) => !/deviceId:\s*null/.test(call)
    )
    // Two call sites acquire an id — registering with the server, and reading
    // it back out of the first-device init response — and both go through
    // `adoptDeviceId`, which is the only thing that writes it. A third writer
    // added without the adoption is the regression this catches.
    expect(writes).toHaveLength(1)
  })

  it('that writer is `adoptDeviceId`, and it adopts', () => {
    const body = functionBody('adoptDeviceId')
    expect(body).toContain('patchState')
    expect(body).toContain('taskService.adoptUnclaimed')
  })

  it('is called from both paths a device id can arrive on', () => {
    const uses = (source.match(/\badoptDeviceId\(/g) ?? []).length
    const definition = (source.match(/function adoptDeviceId\(/g) ?? []).length
    expect(definition).toBe(1)
    // Registering with the server, and reading the id back out of the
    // first-device init response. Deleting either is the silent regression.
    expect(uses - definition).toBe(2)
  })
})
