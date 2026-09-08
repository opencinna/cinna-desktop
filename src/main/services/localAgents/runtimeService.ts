/**
 * What a folder agent runs on.
 *
 * A runtime is `{credential, model}` — the engine is always OpenCode, so those
 * two are the whole of it. Resolution has exactly two steps, in this order:
 *
 * 1. the manifest's own `runtime` block, and
 * 2. the **Default runtime**, derived from the user's default chat mode.
 *
 * There is deliberately no third step. A "first credential that happens to have
 * a key" fallback would make an agent run on a credential the user never chose
 * and never saw, which is a billing surprise at best.
 *
 * ## What goes in the manifest, and what does not
 *
 * The manifest gets a credential **reference** and a model id. Never a key —
 * Invariant 4, and also just: the file travels. It is committed to the user's
 * git repository, opened by their assistant and uploaded to a Cinna instance on
 * publish. The reference is the credential's **name**, because a name is the
 * one form of it that means anything in any of those places; our own row ids are
 * nanoids that mean nothing outside this machine's database.
 *
 * Reading it back tries three shapes, which is what makes a hand-written
 * manifest work: an id (what an older desktop might have written), a name (what
 * this one writes), and a provider type (`anthropic`, `openai` — what a person
 * writing the file by hand would naturally put, and what the kit's schema
 * documentation describes).
 *
 * ## Why the write goes through `update-field`
 *
 * The manifest has three concurrent writers by design (the desktop, the user's
 * assistant, cinna-core at publish time), so every desktop write to it is
 * stamped: the caller hands back the fingerprint of the bytes it read, and the
 * write is refused if the file changed since. The Runtime card is not special.
 * It reuses `localAgentService.updateField` → `manifestIo.writeIfUnchanged`
 * exactly like every other card, which is why this module only knows how to
 * *shape* the manifest and never touches the filesystem itself.
 */

import { chatModeService } from '../chatModeService'
import { providerService, type ProviderDto } from '../providerService'
import { SECRET_LOOKALIKE } from '../../kit/validator'
import { LocalAgentError } from '../../errors'
import type { AgentRuntimeRef, CinnaAgentManifest } from '../../../shared/kit/manifest'
import type { LocalAgentRuntimeInput, ResolvedRuntime } from '../../../shared/engine'
import {
  defaultRuntimeModelId,
  resolveRuntimeModel,
  type ResolvedModelChoice
} from '../../../shared/runtimeDefaults'
import { isWorkComplexity, type CatalogueModel, type WorkComplexity } from '../../../shared/modelFamilies'
import { describeRuntime, type RuntimeFacts } from '../../../shared/runtimeMessages'

/** Longest a credential reference may be. The schema's own ceiling. */
const MAX_CREDENTIAL_REF = 200

/** Longest a model id may be. Generous; provider ids are far shorter. */
const MAX_MODEL_ID = 200

const UNRESOLVED: ResolvedRuntime = {
  source: 'none',
  credentialRef: null,
  credentialId: null,
  credentialName: null,
  credentialType: null,
  modelId: null,
  modelSource: 'none',
  replacedModelId: null,
  reason: null
}

/** The catalogue of one credential, out of the aggregate registry. */
function catalogueFor(
  models: readonly CatalogueModel[] | readonly { id: string; providerId: string }[],
  providerId: string | null
): CatalogueModel[] {
  if (!providerId) return []
  return (models as readonly { id: string; providerId?: string }[])
    .filter((model) => model.providerId === providerId)
    .map((model) => ({ id: model.id }))
}

/** `runtime.complexity`, if it is one of the three the contract allows. */
function declaredComplexity(runtime: AgentRuntimeRef | null | undefined): WorkComplexity | null {
  const value = runtime?.complexity
  return isWorkComplexity(value) ? value : null
}

/** A credential that can actually drive an API call. */
function isUsable(provider: ProviderDto): boolean {
  return provider.hasApiKey && !provider.unsupported
}

/**
 * Find the credential a manifest reference names.
 *
 * Three shapes, most specific first. Name matching is case-insensitive and
 * prefers a usable credential, because two rows can share a name — a managed
 * `Anthropic` from the account config alongside the user's own — and picking the
 * one with no key would strand an agent that is in fact runnable.
 */
export function findCredential(
  providers: ProviderDto[],
  reference: string
): ProviderDto | null {
  const byId = providers.find((provider) => provider.id === reference)
  if (byId) return byId

  const needle = reference.trim().toLowerCase()
  const byName = providers.filter((provider) => provider.name.trim().toLowerCase() === needle)
  if (byName.length > 0) return byName.find(isUsable) ?? byName[0]

  const byType = providers.filter((provider) => provider.type.toLowerCase() === needle)
  if (byType.length > 0) return byType.find(isUsable) ?? byType[0]

  return null
}

export const runtimeService = {
  /**
   * The Default runtime: whatever the user's default chat mode points at.
   *
   * Reads through `chatModeService.resolveEffectiveDefault`, so it honours the
   * local/account precedence toggle and a managed mode's per-profile model
   * override — the same resolution `aiFunctions.resolveAdapterFromDefaultMode`
   * uses, so "what drafts my prompts" and "what runs my agent" cannot disagree.
   */
  resolveDefault(providers: ProviderDto[] = providerService.listMerged()): ResolvedRuntime {
    const mode = chatModeService.resolveEffectiveDefault()
    if (!mode) {
      return {
        ...UNRESOLVED,
        reason: 'Set a default chat mode in Settings to give your agents a runtime.'
      }
    }
    const provider = providers.find((candidate) => candidate.id === mode.providerId) ?? null
    if (!provider) {
      return {
        ...UNRESOLVED,
        modelId: mode.modelId,
        modelSource: mode.modelId ? 'declared' : 'none',
        reason: `Your default chat mode points at a credential this machine no longer has.`
      }
    }
    return {
      source: 'default',
      credentialRef: null,
      credentialId: provider.id,
      credentialName: provider.name,
      credentialType: provider.type,
      // Through the shared chain, not `mode.modelId` raw: a default mode left on
      // "First available" carries no model, and the credential's own default is
      // the answer — on *this* path too. The Runs with panel calls the same
      // function on the same inputs, which is what stops the label and the
      // engine's config naming different models.
      //
      // The Medium floor is deliberately *not* applied here. This method
      // describes the user's default chat mode; the floor is a property of
      // resolving one agent, and applying it twice — once to the fallback and
      // again in `resolve` — would floor against the *default* credential's
      // catalogue and then lend that model to an agent on a different key.
      modelId: defaultRuntimeModelId(provider, mode.modelId),
      modelSource: 'inherited',
      replacedModelId: null,
      reason: isUsable(provider)
        ? null
        : `Your default chat mode uses “${provider.name}”, which has no API key this app can use.`
    }
  },

  /**
   * Resolve one agent's runtime: manifest first, Default runtime second.
   *
   * A manifest block that names a credential this machine does not have falls
   * through to the default **for the credential**, but keeps its own model when
   * it declares one — an agent that asked for a particular model asked for it
   * regardless of which key pays for it. A manifest that names only a model
   * likewise borrows the default's credential.
   *
   * The default's *model*, though, is borrowed only where it can actually run:
   * `inheritedModelId` in `shared/runtimeDefaults` owns that chain, and the
   * Runs with panel calls the same function so its `Default (…)` label and this
   * resolution cannot drift apart.
   */
  resolve(
    runtime: AgentRuntimeRef | null | undefined,
    providers: ProviderDto[] = providerService.listMerged(),
    models: readonly { id: string; providerId: string }[] = []
  ): ResolvedRuntime {
    const fallback = this.resolveDefault(providers)
    const ref = typeof runtime?.credential === 'string' ? runtime.credential.trim() : ''
    const model = typeof runtime?.model === 'string' ? runtime.model.trim() : ''
    const complexity = declaredComplexity(runtime)

    const provider = ref === '' ? null : findCredential(providers, ref)
    const missingCredential = ref !== '' && !provider

    const chosen = provider ?? null
    const credentialId = chosen?.id ?? fallback.credentialId
    const effectiveType = chosen?.type ?? fallback.credentialType

    // Every model decision — a declared id, a tier, the Default runtime, the
    // Medium floor — goes through the one shared function the Runs with panel
    // also calls. That sharing is the point of the module: the bug this area was
    // rebuilt around was a panel predicting a runtime the engine did not build.
    const choice: ResolvedModelChoice = resolveRuntimeModel({
      chosen: chosen
        ? { id: chosen.id, type: chosen.type, defaultModelId: chosen.defaultModelId }
        : null,
      fallback: {
        credentialId: fallback.credentialId,
        credentialType: fallback.credentialType,
        modelId: fallback.modelId
      },
      declaredModel: model === '' ? null : model,
      declaredComplexity: complexity,
      catalogue: catalogueFor(models, credentialId)
    })

    // A manifest that declares nothing is the Default runtime — but the floor
    // may still have found it a model, so the result is `fallback` with that
    // model rather than `fallback` verbatim.
    const source = ref === '' && model === '' && complexity === null ? 'default' : 'manifest'

    /**
     * The sentence comes from `shared/runtimeMessages`, which the "Runs with"
     * panel also calls. This method used to build its own — a ladder that
     * decided the same precedence and worded it slightly differently, and that
     * **nothing read**: `collectEngineAgents` takes `credentialId` and `modelId`
     * and nothing else. Two ladders that agree are one edit away from two
     * ladders that do not, and only one of them was visible enough for anybody
     * to notice.
     */
    const facts = (over: Partial<RuntimeFacts> = {}): RuntimeFacts => ({
      credentialRef: ref === '' ? null : ref,
      credentialResolved: provider !== null,
      credentialName: chosen?.name ?? fallback.credentialName,
      credentialUsable: chosen ? isUsable(chosen) : fallback.credentialId !== null,
      complexity,
      modelId: choice.modelId,
      modelSource: choice.origin,
      replacedModelId: choice.replaced,
      catalogueKnown: catalogueFor(models, credentialId).length > 0,
      ...over
    })

    // A credential this machine does not have falls back to the default's, and
    // the tier resolves against *that* credential's catalogue — the same one
    // the panel resolves against, because the panel falls back to the same
    // credential. Handling this branch separately is what let the two disagree:
    // the panel would label the select `Simple (Claude Haiku 4.5)` while the
    // engine built the default mode's Sonnet, so a user reading the panel was
    // billed for a tier they had not chosen.
    if (missingCredential) {
      return {
        ...fallback,
        source: fallback.credentialId ? 'default' : 'none',
        credentialRef: ref,
        modelId: choice.modelId,
        modelSource: choice.origin,
        replacedModelId: choice.replaced,
        reason: describeRuntime(facts())?.text ?? null
      }
    }

    return {
      source: source === 'default' && !fallback.credentialId ? 'none' : source,
      credentialRef: ref === '' ? null : ref,
      credentialId,
      credentialName: chosen?.name ?? fallback.credentialName,
      credentialType: effectiveType,
      modelId: choice.modelId,
      modelSource: choice.origin,
      replacedModelId: choice.replaced,
      // An agent on the Default runtime inherits that runtime's own complaint;
      // otherwise the shared ladder answers from this agent's own facts.
      reason:
        source === 'default' && !chosen && fallback.reason
          ? fallback.reason
          : (describeRuntime(facts())?.text ?? null)
    }
  },

  /**
   * Check one Runtime-card choice and hand back its three normalised values.
   *
   * Shared by both writers — the manifest one below and the bare agent's, whose
   * choice lands in its desktop state instead — so a rule stated here is a rule
   * for every folder agent. Splitting it out is what stops the second writer
   * being the place the checks quietly do not apply:
   *
   * - a key-shaped `credential` is refused, using the **validator's own**
   *   pattern, so the desktop can never write a value its own validator would
   *   then flag as a leaked secret. The manifest is the file that travels, but a
   *   pasted key is a pasted key: it does not become safe by landing in
   *   `userData` instead;
   * - a model **and** a tier together are refused rather than resolved by
   *   precedence — note the asymmetry with the validator, which only *warns*
   *   about a manifest carrying both: reading is tolerant so a folder written by
   *   a newer tool still runs, while writing is strict so this desktop never
   *   authors the ambiguity it tolerates in others.
   */
  validate(input: LocalAgentRuntimeInput): {
    credential: string | null
    modelId: string | null
    complexity: WorkComplexity | null
  } {
    const credential = normaliseRef(input?.credential, 'The credential', MAX_CREDENTIAL_REF)
    const modelId = normaliseRef(input?.modelId, 'The model', MAX_MODEL_ID)
    const complexity = input?.complexity ?? null

    if (credential !== null && SECRET_LOOKALIKE.test(credential)) {
      throw new LocalAgentError(
        'invalid_input',
        'That looks like an API key. An agent stores which credential to use, never the key itself.'
      )
    }
    if (complexity !== null && !isWorkComplexity(complexity)) {
      throw new LocalAgentError(
        'invalid_input',
        'Work complexity must be simple, medium or complex.'
      )
    }
    if (complexity !== null && modelId !== null) {
      throw new LocalAgentError(
        'invalid_input',
        'A runtime names a model or a work complexity, not both.'
      )
    }
    return { credential, modelId, complexity }
  },

  /**
   * The same choice as a standalone `AgentRuntimeRef`, for a **bare** agent.
   *
   * A bare folder has no manifest to merge into, so there is nothing to preserve
   * and no unknown keys to round-trip: the value is built from the three fields
   * and nothing else. Declaring none of them is `null` rather than `{}`, so
   * "no choice made" reads the same in the state file as it does in the UI —
   * and `resolve` takes the Default runtime branch for it without a special
   * case of its own.
   */
  toRuntimeRef(input: LocalAgentRuntimeInput): AgentRuntimeRef | null {
    const { credential, modelId, complexity } = this.validate(input)
    if (credential === null && modelId === null && complexity === null) return null
    const runtime: AgentRuntimeRef = {}
    if (credential !== null) runtime.credential = credential
    if (modelId !== null) runtime.model = modelId
    if (complexity !== null) runtime.complexity = complexity
    return runtime
  },

  /**
   * Apply a Runtime-card choice to a manifest object, in place.
   *
   * The checks are {@link validate}'s, shared with the bare agent's writer.
   * What is specific to a manifest is what happens either side of them:
   * clearing every field removes the `runtime` key entirely rather than leaving
   * `{}` behind, so "no choice made" reads the same in the file as it does in
   * the UI and a diff of the manifest shows the choice going away.
   *
   * Unknown keys inside an existing `runtime` block — `permissions`, or
   * something a newer contract adds — are preserved, per the manifest's
   * round-trip rule.
   */
  applyToManifest(manifest: CinnaAgentManifest, input: LocalAgentRuntimeInput): void {
    const { credential, modelId, complexity } = this.validate(input)

    const existing =
      manifest.runtime && typeof manifest.runtime === 'object' ? { ...manifest.runtime } : {}
    delete existing.credential
    delete existing.model
    delete existing.complexity

    if (
      credential === null &&
      modelId === null &&
      complexity === null &&
      Object.keys(existing).length === 0
    ) {
      delete manifest.runtime
      return
    }

    const next: AgentRuntimeRef = { ...existing }
    if (credential !== null) next.credential = credential
    if (modelId !== null) next.model = modelId
    if (complexity !== null) next.complexity = complexity
    manifest.runtime = next
  }
}

function normaliseRef(value: unknown, label: string, max: number): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    throw new LocalAgentError('invalid_input', `${label} must be text.`)
  }
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (trimmed.length > max) {
    throw new LocalAgentError('invalid_input', `${label} is too long (max ${max} characters).`)
  }
  return trimmed
}
