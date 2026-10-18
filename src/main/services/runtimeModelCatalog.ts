import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isEngineLoginId, type AgentEngine } from '../../shared/engine'
import type {
  RuntimeEffortChoice,
  RuntimeModelCatalog,
  RuntimeModelChoice,
  RuntimeModelCatalogRefresh
} from '../../shared/runtimeModelCatalog'
import { runtimeModelCatalogRepo } from '../db/runtimeModelCatalogs'
import { runtimeHost } from '../host/runtimeHost'
import { getShellEnv } from '../shell/env'
import { createLogger } from '../logger/logger'

/**
 * The models (and effort levels) each CLI runtime last advertised, per profile.
 *
 * Learned from what a session already said — `session/new`, `session/load`, a
 * `config_option_update` — or from an on-demand refresh that opens a session
 * and asks nothing ({@link refreshRuntimeModelCatalog}). Kept in memory and in
 * `runtime_model_catalogs`, so the Advanced picker and the "no longer offered"
 * warning have something true to say after a restart. Codex alone has a
 * second, read-only source before any session: its own `models_cache.json`.
 *
 * Core: no Electron. Paths come from `runtimeHost`.
 */

const logger = createLogger('runtime-model-catalog')

const catalogs = new Map<string, RuntimeModelCatalog>()
const key = (userId: string, engine: AgentEngine): string => JSON.stringify([userId, engine])
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

/** The ids and categories that name a reasoning-effort option: Claude's `effort`, Codex's `reasoning_effort`, ACP's `thought_level`. */
const EFFORT_IDS = new Set(['effort', 'reasoning_effort', 'thought_level'])

/** What one ACP answer or update says about models and efforts; null when it says nothing about models. */
export function parseRuntimeModelCatalog(metadata: unknown): {
  models: RuntimeModelChoice[]
  /**
   * The efforts offered for {@link currentModel} — the only model an answer
   * describes them for. Empty when the answer has config options but no effort
   * option (that model offers none); undefined for the legacy `models` shape.
   */
  efforts?: RuntimeEffortChoice[]
  currentModel?: string
} | null {
  const data = record(metadata)
  if (!data) return null
  const options = Array.isArray(data.configOptions) ? data.configOptions.map(record) : null
  const modelOption = options?.find(option => option?.category === 'model' || option?.id === 'model')
  const effortOption = options?.find(option => option !== modelOption &&
    (option?.category === 'thought_level' || (typeof option?.id === 'string' && EFFORT_IDS.has(option.id))))
  const models: RuntimeModelChoice[] = []
  const addOptions = (items: unknown[]): void => {
    for (const value of items) {
      const item = record(value)
      if (!item) continue
      if (Array.isArray(item.options)) addOptions(item.options)
      const id = typeof item.value === 'string' ? item.value : typeof item.modelId === 'string' ? item.modelId : null
      if (!id || models.some(model => model.id === id)) continue
      models.push({ id, name: typeof item.name === 'string' && item.name ? item.name : id,
        ...(typeof item.description === 'string' && item.description ? { description: item.description } : {}) })
    }
  }
  const legacy = record(data.models)
  let currentModel: string | undefined
  if (modelOption && Array.isArray(modelOption.options)) {
    addOptions(modelOption.options)
    if (typeof modelOption.currentValue === 'string' && modelOption.currentValue) currentModel = modelOption.currentValue
  } else if (legacy && Array.isArray(legacy.availableModels)) {
    addOptions(legacy.availableModels)
    if (typeof legacy.currentModelId === 'string' && legacy.currentModelId) currentModel = legacy.currentModelId
  } else return null // Unrelated updates must not erase the previously advertised catalog.
  const efforts: RuntimeEffortChoice[] = []
  const addEfforts = (items: unknown[]): void => {
    for (const value of items) {
      const item = record(value)
      if (!item) continue
      if (Array.isArray(item.options)) addEfforts(item.options)
      const id = typeof item.value === 'string' ? item.value : null
      if (!id || efforts.some(effort => effort.id === id)) continue
      efforts.push({ id, name: typeof item.name === 'string' && item.name ? item.name : id })
    }
  }
  if (effortOption && Array.isArray(effortOption.options)) addEfforts(effortOption.options)
  return { models, ...(options ? { efforts } : {}), ...(currentModel ? { currentModel } : {}) }
}

/**
 * Observe session/new, session/load, or config_option_update; never starts a runtime.
 *
 * `defaultModel` is set only by a session the desktop named no model for (the
 * on-demand refresh): its `currentValue` is then the runtime's own default. A
 * turn's session may already sit on the agent's model, so it keeps the default
 * learned before.
 */
export function recordRuntimeModelCatalog(
  userId: string,
  engine: AgentEngine,
  metadata: unknown,
  options: { defaultModel?: boolean } = {}
): void {
  const parsed = parseRuntimeModelCatalog(metadata)
  if (!parsed) return
  const previous = storedCatalog(userId, engine)
  // Only the current model's entry moves: a turn on a model with no effort
  // option must not erase what other models offer.
  const effortsByModel: Record<string, RuntimeEffortChoice[]> = {}
  for (const model of parsed.models) {
    const known = previous?.effortsByModel?.[model.id]
    if (known) effortsByModel[model.id] = known
  }
  if (parsed.currentModel && parsed.efforts !== undefined) effortsByModel[parsed.currentModel] = parsed.efforts
  const defaultModelId = options.defaultModel ? parsed.currentModel : previous?.defaultModelId
  const next: RuntimeModelCatalog = {
    engine,
    models: parsed.models,
    ...(Object.keys(effortsByModel).length > 0 ? { effortsByModel } : {}),
    ...(defaultModelId ? { defaultModelId } : {}),
    source: 'session',
    updatedAt: Date.now()
  }
  catalogs.set(key(userId, engine), next)
  try {
    runtimeModelCatalogRepo.save(userId, next)
  } catch (error) {
    // A cache: the in-memory copy still serves this run.
    logger.warn('could not persist a runtime model catalog', { engine, error: error instanceof Error ? error.message : String(error) })
  }
}

/** This process's copy, else the persisted one (remembered here once read). */
function storedCatalog(userId: string, engine: AgentEngine): RuntimeModelCatalog | null {
  const cached = catalogs.get(key(userId, engine))
  if (cached) return cached
  try {
    const stored = runtimeModelCatalogRepo.get(userId, engine)
    if (stored && Array.isArray(stored.models) && stored.engine === engine) {
      catalogs.set(key(userId, engine), stored)
      return stored
    }
  } catch (error) {
    logger.warn('could not read a persisted runtime model catalog', { engine, error: error instanceof Error ? error.message : String(error) })
  }
  return null
}

const copy = (catalog: RuntimeModelCatalog): RuntimeModelCatalog => ({
  ...catalog,
  models: catalog.models.map(model => ({ ...model })),
  ...(catalog.effortsByModel
    ? { effortsByModel: Object.fromEntries(Object.entries(catalog.effortsByModel).map(([id, list]) => [id, list.map(effort => ({ ...effort }))])) }
    : {})
})

const unavailable = (engine: AgentEngine): RuntimeModelCatalog => ({ engine, models: [], source: 'unavailable', updatedAt: null })

/**
 * The catalogue as it stands: the last session's (this run or persisted), else —
 * for Codex — the CLI's own `models_cache.json`, else `unavailable`.
 */
export async function getRuntimeModelCatalog(userId: string, engine: AgentEngine): Promise<RuntimeModelCatalog> {
  const stored = storedCatalog(userId, engine)
  if (stored) return copy(stored)
  if (engine === 'codex') {
    const cached = readCodexModelsCache(await codexHome())
    if (cached) return cached
  }
  return unavailable(engine)
}

/** The user's Codex profile directory: `CODEX_HOME` from the login shell or this process, else `~/.codex`. */
async function codexHome(): Promise<string> {
  let shellHome: string | undefined
  try {
    shellHome = (await getShellEnv()).CODEX_HOME
  } catch {
    shellHome = undefined
  }
  return shellHome || process.env.CODEX_HOME || join(runtimeHost.getPath('home'), '.codex')
}

/** `<home>/models_cache.json` as a catalogue, or null when it is missing or unreadable. Read-only. */
export function readCodexModelsCache(home: string): RuntimeModelCatalog | null {
  let text: string
  try {
    text = readFileSync(join(home, 'models_cache.json'), 'utf8')
  } catch {
    return null
  }
  return parseCodexModelsCache(text)
}

/**
 * Codex's `models_cache.json`: the models the CLI lists (`visibility: "list"`),
 * in its priority order — the first is the one a fresh session starts on — and
 * every reasoning effort any of them supports. Null when the text holds none.
 */
export function parseCodexModelsCache(text: string): RuntimeModelCatalog | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  const root = record(data)
  const entries = Array.isArray(root?.models) ? root.models : Array.isArray(data) ? data : []
  const listed = entries.map(record)
    .filter((entry): entry is Record<string, unknown> => !!entry && entry.visibility === 'list' && typeof entry.slug === 'string' && entry.slug !== '')
    .map((entry, index) => ({ entry, index, priority: typeof entry.priority === 'number' ? entry.priority : Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
  if (listed.length === 0) return null
  const models: RuntimeModelChoice[] = []
  const effortsByModel: Record<string, RuntimeEffortChoice[]> = {}
  for (const { entry } of listed) {
    const id = entry.slug as string
    if (models.some(model => model.id === id)) continue
    models.push({ id, name: typeof entry.display_name === 'string' && entry.display_name ? entry.display_name : id,
      ...(typeof entry.description === 'string' && entry.description ? { description: entry.description } : {}) })
    const efforts: RuntimeEffortChoice[] = []
    for (const level of Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : []) {
      const effort = record(level)?.effort
      if (typeof effort === 'string' && effort && !efforts.some(known => known.id === effort)) {
        efforts.push({ id: effort, name: effort.charAt(0).toUpperCase() + effort.slice(1) })
      }
    }
    effortsByModel[id] = efforts
  }
  const fetched = typeof root?.fetched_at === 'string' ? Date.parse(root.fetched_at) : NaN
  return {
    engine: 'codex',
    models,
    effortsByModel,
    defaultModelId: models[0].id,
    source: 'cli-cache',
    updatedAt: Number.isFinite(fetched) ? fetched : null
  }
}

/* ---------------------------------------------------------- on-demand refresh */

/**
 * Opens a session on one runtime the way a turn would and returns its
 * `session/new` answer, asking nothing. Installed by the drivers' wiring, which
 * owns the launchers; with none installed (a hub without drivers, a unit test)
 * a refresh says so instead of starting anything.
 */
export type RuntimeModelCatalogProbe = (
  userId: string,
  engine: AgentEngine,
  /**
   * Called with each answer as it arrives: first the `session/new` answer
   * (`first`), recorded at once so the model list does not wait for the efforts;
   * then the answer to setting each offered model in turn, each describing that
   * model's efforts.
   */
  onAnswer: (answer: unknown, first: boolean) => void
) => Promise<{ ok: true } | { error: string }>

let probe: RuntimeModelCatalogProbe | null = null
const inflight = new Map<string, Promise<RuntimeModelCatalogRefresh>>()

export function installRuntimeModelCatalogProbe(next: RuntimeModelCatalogProbe | null): void {
  probe = next
}

/**
 * Ask a runtime for its catalogue now: spawn, `initialize`, `session/new` in a
 * throwaway folder, record, stop. **Single-flight per profile and runtime** —
 * a second caller joins the first. The answer is data, never thrown: the
 * catalogue as it stands afterwards, and why the refresh failed, if it did.
 */
export function refreshRuntimeModelCatalog(userId: string, engine: AgentEngine): Promise<RuntimeModelCatalogRefresh> {
  const id = key(userId, engine)
  const running = inflight.get(id)
  if (running) return running
  const run = (async (): Promise<RuntimeModelCatalogRefresh> => {
    let error: string | null = null
    if (!isEngineLoginId(engine)) error = 'OpenCode lists the models of its AI credentials instead.'
    else if (!probe) error = 'This runtime cannot be asked for its models here.'
    else {
      try {
        let listed = false
        const answer = await probe(userId, engine, (metadata, first) => {
          if (first) {
            listed = !!parseRuntimeModelCatalog(metadata)
            recordRuntimeModelCatalog(userId, engine, metadata, { defaultModel: true })
          } else if (listed) recordRuntimeModelCatalog(userId, engine, metadata)
        })
        if ('error' in answer) error = answer.error
        else if (!listed) error = 'The runtime did not list any models.'
      } catch (err) {
        logger.warn('a runtime model catalog refresh failed', { engine, error: err instanceof Error ? err.message : String(err) })
        error = err instanceof Error && err.message ? err.message : 'The runtime could not be started.'
      }
    }
    return { catalog: await getRuntimeModelCatalog(userId, engine), error }
  })()
  inflight.set(id, run)
  void run.finally(() => { if (inflight.get(id) === run) inflight.delete(id) }).catch(() => undefined)
  return run
}

/** Tests only: forget this process's copies (the persisted ones stay). */
export function resetRuntimeModelCatalogsForTests(): void {
  catalogs.clear()
  inflight.clear()
}
