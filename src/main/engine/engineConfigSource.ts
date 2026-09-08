/**
 * Turning this desktop's state — credentials, folder agents, runtimes — into
 * the pure input `configGenerator` wants.
 *
 * It sits between `engineManager` (which knows about a process) and
 * `configGenerator` (which knows about OpenCode's config shape) so that neither
 * has to know about `providerService`, `localAgentService` or the manifest. The
 * practical payoff is that `engineManager` can be driven in a test with a
 * three-line fake supplier instead of a database.
 *
 * **This is the one place a decrypted API key is read**, and it hands the key
 * straight to `buildEngineConfig`, which puts it in the environment map and an
 * `{env:…}` reference in the config. Nothing here returns a key to a caller
 * that could log it.
 */

import { decryptApiKey } from '../security/keystore'
import { llmProviderRepo } from '../db/llmProviders'
import { getManagedResourceScopes } from '../auth/scope'
import { getAllModels } from '../llm/registry'
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
 * account-provisioned machine unable to run a local agent at all. The two
 * exclusions are credentials that cannot make an API call in the first place —
 * no stored key, or a managed row this app already marks `unsupported` (an
 * Anthropic OAuth token, which is not an API key).
 */
export function collectEngineProviders(): EngineProviderInput[] {
  const dtos = providerService.listMerged()
  const rows = new Map(
    llmProviderRepo.listByUserIds(getManagedResourceScopes()).map((row) => [row.id, row])
  )
  const models = modelsByProvider()
  const out: EngineProviderInput[] = []

  for (const dto of dtos) {
    if (!dto.hasApiKey || dto.unsupported) continue
    const row = rows.get(dto.id)
    if (!row?.apiKeyEncrypted) continue
    let apiKey: string
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
    if (apiKey === '') continue
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
let cachedModels: { id: string; name: string; providerId: string }[] = []

export async function refreshModelCache(): Promise<void> {
  try {
    cachedModels = (await getAllModels()).map((model) => ({
      id: model.id,
      name: model.name,
      providerId: model.providerId
    }))
  } catch (err) {
    logger.warn('could not refresh the model list for the engine config', {
      error: err instanceof Error ? err.message : String(err)
    })
  }
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
  if (options.refreshModels !== false) await refreshModelCache()
  return { providers: collectEngineProviders(), agents: collectEngineAgents(userId) }
}
