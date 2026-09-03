import { describe, it, expect } from 'vitest'
import { CUSTOM_MODEL_LIMITS, isEngineProviderType } from './modelLimits'

/**
 * The table itself. What it *does* — reaching the config as a per-model
 * `limit` — is pinned in `configGenerator.test.ts`, where the emitted bytes
 * are; this file pins the two properties that make it safe to depend on.
 *
 * The exhaustiveness guarantee is deliberately **not** tested here, because it
 * is not a runtime property and a test could only re-state it. It is a compile
 * error, verified by adding a member to `EngineProviderType` and watching
 * `tsc` fail in both this table and `configGenerator`'s `PROVIDER_NPM`.
 */
describe('CUSTOM_MODEL_LIMITS', () => {
  it('is frozen all the way down', () => {
    // Not ceremony: this is a fact about the pinned engine and the providers,
    // and a table something can write to is a table that will be written to
    // from a code path nobody remembers. `Object.freeze` is shallow, so the
    // entries are frozen too — mutation: drop the inner `Object.freeze` and
    // the second expectation fails.
    expect(Object.isFrozen(CUSTOM_MODEL_LIMITS)).toBe(true)
    expect(Object.isFrozen(CUSTOM_MODEL_LIMITS.anthropic)).toBe(true)
  })

  it('gives every type a non-zero output ceiling', () => {
    // **Zero is the whole reason this exists.** The engine defaults a custom
    // entry's model to `{context: 0, output: 0}` and the Anthropic transport
    // sends that as `max_tokens`, which the provider rejects outright. A row
    // added with a placeholder zero would reintroduce exactly that.
    for (const [type, limit] of Object.entries(CUSTOM_MODEL_LIMITS)) {
      expect(limit.output, type).toBeGreaterThan(0)
      expect(limit.context, type).toBeGreaterThan(limit.output)
    }
  })

  it('recognises exactly the types it has limits for', () => {
    // The guard is derived from the table's own keys, so the two cannot drift.
    expect(isEngineProviderType('anthropic')).toBe(true)
    expect(isEngineProviderType('openai_compatible')).toBe(true)
    expect(isEngineProviderType('mistral')).toBe(false)
    // Not fussiness: `hasOwnProperty` on a plain object would answer `true` for
    // every one of these if the table were built with `{}` and a loose lookup.
    expect(isEngineProviderType('toString')).toBe(false)
    expect(isEngineProviderType('__proto__')).toBe(false)
  })
})
