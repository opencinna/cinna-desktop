/**
 * Turning this desktop's state — credentials, folder agents, runtimes — into
 * the pure input `configGenerator` wants.
 *
 * It sits between the ACP launcher (which knows about a process) and
 * `configGenerator` (which knows about OpenCode's config shape) so that neither
 * has to know about `providerService`, `localAgentService` or the manifest. The
 * practical payoff is that the launcher can be driven in a test with a
 * three-line fake supplier instead of a database.
 *
 * **This is the one place a decrypted API key is read**, and it hands the key
 * straight to `buildEngineConfig`, which puts it in the environment map and an
 * `{env:…}` reference in the config. Nothing here returns a key to a caller
 * that could log it.
 */

import { decryptApiKey } from '../security/keystore'
import { isCredentialUsable, requiresApiKey } from '../../shared/credentials'
import { llmProviderRepo } from '../db/llmProviders'
import { getManagedResourceScopes } from '../auth/scope'
import { getAdapter, getAllModels } from '../llm/registry'
import { mergeModelCache, type CachedModel, type ModelRefreshScope } from './modelCache'
import { localAgentService } from '../services/localAgents/localAgentService'
import { runtimeService } from '../services/localAgents/runtimeService'
import { providerService } from '../services/providerService'
import {
  assembleAgentPrompt,
  assembleBareAgentPrompt,
  resolveDesktopPromptContext
} from '../services/localAgents/promptAssembly'
import { createLogger } from '../logger/logger'
import type { EngineAgentInput, EngineConfigInput, EngineProviderInput } from './configGenerator'

const logger = createLogger('engine-config-source')

/**
 * Every credential the engine may use, with its key decrypted.
 *
 * Own **and** server-managed credentials, per the design: a managed credential
 * is a real key the user is entitled to use, and excluding it would make an
 * account-provisioned machine unable to run a local agent at all. What is left
 * out is a credential the user has switched **off**, and one that cannot make an
 * API call in the first place — no stored key, or a managed row this app already
 * marks `unsupported` (an Anthropic OAuth token, which is not an API key).
 *
 * "No stored key" is a disqualification only for the types that *have* keys.
 * A keyless credential (Ollama) is collected with an empty `apiKey`, and
 * `buildEngineConfig` puts the placeholder in the env map — which is why the
 * decryption below is conditional rather than a precondition.
 */
export function collectEngineProviders(): EngineProviderInput[] {
  const dtos = providerService.listMerged()
  const rows = new Map(
    llmProviderRepo.listByUserIds(getManagedResourceScopes()).map((row) => [row.id, row])
  )
  const models = modelsByProvider()
  const out: EngineProviderInput[] = []

  for (const dto of dtos) {
    /**
     * The off switch means off, here too.
     *
     * This check was missing for as long as the collector existed, and the
     * effect was worst for the credentials it mattered most for: a *canonical*
     * type (`anthropic`, `openai`) carries a working key into the config, so a
     * folder agent pinned to a credential the user had switched off in Settings
     * kept running — and kept billing — after they turned it off. A custom entry
     * (a gateway, gemini, ollama) was already inert by accident, because
     * `providerService.upsert` unregisters the adapter on disable and the models
     * map is built from the registry, so the entry existed and could address
     * nothing.
     *
     * The alternative position — that the config is a catalogue of what *can* be
     * addressed and the runner owns the gate — is coherent, and is what
     * `docs/agents/local_agents/engine.md` records for an agent's own `enabled`.
     * It is rejected for credentials: a user who turns a credential off has said
     * something about spending, not about cataloguing, and there is no runner
     * gate that would honour it. An agent left without a credential is reported
     * as skipped by `configGenerator`, which is how the Runtime card gets to say
     * *why* rather than the agent silently disappearing.
     */
    if (!dto.enabled) continue
    if (!isCredentialUsable(dto)) continue
    const row = rows.get(dto.id)
    if (!row) continue
    const needsKey = requiresApiKey(dto.type)
    if (needsKey && !row.apiKeyEncrypted) continue
    let apiKey = ''
    if (row.apiKeyEncrypted) {
      try {
        apiKey = decryptApiKey(row.apiKeyEncrypted)
      } catch (err) {
        // A key that will not decrypt is a keychain problem, not a reason to fail
        // the whole engine start — the other credentials still work.
        logger.warn('skipping a credential the keystore would not decrypt', {
          providerId: dto.id,
          error: err instanceof Error ? err.message : String(err)
        })
        continue
      }
    }
    if (apiKey === '' && needsKey) continue
    out.push({
      id: dto.id,
      type: dto.type,
      name: dto.name,
      apiKey,
      baseUrl: row.baseUrl ?? null,
      models: models.get(dto.id) ?? []
    })
  }
  return out
}

/**
 * Models per credential, from the adapter registry.
 *
 * Only the **custom** provider entries need these — a canonical `anthropic` key
 * gets its catalog from models.dev. The registry is already populated for every
 * enabled credential with a key, so this costs nothing at start time; a
 * credential the registry has nothing for still works on a canonical key, and
 * on a custom key simply offers no models, which is visible rather than silent.
 */
function modelsByProvider(): Map<string, { id: string; name: string }[]> {
  const out = new Map<string, { id: string; name: string }[]>()
  for (const model of cachedModels) {
    const list = out.get(model.providerId) ?? []
    list.push({ id: model.id, name: model.name })
    out.set(model.providerId, list)
  }
  return out
}

/**
 * The last model snapshot, refreshed by {@link refreshModelCache}.
 *
 * `getAllModels()` is async and can reach the network for a gateway that
 * implements `/models`, so it is refreshed explicitly before a config build
 * rather than awaited from inside the synchronous collector — a start that
 * blocks on an unreachable gateway would be a start that never happens.
 */
let cachedModels: CachedModel[] = []

/** Adapters belonging to a keyless credential, which is to say a local server. */
function localProviderIds(): string[] {
  return providerService
    .listMerged()
    .filter((provider) => !requiresApiKey(provider.type))
    .map((provider) => provider.id)
}

/** Whether a full refresh has ever completed. See {@link collectEngineConfigInput}. */
let cloudCatalogueLoaded = false

/** True when the refresh completed; false when it was swallowed. */
export async function refreshModelCache(scope: ModelRefreshScope = 'all'): Promise<boolean> {
  try {
    const fresh =
      scope === 'all'
        ? (await getAllModels()).map((model) => ({
            id: model.id,
            name: model.name,
            providerId: model.providerId
          }))
        : await listLocalModels()
    cachedModels = mergeModelCache(
      cachedModels,
      fresh,
      providerService.listMerged().map((provider) => provider.id)
    )
    if (scope === 'all') cloudCatalogueLoaded = true
    return true
  } catch (err) {
    logger.warn('could not refresh the model list for the engine config', {
      error: err instanceof Error ? err.message : String(err)
    })
    return false
  }
}

/** Forget that a full refresh happened. **Tests only.** */
export function resetModelCacheForTests(): void {
  cloudCatalogueLoaded = false
  cachedModels = []
}

/** Ask each local credential's adapter directly, so no cloud call is made. */
async function listLocalModels(): Promise<CachedModel[]> {
  const out: CachedModel[] = []
  for (const providerId of localProviderIds()) {
    const adapter = getAdapter(providerId)
    if (!adapter) continue
    try {
      for (const model of await adapter.listModels()) {
        out.push({ id: model.id, name: model.name, providerId })
      }
    } catch (err) {
      // A local server that is not running right now. Deliberately not an
      // error: the merge below keeps whatever it last reported.
      logger.debug('a local credential listed no models', {
        providerId,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
  return out
}

/**
 * Every folder agent, with its resolved runtime and its assembled prompt.
 *
 * An agent whose runtime resolves to nothing is still included: `configGenerator`
 * reports it as skipped, which is what lets the Runtime card say *why* an agent
 * cannot run instead of the agent merely being absent from the engine.
 */
export function collectEngineAgents(userId: string): EngineAgentInput[] {
  const context = resolveDesktopPromptContext()
  const providers = providerService.listMerged()
  const out: EngineAgentInput[] = []

  for (const agent of localAgentService.list(userId).agents) {
    // A folder that does not validate has no business being handed to a model:
    // its prompt files may be half-written and its manifest may say anything.
    if (agent.readiness === 'invalid' || agent.readiness === 'contract_too_new') continue
    // The cached catalogue, not a fresh fetch: a Work Complexity tier is
    // resolved against what the credential actually lists, and `refreshModelCache`
    // has already run for this build (or deliberately not, on a reconcile —
    // see `collectEngineConfigInput`). Handing `resolve` the same snapshot the
    // rest of the config is built from is what keeps a reconcile from deciding
    // the config changed because a gateway was briefly unreachable.
    const runtime = runtimeService.resolve(agent.runtime, providers, cachedModels)
    // **Every folder agent is collected, whichever engine it names.** This
    // used to skip anything but OpenCode, because one shared config served
    // every agent at once and a Claude runtime resolves to no credential — so
    // the generator would have reported a perfectly healthy agent as
    // "its credential is not available to it", a sentence about a key it does
    // not spend.
    //
    // Since phase 3 the caller is the OpenCode *launcher*, planning one turn
    // for one agent it was chosen for — and it is chosen by reading the folder,
    // so it is never asked about an agent on another engine. Filtering here
    // would only decide what a question nobody asks gets answered with.
    out.push({
      agentId: agent.id,
      slug: agent.slug,
      description: agent.description,
      // A bare folder has no manifest, so nothing in the kit assembler applies
      // to it — see `assembleBareAgentPrompt` for why its `README.md` is
      // deliberately left out of what the model is told.
      prompt:
        agent.kind === 'bare'
          ? assembleBareAgentPrompt(agent.path, agent.name, context)
          : assembleAgentPrompt(agent.path, agent.manifest, context),
      providerId: runtime.credentialId ?? '',
      modelId: runtime.modelId ?? '',
      permissions:
        agent.runtime?.permissions && typeof agent.runtime.permissions === 'object'
          ? (agent.runtime.permissions as Record<string, unknown>)
          : null
    })
  }
  return out
}

/**
 * Everything `configGenerator` needs, gathered from this desktop.
 *
 * `refreshModels` exists because the model list is the one input here that is
 * **not local**: every adapter's `listModels()` is a real network round trip —
 * Anthropic's SDK, OpenAI's SDK, a `fetch` for Gemini — so refreshing costs one
 * request per configured credential.
 *
 * That is right at engine start and wrong on a reconcile. The engine is
 * reconciled at the point of use, which is once per turn, and a per-turn fan-out
 * of provider API calls would put network latency in front of every message the
 * user sends. Skipping it there is safe rather than merely cheap: a running
 * engine's cache was populated by the start that launched it, and
 * {@link refreshModelCache} keeps the last good list when a refresh fails — so
 * the reconcile compares against the same model list the running config was
 * built from, instead of one that drops out whenever a gateway is briefly
 * unreachable and takes the engine down for a restart it did not need.
 */
export async function collectEngineConfigInput(
  userId: string,
  options: { refreshModels?: boolean } = {}
): Promise<EngineConfigInput> {
  /**
   * **The cloud catalogue is asked for once, and then never again in this
   * session; the local one is asked for every time.**
   *
   * The two halves have different reasons. A vendor's line-up is stable and
   * costs a real network round trip per configured credential, so asking on
   * every turn would put that latency in front of every message the user sends
   * — which is what `refreshModels: false` has always meant. A *local*
   * catalogue is not a line-up at all but the set of models on this machine,
   * which the user changes with `ollama pull` between one turn and the next, and
   * which is empty whenever the local server happened not to be running a moment
   * ago. Without re-asking, starting Cinna before Ollama meant every folder
   * agent on it hung on its first turn until the desktop's own ceiling expired.
   *
   * **The once is load-bearing, and it was briefly lost.** Under the shared
   * server the full refresh happened at engine start (`refreshModels: true`)
   * and the reconcile asked only for local models. When the server went, so did
   * the only caller that ever passed `true` — leaving a cache with no cloud
   * models in it at all, so an agent whose manifest names a Work Complexity
   * tier on a cloud credential resolved against an empty catalogue, took the
   * `no_model` skip, and was refused every turn with "its runtime names no
   * model". Hence the flag rather than a literal: the first collection of a
   * session asks for everything, and a refresh that *failed* does not count, so
   * a machine that was offline at the wrong moment tries again on its next turn.
   */
  const scope: ModelRefreshScope =
    options.refreshModels === false && cloudCatalogueLoaded ? 'local' : 'all'
  await refreshModelCache(scope)
  return { providers: collectEngineProviders(), agents: collectEngineAgents(userId) }
}
