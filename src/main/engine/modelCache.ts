/**
 * The engine's snapshot of what each credential can address, and the one rule
 * that governs folding a refresh into it.
 *
 * Pure — no registry, no database, no clock — so the rule can be tested without
 * standing up the main process, which is the same reason `modelLimits` and
 * `modelTransports` are their own modules.
 */

/** One catalogue entry, as the engine config needs it. */
export interface CachedModel {
  id: string
  name: string
  providerId: string
}

/** Which credentials a refresh re-asks. See `engineConfigSource`. */
export type ModelRefreshScope =
  /** Every registered adapter. A start, where the cost is already being paid. */
  | 'all'
  /**
   * Only the **local** (keyless) credentials. A reconcile, where re-asking every
   * cloud provider would put a network call on the path of every manifest field
   * edit — the thing `refreshModels: false` exists to avoid — but where a
   * loopback call costs about a millisecond and is the only way a
   * locally-pulled model ever reaches a running engine.
   */
  | 'local'

/**
 * Fold a refresh into the cache **without ever shrinking a provider to nothing**.
 *
 * `getAllModels` swallows a per-adapter failure and simply omits that provider's
 * models, so "the server was down for this one call" and "this credential has no
 * models" arrive identically. For a cloud provider that distinction rarely
 * mattered — the catalogue is a vendor's stable line-up and the call rarely
 * fails. For Ollama it is the difference between a working agent and a hang: a
 * custom provider entry must declare every model it can address, an entry whose
 * `models` map is empty can address none, and the resulting
 * `ModelUnavailableError` reaches **no engine event at all** — so the turn waits
 * out the desktop's own twenty-minute ceiling with nothing on screen.
 *
 * So a provider that reported nothing keeps what it last reported. The cost of
 * being wrong that way is a declared model that has since been `ollama rm`-ed,
 * which fails loudly the moment it is used; the cost of the other way is the
 * silent hang.
 *
 * It takes no scope argument because one rule covers both: a provider absent
 * from `fresh` was either not asked (a `local` refresh skipped it) or asked and
 * silent, and the right answer is the same either way. A provider that *did*
 * answer is replaced outright, so a removed model still disappears.
 *
 * `known` is the second half of the rule, and it exists because "keep what a
 * silent provider last said" cannot tell silence from **deletion**. A deleted
 * credential's models would otherwise sit in the cache for the life of the
 * process, and the cache is not only a lookup table: `collectEngineAgents` hands
 * it to `runtimeService.resolve`, where `modelBelongsElsewhere` reads it as a
 * *global* ownership index. A ghost row is an owner. So an agent on Ollama
 * credential A naming a model that deleted credential B once listed would be
 * told the model belongs elsewhere — `ollama` being in `PER_ROW_CATALOGUE`,
 * where any other owner is disqualifying — and have it substituted or dropped.
 * Passing the live ids in keeps that rule here rather than in the caller.
 *
 * **An empty `known` evicts nothing**, and that asymmetry is the same one the
 * keep-rule encodes. The live set comes from the credential *database* while
 * the models come from the adapter *registry*, and those two can legitimately
 * disagree for a moment — most obviously before a profile's scopes resolve,
 * when `listMerged()` answers with nothing at all. Treating that as "every
 * credential was deleted" would empty every custom provider entry at once,
 * which is the twenty-minute hang this module exists to prevent. A stale ghost
 * is a narrow, bounded wrong answer; mass eviction is the catastrophic one, so
 * eviction requires positive knowledge and an empty list is not knowledge.
 */
export function mergeModelCache(
  previous: readonly CachedModel[],
  fresh: readonly CachedModel[],
  known: Iterable<string>
): CachedModel[] {
  const live = new Set(known)
  const answered = new Set(fresh.map((model) => model.providerId))
  const merged = [...fresh, ...previous.filter((model) => !answered.has(model.providerId))]
  if (live.size === 0) return merged
  return merged.filter((model) => live.has(model.providerId))
}
