/**
 * Where AI Functions (chat titles, drafted prompts) will actually run, as main
 * decides it. Settings → Features renders this and nothing else: the screen used
 * to judge the binding with its own renderer-side rule, and said "Sonnet ·
 * default model" while main was falling back to the Default runtime.
 *
 * Why the fallback happened, when it did:
 *   - `unset` — no AI Functions credential chosen.
 *   - `missing` — the chosen credential no longer exists in either scope.
 *   - `inactive` — it exists but cannot run: disabled, no API key, an
 *     unsupported managed token, or a provider type this build cannot drive.
 *   - `no_model` — it can run, but neither the chosen model, its default model
 *     nor its model list names one.
 */
export type AiFunctionsFallbackReason = 'unset' | 'missing' | 'inactive' | 'no_model'

export type AiFunctionsBackendStatus =
  | {
      runsOn: 'credential'
      credentialId: string
      credentialName: string
      /** An id; the renderer names it from its model list, else shows the id. */
      modelId: string
    }
  | { runsOn: 'runtime'; reason: AiFunctionsFallbackReason }
