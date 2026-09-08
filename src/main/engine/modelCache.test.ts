import { describe, it, expect } from 'vitest'


const { mergeModelCache } = await import('./modelCache')

const m = (providerId: string, id: string) => ({ id, name: id, providerId })

/**
 * The rule that stands between a briefly-absent local server and a twenty-minute
 * hang.
 *
 * A custom provider entry must declare every model it can address. `getAllModels`
 * swallows a per-adapter failure and simply omits that provider, so "Ollama was
 * not running for this one call" and "this credential has no models" arrive
 * identically — and an entry with an empty `models` map yields
 * `ModelUnavailableError`, which reaches no engine event at all.
 */
describe('mergeModelCache', () => {
  it('replaces a provider that answered', () => {
    const merged = mergeModelCache(
      [m('ollama', 'gemma4:latest')],
      [m('ollama', 'gemma4:latest'), m('ollama', 'qwen3:8b')],
      ['ollama']
    )
    expect(merged.filter((x) => x.providerId === 'ollama').map((x) => x.id)).toEqual([
      'gemma4:latest',
      'qwen3:8b'
    ])
  })

  /** `ollama rm` must actually take effect — the keep rule is not a union. */
  it('shrinks a provider that answered with fewer models', () => {
    const merged = mergeModelCache(
      [m('ollama', 'gemma4:latest'), m('ollama', 'qwen3:8b')],
      [m('ollama', 'gemma4:latest')],
      ['ollama']
    )
    expect(merged.map((x) => x.id)).toEqual(['gemma4:latest'])
  })

  /** The hang guard: silence is not an empty catalogue. */
  it('keeps what a silent provider last reported', () => {
    const merged = mergeModelCache([m('ollama', 'gemma4:latest')], [], ['ollama'])
    expect(merged).toEqual([m('ollama', 'gemma4:latest')])
  })

  /** A local-only refresh never asked the cloud providers, so it cannot drop them. */
  it('leaves providers a partial refresh did not ask about', () => {
    const merged = mergeModelCache(
      [m('anthropic-row', 'claude-sonnet-4-5'), m('ollama', 'stale:7b')],
      [m('ollama', 'gemma4:latest')],
      ['anthropic-row', 'ollama']
    )
    expect(merged.map((x) => `${x.providerId}/${x.id}`).sort()).toEqual([
      'anthropic-row/claude-sonnet-4-5',
      'ollama/gemma4:latest'
    ])
  })

  it('is a no-op on an empty cache with nothing to add', () => {
    expect(mergeModelCache([], [], [])).toEqual([])
  })

  /**
   * Silence and deletion are both "absent from `fresh`", and only one of them
   * means "keep what it said". The cache is handed to `runtimeService.resolve`,
   * where `modelBelongsElsewhere` treats any listed owner as disqualifying for a
   * per-row catalogue like Ollama's — so a ghost row makes a live agent's model
   * look like it belongs to someone else.
   */
  it('evicts a credential that no longer exists, rather than keeping its models', () => {
    const merged = mergeModelCache(
      [m('deleted-row', 'llama3:70b'), m('ollama', 'gemma4:latest')],
      [],
      ['ollama']
    )
    expect(merged).toEqual([m('ollama', 'gemma4:latest')])
  })

  it('drops a fresh entry for a provider that is not live either', () => {
    expect(mergeModelCache([], [m('ghost', 'x')], ['ollama'])).toEqual([])
  })

  /**
   * The live set comes from the credential database; the models come from the
   * adapter registry. They disagree for a moment before a profile's scopes
   * resolve, when the database answers with nothing — and reading that as
   * "everything was deleted" would empty every custom provider entry at once,
   * which is the hang this module exists to prevent.
   */
  it('evicts nothing when the live set is unknown', () => {
    const cache = [m('ollama', 'gemma4:latest'), m('anthropic-row', 'claude-sonnet-4-5')]
    expect(mergeModelCache(cache, [], [])).toEqual(cache)
  })
})
