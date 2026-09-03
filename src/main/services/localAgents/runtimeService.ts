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
  reason: null
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
        reason: `Your default chat mode points at a credential this machine no longer has.`
      }
    }
    return {
      source: 'default',
      credentialRef: null,
      credentialId: provider.id,
      credentialName: provider.name,
      credentialType: provider.type,
      modelId: mode.modelId,
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
   */
  resolve(
    runtime: AgentRuntimeRef | null | undefined,
    providers: ProviderDto[] = providerService.listMerged()
  ): ResolvedRuntime {
    const fallback = this.resolveDefault(providers)
    const ref = typeof runtime?.credential === 'string' ? runtime.credential.trim() : ''
    const model = typeof runtime?.model === 'string' ? runtime.model.trim() : ''
    if (ref === '' && model === '') return fallback

    const provider = ref === '' ? null : findCredential(providers, ref)
    if (ref !== '' && !provider) {
      return {
        ...fallback,
        source: fallback.credentialId ? 'default' : 'none',
        credentialRef: ref,
        modelId: model || fallback.modelId,
        reason: `This agent asks for the credential “${ref}”, which is not configured here${
          fallback.credentialName ? `; using ${fallback.credentialName} instead` : ''
        }.`
      }
    }

    const chosen = provider ?? null
    const credentialId = chosen?.id ?? fallback.credentialId
    const modelId = model || fallback.modelId
    return {
      source: 'manifest',
      credentialRef: ref === '' ? null : ref,
      credentialId,
      credentialName: chosen?.name ?? fallback.credentialName,
      credentialType: chosen?.type ?? fallback.credentialType,
      modelId,
      reason:
        credentialId === null
          ? 'This agent has no credential to run on. Choose one in the Runtime card.'
          : modelId === null
            ? 'This agent has no model to run on. Choose one in the Runtime card.'
            : chosen && !isUsable(chosen)
              ? `“${chosen.name}” has no API key this app can use.`
              : null
    }
  },

  /**
   * Apply a Runtime-card choice to a manifest object, in place.
   *
   * Validation lives here rather than at the IPC boundary because this is the
   * last point before the value is serialised into a file the user commits.
   * Two of the checks are not about type safety:
   *
   * - a key-shaped `credential` is refused, using the **validator's own**
   *   pattern, so the desktop can never write a manifest its own validator then
   *   flags as a leaked secret;
   * - clearing both fields removes the `runtime` key entirely rather than
   *   leaving `{}` behind, so "no choice made" reads the same in the file as it
   *   does in the UI, and a diff of the manifest shows the choice going away.
   *
   * Unknown keys inside an existing `runtime` block — `permissions`, or
   * something a newer contract adds — are preserved, per the manifest's
   * round-trip rule.
   */
  applyToManifest(manifest: CinnaAgentManifest, input: LocalAgentRuntimeInput): void {
    const credential = normaliseRef(input?.credential, 'The credential', MAX_CREDENTIAL_REF)
    const modelId = normaliseRef(input?.modelId, 'The model', MAX_MODEL_ID)

    if (credential !== null && SECRET_LOOKALIKE.test(credential)) {
      throw new LocalAgentError(
        'invalid_input',
        'That looks like an API key. The manifest stores which credential to use, never the key itself.'
      )
    }

    const existing =
      manifest.runtime && typeof manifest.runtime === 'object' ? { ...manifest.runtime } : {}
    delete existing.credential
    delete existing.model

    if (credential === null && modelId === null && Object.keys(existing).length === 0) {
      delete manifest.runtime
      return
    }

    const next: AgentRuntimeRef = { ...existing }
    if (credential !== null) next.credential = credential
    if (modelId !== null) next.model = modelId
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
