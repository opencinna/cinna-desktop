import { runtimeHost } from '../../host/runtimeHost'
import { installRuntimeModelCatalogProbe, recordRuntimeModelCatalog } from '../../services/runtimeModelCatalog'
import { chatConductorService, isChatConductor, conductorContext } from '../../services/chatConductorService'
import { isCoordinatorHandover } from '../../../shared/kit/handovers'
/**
 * Production wiring for the drivers, and the one resolver every caller uses.
 *
 * The drivers take their world by injection so they can be driven in a test
 * without a process, a port, a database or Electron. This module is where that
 * world is actually supplied — and it is the only file under `agents/drivers/`
 * that names `localAgentService`, `desktopStateService`, `agentSessionRepo`, the
 * engine's binary resolver or host capabilities, so the dependency direction stays
 * one-way and the test files stay free of them.
 *
 * Phase 2 of the agent runtime plan moved this here from
 * `services/agentTurn/index.ts`, whose `resolveTurnRunner` it replaced. Phase 3
 * took the two folder drivers out again: one `acp` driver runs every local CLI
 * agent, and which engine it launches is a setting rather than an identity.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { applyConductorToolPolicy } from './acp/conductorToolPolicy'
import { prepareCodexConductorPolicy } from './acp/codexConductorPolicy'
import { aiFunctionRuntimePoolKey, syntheticRuntimePoolKey, utilityAgentId } from '../../services/syntheticRuntimePooling'
import { TITLE_SYSTEM_PROMPT } from '../../services/aiFunctionPrompts'
import type { ConductorContext } from '../../services/chatConductorService'
import { chatRuntimePermissions, engineAgentKey } from '../../engine/configGenerator'
import { join } from 'node:path'
import { antigravityBinaryService, claudeBinaryService, codexBinaryService, engineBinaryService, type EngineBinaryService } from '../../engine/engineBinaryService'
import { ManagedAssetError } from '../../managed/managedAsset'
import { collectEngineConfigInput } from '../../engine/engineConfigSource'
import { agentRepo, agentSessionRepo, type AgentRow } from '../../db/agents'
import { CinnaReauthRequired } from '../../auth/cinna-oauth'
import { localAgentService } from '../../services/localAgents/localAgentService'
import { desktopStateService } from '../../services/localAgents/desktopStateService'
import { permissionGrantService } from '../../services/localAgents/permissionGrantService'
import { turnLock } from '../../services/localAgents/turnLock'
import { runAgentTurn } from '../../services/a2aStreamingService'
import { createLogger } from '../../logger/logger'
import { CodexAuthProbe } from './acp/codexAuth'
import { AntigravityAuthProbe } from './acp/antigravityAuth'
import { ANTIGRAVITY_NOT_INSTALLED, antigravityServerArgs, buildAntigravityEnv } from './acp/antigravityEnv'
import { antigravityIsolatedHome, antigravityPreamble, createAntigravityLauncher } from './acp/antigravityLauncher'
import { acpAuthenticateLogin } from './acp/acpLogin'
import { buildCodexEnv } from './acp/codexEnv'
import { CODEX_NOT_INSTALLED, codexBinaryKnownFrom, createCodexLauncher } from './acp/codexLauncher'
import { codexEffortForComplexity, codexEffortForRuntime, declaredEffort, ENGINE_LOGIN_NAMES, isAgentEngine, isEngineLoginId, type AgentEngine, type EngineLoginId } from '../../../shared/engine'
import { ClaudeAuthProbe } from './acp/claudeAuth'
import { EngineLogin } from './acp/engineLogin'
import { pendingRequests } from './pendingRequests'
import { runtimeService } from '../../services/localAgents/runtimeService'
import { defaultEngineService } from '../../services/localAgents/defaultEngineService'
import { providerService } from '../../services/providerService'
import {
  assembleAgentPrompt,
  assembleBareAgentPrompt,
  assembleBareNativePrompt,
  resolveDesktopPromptContext,
  type NativeRuntimeEngine
} from '../../services/localAgents/promptAssembly'
import { getShellEnv, shellEnvForChild } from '../../shell/env'
import { withDeveloperToolShims } from '../../shell/developerToolShims'
import { buildClaudeEnv } from './acp/claudeEnv'
import { readFolderAgents } from './acp/claudeAgents'
import { fetchAgentCard } from '../a2a-client'
import { folderReadinessBlocksTurn, type LocalAgentKind } from '../../../shared/localAgents'
import type { AcpRuntimeMode } from './acp/types'
import type { LocalPermissionRequest } from '../../../shared/localAgentRequests'
import { DEFAULT_CLAUDE_APPROVAL } from '../../../shared/engine'
import type { AcpLauncherId, AgentDriverId } from '../../../shared/agentDrivers'
import { createA2aDriver } from './a2aDriver'
import { createA2aTurnRecoverer } from './a2aTurnRecoverer'
import { createAcpDriver, respondToAcpAsk, type AcpFolderView, type AcpPromptTurn } from './acp/acpDriver'
import { acpProcessPool } from './acp/acpPool'
import { sessionActivityHub } from '../../services/sessionActivityHub'
import { agentUploadsDir } from '../../services/agentUploads'
import { sessionTelemetryService } from '../telemetry/sessionTelemetryService'
import { installChatSessionForgetter } from '../../services/chatSessionRelease'
import { installSessionActivityStopper } from '../../services/sessionActivityStop'
export { acpProcessPool } from './acp/acpPool'
acpProcessPool.onStatus((agentId, state) => {
  if (state.state === 'stopped' || state.state === 'exited') {
    void import('../../services/conductorBridge').then(({ conductorBridge }) => conductorBridge.abortAgent(agentId))
      .catch((error) => logger.warn('Could not close conductor calls after runtime exit', { agentId, error: String(error) }))
  }
})
import { isDevelopmentAgent } from '../../../shared/developmentSession'
import { desktopFeatures } from '../../host/desktopFeatures'
import { customAgentService } from '../../services/customAgentService'
import type { AcpRuntimeView } from './acp/acpRuntime'
import {
  CLAUDE_NOT_INSTALLED,
  createClaudeLauncher,
  createOpencodeLauncher,
  newSessionParams,
  type AcpLauncher,
  type AcpLaunchPlan
} from './acp/acpLaunchers'
import { startAcpConnection } from './acp/acpConnection'
import type { AcpConnection } from './acp/types'
import { resolveAccessToken, resolveEndpointIfNeeded } from './a2aConnection'
import { driverOfRow } from './driverOf'
import { unsupportedDriver } from './unsupportedDriver'
import { createManagedDriver } from './managed/managedDriver'
import { createManagedTurnRecoverer } from './managed/managedTurnRecoverer'
import { agentService } from '../../services/agentService'
import { managedAgentService } from '../../services/managedAgentService'
import { ensureTasksSkillPlugin, tasksSkillInfo, TASKS_SKILL_NAME } from '../../services/tasksSkillService'
import { ARTIFACTS_SKILL_NAME, artifactsSkillInfo, ensureArtifactsSkillPlugin } from '../../services/artifacts/artifactsSkill'
import { ensureKitAgentSkillsPlugin, kitAgentPinnedSkillFolders } from '../../services/agentSkillsPlugin'
import { pinnedSkillAutoFetch } from '../../services/pinnedSkillAutoFetch'
import { engineCredentialEnv } from '../../services/skillRuntime'
import type { AgentDriver, ParkedAsk, RespondOutcome, ReadinessOptions } from './driver'

const logger = createLogger('agent-driver')

/* -------------------------------------------------------- the shared world */

/** The remembered session id for this (chat, agent), if any. */
function readSession(chatId: string, agentId: string): string | null {
  return agentSessionRepo.getByChatAndAgent(chatId, agentId)?.contextId ?? null
}

/**
 * Remember it, in both stores.
 *
 * **Two stores, and the column names stay A2A-flavoured on purpose.**
 * `a2a_sessions.context_id` is what `agent:get-session` reads to decide a chat
 * is an agent chat, so a folder agent's engine session id goes there rather
 * than into a parallel table every existing reader would have to learn about.
 * `desktop.json` is the durable copy that travels with the folder — the SQLite
 * row is a cache, and Invariant 1 says it can be dropped and rebuilt.
 */
function saveSession(input: {
  chatId: string
  agentId: string
  agentDir: string
  agentKind: LocalAgentKind
  sessionId: string
}): void {
  agentSessionRepo.upsert({
    chatId: input.chatId,
    agentId: input.agentId,
    contextId: input.sessionId,
    taskId: null,
    taskState: null
  })
  try {
    const state = desktopStateService.read(input.agentDir, input.agentKind)
    desktopStateService.patch(input.agentDir, input.agentKind, {
      sessions: {
        ...state.sessions,
        [input.chatId]: { sessionId: input.sessionId, updatedAt: Date.now() }
      }
    })
  } catch (err) {
    // The durable copy failing must not fail the turn: the SQLite row above
    // already carries continuity for this machine, and the folder copy is a
    // convenience for a folder that moves.
    logger.warn('could not record the engine session in desktop.json', {
      agentId: input.agentId,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

/**
 * **The reading half of *Always allow*.** The writing half is
 * {@link rememberGrant}, on the answer path, where the user is still waiting
 * and can be told whether the rule was actually saved. Both halves stay out of
 * the engine: OpenCode's own saved grants are per-project rows in a store
 * shared with the user's personal install, and Claude's live in `~/.claude` —
 * so the desktop keeps the rule beside the folder it was granted in and answers
 * the engine `allow_once` from it. See `permissionGrantService`.
 */
function isGranted(
  agentDir: string,
  agentKind: LocalAgentKind,
  request: LocalPermissionRequest
): boolean {
  return permissionGrantService.covers(agentDir, agentKind, request)
}

/** Settle a parked ask in the pending-request registry. */
function resolveRequest(
  requestId: string,
  resolution: Parameters<typeof pendingRequests.resolve>[1]
): boolean {
  return pendingRequests.resolve(requestId, resolution) !== null
}

/* ----------------------------------------------------------- the ACP world */

/**
 * Whether the user's `claude` is logged in — one probe, shared by the turn
 * path, the launcher's readiness and the "Runs with" panel.
 *
 * **Built on the same environment the turn runs in**, and that is the whole
 * reason it is wired here rather than constructed at either call site. This
 * binary answers differently depending on its child environment — withholding
 * `USER` makes a logged-in install report *"Not logged in"* — so a probe run
 * under the full shell environment would report a login for a child that then
 * cannot authenticate. Readiness would be answering about a different process
 * than the one the turn spawns.
 */
/**
 * The binary a tool's sessions run on, **without downloading**: what the
 * service resolved in this run, else what its one shared look finds — the
 * configured path, the managed copy, or an exact-version install of the user's
 * own (`path-pinned`).
 *
 * Through the service's `peek`, not a `stat` of its own, for two reasons. Nothing
 * on disk says "the user's install passed the gate", so a disk-only answer left
 * that user's login `unknown` until their first turn, beside a Runtime row that
 * had probed PATH and said all was well. And the look is memoised there, so the
 * row, readiness and this probe cost one `--version` between them, not one each.
 */
function runningBinary(service: EngineBinaryService): () => Promise<string | null> {
  return async () => {
    const state = await service.peek()
    return state.state === 'ready' ? state.path : null
  }
}

export const claudeAuthProbe = new ClaudeAuthProbe({
  // **The binary the sessions run on** — the Settings path, else the pinned
  // Claude Code — not the PATH copy `toolDetectionService` reports for "Open
  // in…". The login follows HOME, not the binary (verified 2026-09-18: a second
  // binary reported the same Max login with no Keychain prompt).
  claudePath: runningBinary(claudeBinaryService),
  env: async () => withDeveloperToolShims(buildClaudeEnv({ shellEnv: await getShellEnv(), appVersion: runtimeHost.getVersion() }))
})


/**
 * How this build runs a Node program, and where the Claude ACP adapter is.
 *
 * Both live here rather than beside the launcher because both are Electron
 * questions, and this module is the only file under `agents/drivers/` allowed
 * to ask one.
 *
 * **There is no `node` to rely on.** A user who installed Cinna has Electron,
 * not necessarily a Node runtime, and picking one off `PATH` would run the
 * adapter on whatever version happens to be there. `ELECTRON_RUN_AS_NODE=1`
 * makes this app's own binary behave as the Node it already embeds.
 *
 * **Packaging note — read before changing `electron-builder.yml`.** The adapter
 * is `asarUnpack`ed, so the path below is a real file on disk. It has to be: a
 * child process reads the adapter with its own `fs`, and a path inside
 * `app.asar` is not a file to anything but Electron's patched reader. The
 * adapter's hoisted runtime dependencies must also be unpacked: Node's ESM
 * resolver cannot find packages left inside the adjacent `app.asar`.
 * `npm run test:packaged:acp -- <executable> <resources>` checks the handshake
 * against a built app without starting a model turn. The
 * `files` entry that excludes the adapter's *nested* `claude-agent-sdk-*`
 * platform packages is what keeps the unpacked copy from carrying a second
 * ~190 MB `claude` the user never chose; `CLAUDE_CODE_EXECUTABLE` is what makes
 * that exclusion safe.
 */
function hostNodeRuntime(): { command: string; args: string[]; env: Record<string, string> } {
  return runtimeHost.nodeRuntime()
}

const ADAPTER_PACKAGE = '@agentclientprotocol/claude-agent-acp'
const ADAPTER_ENTRY = 'dist/index.js'

function claudeAdapterEntry(): string {
  const path = runtimeHost.resolvePackageFile(`${ADAPTER_PACKAGE}/${ADAPTER_ENTRY}`)
  if (!existsSync(path)) throw new Error(`the Claude ACP adapter is not at ${path}`)
  return path
}

/**
 * The system prompt one turn runs on, for the engine that is about to run it.
 *
 * Two different documents, because the two runtime modes run in two different
 * places. An **isolated** session gets the whole assembled prompt, which
 * replaces the engine's own preset: the preset is a coding assistant's system
 * prompt and the folder already says what this agent is. A **native** session
 * runs on the folder's own setup — the engine loads its instructions file, its
 * settings, its hooks and its MCP servers itself — so it gets only the
 * desktop's context, to be appended to the engine's preset.
 *
 * The engine is baked in per launcher because the two read different files by
 * themselves: `assembleBareNativePrompt` pastes the folder's instructions in
 * only for the engine that would not read *that* file.
 *
 * Called on every plan, so a folder edited between two turns takes effect on
 * the next one. `mode` is the field the driver put on the folder view for this
 * turn, the same one the launcher branched its session options on — one
 * decision, no way for the prompt and the options to disagree.
 *
 * OpenCode is deliberately absent: its prompt travels through the generated
 * config (`engineConfigSource.collectEngineConfigInput`), and a bare OpenCode
 * agent keeps the whole assembled prompt there until that path is settled.
 */
function folderSystemPrompt(
  engine: NativeRuntimeEngine
): (userId: string, agentId: string, mode: AcpRuntimeMode) => string {
  return (userId, agentId, mode) => {
    const synthetic = syntheticRuntimeProfiles.get(agentId)
    if (synthetic?.userId === userId) return synthetic.context.instructions
    const utility = aiFunctionProfiles.get(agentId)
    if (utility?.userId === userId) return utility.systemPrompt
    const conductor = agentRepo.getOwned(userId, agentId)
    if (conductor && isChatConductor(conductor)) return conductorContext(conductor).instructions
    const development = desktopFeatures.developmentAgentContext(userId, agentId)
    if (development) return development.instructions
    const agent = localAgentService.get(userId, agentId)
    // The agent's own id, which is stable per agent — see
    // `DesktopPromptContext.agentId` for why a per-turn id could not go here.
    const context = { ...resolveDesktopPromptContext(engine), agentId }
    // An isolated Antigravity home has cinna-tasks installed natively
    // (`installAntigravitySkill`), so the prompt names the skill; a native
    // folder keeps the path, since nothing is written to the user's home.
    if (engine === 'antigravity' && mode === 'isolated' && context.tasksSkill?.kind === 'pointer') context.tasksSkill = { kind: 'skill' }
    if (engine === 'antigravity' && mode === 'isolated' && context.artifactsSkill?.kind === 'pointer') context.artifactsSkill = { kind: 'skill' }
    if (mode === 'native') {
      return assembleBareNativePrompt(agent.path, agent.name, context, engine)
    }
    // An isolated bare folder is not reachable through `readAcpFolder` today —
    // a development agent is the only isolated folder with no manifest, and it
    // returned above. Kept explicit anyway: the failure it would otherwise
    // cause is a folder answering on the kit assembler's "no instructions yet"
    // stub, which reads as a broken agent rather than as a wiring mistake.
    if (agent.kind === 'bare') return assembleBareAgentPrompt(agent.path, agent.name, context)
    // Codex and Antigravity build no plugin: their pinned skills not on this computer are
    // fetched from here, in the background and once per session (the plugin builder does it too).
    pinnedSkillAutoFetch.fetchMissing(agentId, agent.skills)
    // "The skill tool has them" only when the plugin carrying them was written;
    // otherwise the prompt points at each `SKILL.md` instead.
    let ownSkills = context.ownSkills
    if (ownSkills === 'skill') {
      try {
        if (!kitAgentSkillsPlugin(userId, agentId)) ownSkills = 'pointer'
      } catch {
        ownSkills = 'pointer'
      }
    }
    return assembleAgentPrompt(agent.path, agent.manifest, { ...context, ownSkills })
  }
}

/**
 * Whether Codex is logged in — asked of **the binary the sessions run on**: the
 * explicit Settings path, else the managed pinned copy. Never the PATH copy,
 * which `toolDetectionService` still reports for "Open in…" and which no
 * spawned session uses any more.
 *
 * The login follows `HOME`, not the binary (verified against 0.153.4 and
 * 0.154), so the managed CLI under the same child environment reports the
 * user's own login. The service's `peek` never downloads: before the first
 * install there is simply nothing to ask, and the probe answers `unknown`.
 */
export const codexAuthProbe = new CodexAuthProbe({
  path: runningBinary(codexBinaryService),
  env: async () => withDeveloperToolShims(buildCodexEnv({ shellEnv: await getShellEnv() }))
})

/**
 * Whether the user's Antigravity home is signed in: its `auth.type` and the
 * Google token (macOS keychain, else the home's token file) — read where the
 * server keeps them, never by starting it, which with no token would open a
 * browser by itself. No binary is involved, so there is always an answer.
 */
export const antigravityAuthProbe = new AntigravityAuthProbe({
  env: async () => withDeveloperToolShims(buildAntigravityEnv({ shellEnv: await getShellEnv() }))
})

/**
 * The in-app login for each CLI engine — `claude auth login` / `codex login`,
 * run on **the binary the turns use** (downloading the pin if it is not here
 * yet, which `runningBinary` above deliberately never does) and under **the
 * same environment the auth probe gets**, so the login it leaves is the one the
 * probe and every turn will see. On exit the probe is invalidated before it is
 * asked, so a probe already in flight from before the login cannot answer for it.
 */
export const engineLogins: Record<EngineLoginId, EngineLogin> = {
  claude: new EngineLogin({
    engine: 'claude',
    binary: async () => {
      try {
        return { path: (await claudeBinaryService.ensure()).path }
      } catch (error) {
        return { error: error instanceof ManagedAssetError ? error.message : CLAUDE_NOT_INSTALLED }
      }
    },
    env: async () => withDeveloperToolShims(buildClaudeEnv({ shellEnv: await getShellEnv(), appVersion: runtimeHost.getVersion() })),
    refresh: () => {
      claudeAuthProbe.invalidate()
      return claudeAuthProbe.refresh()
    }
  }),
  codex: new EngineLogin({
    engine: 'codex',
    binary: async () => {
      try {
        return { path: (await codexBinaryService.ensure()).path }
      } catch (error) {
        return { error: error instanceof ManagedAssetError ? error.message : CODEX_NOT_INSTALLED }
      }
    },
    env: async () => withDeveloperToolShims(buildCodexEnv({ shellEnv: await getShellEnv() })),
    refresh: () => {
      codexAuthProbe.invalidate()
      return codexAuthProbe.refresh()
    }
  }),
  // No login CLI: the server itself, in the user home, asked over ACP to
  // `authenticate` with a personal Google login (it opens the browser).
  antigravity: new EngineLogin({
    engine: 'antigravity',
    binary: async () => {
      try {
        return { path: (await antigravityBinaryService.ensure()).path }
      } catch (error) {
        return { error: error instanceof ManagedAssetError ? error.message : ANTIGRAVITY_NOT_INSTALLED }
      }
    },
    env: async () => withDeveloperToolShims(buildAntigravityEnv({ shellEnv: await getShellEnv() })),
    refresh: () => {
      antigravityAuthProbe.invalidate()
      return antigravityAuthProbe.refresh()
    },
    protocol: acpAuthenticateLogin({ args: antigravityServerArgs(), methodId: 'oauth-personal' })
  })
}

/** App shutdown: kill any login still waiting on a browser, and any model-catalogue probe still running. */
export function shutdownEngineLogins(): Promise<void> {
  // Synchronous: the abort reaches each probe's start (or its session wait) before the first await.
  for (const abort of catalogProbes) abort.abort()
  return Promise.all(Object.values(engineLogins).map((login) => login.shutdown())).then(() => undefined)
}

/** Model-catalogue probes in flight, by the controller that stops them at shutdown. */
const catalogProbes = new Set<AbortController>()

/** How long a probe waits for `session/new` once the runtime has started. */
const CATALOG_PROBE_SESSION_TIMEOUT_MS = 60_000
/** The whole per-model walk after `session/new`, all sets together. */
const CATALOG_PROBE_WALK_BUDGET_MS = 30_000
/** At most this many models are set in turn to read their efforts. */
const CATALOG_PROBE_MAX_MODELS = 24

/**
 * **Ask a CLI runtime for its models without a prompt.** The engine's own
 * launcher plans the start — the same binary resolution, child environment and
 * login check as a turn — for a promptless utility profile in its own
 * folder; `startAcpConnection` spawns it and completes `initialize`, exactly as
 * a turn's process pool does; `session/new` answers with the model and effort
 * options; then the process is stopped. The folder is the engine's stable
 * probe folder ({@link modelCatalogProbeDir}), kept between refreshes. Nothing is
 * prompted, so nothing is billed. Single-flight and recording live in
 * `runtimeModelCatalog.refreshRuntimeModelCatalog`.
 *
 * A failure is a sentence: the launcher's own (not installed, not logged in),
 * or a fixed one for a start that failed — the connection's error carries the
 * child's stderr, which is logged, never shown.
 */
async function probeModelCatalog(
  userId: string,
  engine: AgentEngine,
  onAnswer: (answer: unknown, first: boolean) => void
): Promise<{ ok: true } | { error: string }> {
  const launcher = isEngineLoginId(engine) ? acpLaunchers[engine] : undefined
  if (!launcher || !isEngineLoginId(engine)) return { error: 'This runtime cannot be asked for its models here.' }
  const name = ENGINE_LOGIN_NAMES[engine]
  let cwd: string
  try {
    cwd = modelCatalogProbeDir(engine)
  } catch (err) {
    logger.warn('a model catalog probe could not create its folder', { engine, error: err instanceof Error ? err.message : String(err) })
    return { error: `${name} could not be started to list its models.` }
  }
  const probeKey = `model-catalog:${engine}:${randomUUID()}`
  const abort = new AbortController()
  catalogProbes.add(abort)
  aiFunctionProfiles.set(probeKey, { userId, modelId: null, credentialId: null, systemPrompt: '', probe: true })
  let connection: AcpConnection | undefined
  try {
    const plan = await launcher.plan({ userId, agentId: probeKey, folder: {
      name: 'Model catalog', slug: 'model-catalog', description: 'Model catalog', path: cwd, kind: 'bare', runtimeMode: 'isolated'
    } })
    if ('error' in plan) return { error: plan.error }
    if (abort.signal.aborted) return { error: 'The app is closing.' }
    connection = await startAcpConnection(plan.spec, plan.init, { signal: abort.signal })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('session/new timed out')), CATALOG_PROBE_SESSION_TIMEOUT_MS)
      timer.unref?.()
    })
    const closing = new Promise<never>((_resolve, reject) => abort.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    // Both outlive the races they are used in; a late rejection must not be unhandled.
    timeout.catch(() => undefined)
    closing.catch(() => undefined)
    try {
      const created = await Promise.race([connection.newSession(newSessionParams(plan, plan.sessionCwd ?? cwd)), timeout, closing])
      // The model list is recorded now; the efforts follow as they arrive.
      onAnswer(created, true)
      clearTimeout(timer)
      // **Efforts are per model**: an answer describes only its current
      // model's. So each other offered model is set in turn — a config change,
      // never a prompt — and each answer recorded. Bounded in count and by its
      // own total budget (measured: ~0.7 s a set on Claude Code, 13 models in
      // 9 s); a set that fails or runs out of budget leaves that model unseen.
      const walkDeadline = Date.now() + CATALOG_PROBE_WALK_BUDGET_MS
      const option = Array.isArray(created.configOptions)
        ? created.configOptions.find((o) => o.id === 'model' || o.category === 'model') : undefined
      const values: string[] = []
      const collect = (items: unknown): void => {
        if (!Array.isArray(items)) return
        for (const item of items) {
          if (!item || typeof item !== 'object') continue
          const entry = item as { value?: unknown; options?: unknown }
          collect(entry.options)
          if (typeof entry.value === 'string' && !values.includes(entry.value)) values.push(entry.value)
        }
      }
      if (option && 'options' in option) collect(option.options)
      const current = option && typeof option.currentValue === 'string' ? option.currentValue : null
      for (const value of values.filter((v) => v !== current).slice(0, CATALOG_PROBE_MAX_MODELS)) {
        const remaining = walkDeadline - Date.now()
        if (abort.signal.aborted || remaining <= 0) break
        let walkTimer: ReturnType<typeof setTimeout> | undefined
        const outOfBudget = new Promise<never>((_resolve, reject) => {
          walkTimer = setTimeout(() => reject(new Error('walk budget spent')), remaining)
          walkTimer.unref?.()
        })
        outOfBudget.catch(() => undefined)
        try {
          onAnswer(await Promise.race([
            connection.setSessionConfigOption({ sessionId: created.sessionId, configId: option!.id, value }), outOfBudget, closing
          ]), false)
        } catch (err) {
          if (abort.signal.aborted || (err instanceof Error && err.message === 'walk budget spent')) break
        } finally {
          clearTimeout(walkTimer)
        }
      }
      return { ok: true }
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    logger.warn('a model catalog probe could not start its runtime', { engine, error: err instanceof Error ? err.message : String(err) })
    return { error: `${name} could not be started to list its models.` }
  } finally {
    aiFunctionProfiles.delete(probeKey)
    catalogProbes.delete(abort)
    await connection?.dispose().catch(() => undefined)
    // The folder and Antigravity's `<folder>.agyhome` beside it are kept: see `modelCatalogProbeDir`.
  }
}

/**
 * The probe's folder for one engine, beside the chat runtimes' process folders.
 * **Stable and never removed**: Claude Code makes a `~/.claude/projects/<cwd>/`
 * entry for every folder a `session/new` runs in, even with no prompt, so a new
 * folder per refresh would leave one behind in the user's home each time. One
 * folder per engine means at most one such entry, ever. Antigravity's utility
 * home beside it (`<folder>.agyhome`) is kept for the same reason and reused.
 */
function modelCatalogProbeDir(engine: EngineLoginId): string {
  const path = join(runtimeHost.getPath('userData'), 'chat-conductors', 'model-catalog', engine)
  mkdirSync(path, { recursive: true, mode: 0o700 })
  return path
}
installRuntimeModelCatalogProbe(probeModelCatalog)

const syntheticRuntimeProfiles = new Map<string, { userId: string; context: ConductorContext }>()
/**
 * `probe` marks a model-catalogue probe's profile ({@link probeModelCatalog}):
 * it borrows this map so every launcher treats it as a promptless utility
 * session, and is skipped where the map feeds OpenCode's shared config.
 */
const aiFunctionProfiles = new Map<string, { userId: string; modelId: string | null; credentialId: string | null; systemPrompt: string; probe?: true }>()

/**
 * Whether an engine's utility and chat processes run in a profile-owned
 * directory ({@link codexProcessCwd}) rather than a chat's: Codex, whose cwd
 * is part of the launch identity, and Antigravity, whose home (and with it
 * every session it can load) lives in that directory.
 */
function stableProcessCwd(engine: string): boolean {
  return engine === 'codex' || engine === 'antigravity'
}

/** Process cwd is stable; acpDriver/AI Functions supply their own session cwd. */
function codexProcessCwd(poolKey: string): string {
  const path = join(runtimeHost.getPath('userData'), 'chat-conductors', 'processes', createHash('sha256').update(poolKey).digest('hex'))
  mkdirSync(path, { recursive: true, mode: 0o700 })
  return path
}

/** A dedicated utility profile owns a warm process, but never owns resumable sessions. */
export async function prepareAiFunctionRuntime(userId: string, systemPrompt: string, warmOnly: boolean): Promise<{
  poolKey: string; plan: AcpLaunchPlan; cwd: string
}> {
  const runtime = runtimeService.resolve(undefined, providerService.listMerged())
  if (runtime.reason) throw new Error(runtime.reason)
  const engine = runtime.launcher
  // OpenCode instructions are process config; Claude and Codex own them per session.
  let poolKey = aiFunctionRuntimePoolKey(userId, engine, runtime.credentialId ?? null, runtime.modelId ?? null, engine === 'opencode' ? systemPrompt : null)
  // Claude shares a process across function prompts, but instruction files are
  // session-owned too: concurrent functions must never rewrite each other's cwd.
  const digest = createHash('sha256').update(JSON.stringify([poolKey, systemPrompt])).digest('hex').slice(0, 24)
  // Claude's process configuration is independent of the per-session prompt
  // and native tool list. A fresh sealed utility session may reuse this
  // profile's warm chat process, without loading that chat's session/history.
  const liveAgents = agentRepo.list(userId).filter((agent) => agent.driver === 'acp' && acpProcessPool.status(agent.id).state === 'running')
  const compatibleCandidates = engine === 'claude' ? liveAgents.map((agent) => agent.id) : []
  // Codex and Antigravity take their instructions per session, so a live chat
  // conductor's process serves a utility session as it is.
  const chatCandidate = (engine === 'codex' || engine === 'antigravity' || (engine === 'opencode' && systemPrompt === TITLE_SYSTEM_PROMPT)) ? liveAgents.find((agent) => {
    if (!isChatConductor(agent)) return false
    const context = conductorContext(agent)
    return context.engine === engine && context.credentialId === runtime.credentialId && context.modelId === runtime.modelId
  }) : undefined
  if (warmOnly && acpProcessPool.status(poolKey).state !== 'running' && compatibleCandidates.length === 0 && !chatCandidate) {
    throw new Error('AI function deferred until the default runtime is warm')
  }
  const cwd = join(runtimeHost.getPath('userData'), 'chat-conductors', 'ai-functions', digest)
  mkdirSync(cwd, { recursive: true, mode: 0o700 })
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    // The patched Codex adapter accepts exact per-session developer instructions.
    // Do not duplicate function instructions into repository/user-message context.
    // Antigravity reads neither file over ACP; its instructions open the prompt.
    if (engine === 'codex' || engine === 'antigravity') rmSync(join(cwd, name), { force: true })
    else writeFileSync(join(cwd, name), `${systemPrompt}\n`, { mode: 0o600 })
  }
  aiFunctionProfiles.set(poolKey, { userId, modelId: runtime.modelId, credentialId: runtime.credentialId, systemPrompt })
  const launcher = acpLaunchers[engine]
  if (!launcher) throw new Error('The default runtime cannot run AI functions')
  const chatContext = chatCandidate ? conductorContext(chatCandidate) : undefined
  const candidateKey = chatContext ? syntheticRuntimePoolKey(userId, chatContext) : poolKey
  if (chatContext) syntheticRuntimeProfiles.set(candidateKey, { userId, context: chatContext })
  const restrict = async (proposed: AcpLaunchPlan): Promise<AcpLaunchPlan> => applyConductorToolPolicy(engine === 'codex'
    ? await prepareCodexConductorPolicy(proposed, join(runtimeHost.getPath('userData'), 'acp')) : proposed, engine)
  // A warm-only plan is only matched against a running process: it must not
  // start one-time engine work (OpenCode's database bootstrap) on its own.
  let proposed = await launcher.plan({ userId, agentId: candidateKey, warmOnly, folder: {
    name: 'AI Functions', slug: 'ai-functions', description: 'One-shot AI function', path: stableProcessCwd(engine) ? codexProcessCwd(candidateKey) : chatContext?.path ?? cwd, kind: 'bare', runtimeMode: 'isolated'
  } })
  if ('error' in proposed) throw new Error(proposed.error)
  let plan = await restrict(proposed)
  if (chatCandidate) {
    if (acpProcessPool.peek?.(candidateKey, plan.spec.key)) {
      // Hold the process identity, not the chat alias: deleting or changing
      // that chat while a title runs must not move the utility's ownership.
      poolKey = candidateKey
      if (engine === 'opencode') plan = { ...plan, setup: { ...plan.setup, configOptions: plan.setup.configOptions?.map((option) => option.configId === 'mode'
        ? { ...option, value: engineAgentKey(utilityAgentId(candidateKey), 'ai-function') } : option) } }
    } else {
      if (warmOnly) throw new Error('AI function deferred until the default runtime is warm')
      // A credential/environment change can make a live chat process stale.
      // Drafting is allowed to start its dedicated utility process instead.
      proposed = await launcher.plan({ userId, agentId: poolKey, folder: {
        name: 'AI Functions', slug: 'ai-functions', description: 'One-shot AI function', path: stableProcessCwd(engine) ? codexProcessCwd(poolKey) : cwd, kind: 'bare', runtimeMode: 'isolated'
      } })
      if ('error' in proposed) throw new Error(proposed.error)
      plan = await restrict(proposed)
    }
  }
  plan = { ...plan, init: { ...plan.init, clientCapabilities: {} }, session: { ...plan.session, mcpServers: [] } }
  if (engine === 'codex') plan.session.meta = { ...plan.session.meta, cinna: { systemPrompt } }
  // This function's own instructions, whichever process the plan came from.
  if (engine === 'antigravity') plan = { ...plan, firstPromptPreamble: antigravityPreamble(systemPrompt) }
  if (engine === 'claude') {
    const meta = plan.session.meta ?? {}
    const claude = meta.claudeCode as { options?: Record<string, unknown> } | undefined
    plan.session.meta = { ...meta, claudeCode: { ...claude, options: { ...claude?.options, systemPrompt } } }
    const warmKey = [poolKey, ...compatibleCandidates].find((key) => acpProcessPool.peek?.(key, plan.spec.key))
    if (warmKey) poolKey = warmKey
  }
  // Antigravity: the session runs in the empty process folder, its home
  // beside it (see `AcpLaunchPlan.sessionCwd`).
  return { poolKey, plan, cwd: engine === 'antigravity' ? plan.spec.cwd : cwd }
}

/**
 * Where an Antigravity folder agent's pinned skills live, for the permission
 * rule that runs their scripts without asking. None for a bare folder, and
 * none when the manifest or the caches cannot be read — the safe direction.
 */
function antigravityScriptRoots(agent: { path: string; kind: string; manifest?: unknown }): string[] {
  if (agent.kind !== 'kit') return []
  try {
    return kitAgentPinnedSkillFolders(agent.path, agent.manifest)
  } catch {
    return []
  }
}

const acpLaunchers: Partial<Record<AcpLauncherId, AcpLauncher>> = {
  codex: createCodexLauncher({
    // Through the service, like OpenCode's `binary` below: memoised per
    // configured path, concurrent turns share one download, and a failure is
    // never cached. The resolver's messages are this app's own remedy-first
    // sentences, so they are safe to show; anything else (a raw `fetch failed`)
    // becomes the generic one.
    binary: async () => {
      try {
        return { path: (await codexBinaryService.ensure()).path }
      } catch (error) {
        return { error: error instanceof ManagedAssetError ? error.message : CODEX_NOT_INSTALLED }
      }
    },
    binaryKnown: (options) => codexBinaryKnownFrom({
      state: () => codexBinaryService.state(),
      refresh: () => codexBinaryService.refresh(),
      known: runningBinary(codexBinaryService)
    }, options),
    auth: (options) => options?.fresh ? codexAuthProbe.refresh() : codexAuthProbe.status(),
    adapterEntry: () => {
      const entry = '@agentclientprotocol/codex-acp/dist/index.js'
      const path = runtimeHost.resolvePackageFile(entry)
      if (!existsSync(path)) throw new Error('Codex ACP adapter is missing')
      return path
    },
    nodeRuntime: hostNodeRuntime,
    env: async () => withDeveloperToolShims(buildCodexEnv({ shellEnv: await getShellEnv() })),
    systemPrompt: folderSystemPrompt('codex'),
    settings: (userId, agentId) => {
      const synthetic = syntheticRuntimeProfiles.get(agentId)
      if (synthetic?.userId === userId) return { model: synthetic.context.modelId, effort: 'medium', approval: 'ask' }
      const utility = aiFunctionProfiles.get(agentId)
      if (utility?.userId === userId) return { model: utility.modelId, effort: 'medium', approval: 'ask' }
      const conductor = agentRepo.getOwned(userId, agentId)
      if (conductor && isChatConductor(conductor)) return { model: conductorContext(conductor).modelId, effort: 'medium', approval: 'ask' }
      const development = desktopFeatures.developmentAgentContext(userId, agentId)
      if (development) return { model: null, effort: codexEffortForComplexity(development.complexity), approval: 'ask' }
      const agent = localAgentService.get(userId, agentId)
      const model = typeof agent.runtime?.model === 'string' ? agent.runtime.model.trim() || null : null
      return {
        model,
        // A declared effort beside a declared model wins; otherwise the tier's.
        effort: codexEffortForRuntime(agent.runtime),
        approval: desktopStateService.read(agent.path, agent.kind).codexApproval ?? 'ask'
      }
    }
  }),
  antigravity: createAntigravityLauncher({
    binary: async () => {
      try {
        return { path: (await antigravityBinaryService.ensure()).path }
      } catch (error) {
        return { error: error instanceof ManagedAssetError ? error.message : ANTIGRAVITY_NOT_INSTALLED }
      }
    },
    binaryKnown: (options) => codexBinaryKnownFrom({
      state: () => antigravityBinaryService.state(),
      refresh: () => antigravityBinaryService.refresh(),
      known: runningBinary(antigravityBinaryService)
    }, options),
    // Read where the server keeps the login, never by starting it.
    auth: (options) => options?.fresh ? antigravityAuthProbe.refresh() : antigravityAuthProbe.status(),
    authLost: () => {
      antigravityAuthProbe.invalidate()
      void antigravityAuthProbe.refresh().catch(() => undefined)
    },
    env: async () => withDeveloperToolShims(buildAntigravityEnv({ shellEnv: await getShellEnv() })),
    systemPrompt: folderSystemPrompt('antigravity'),
    // A chat runtime or AI function has no shell, so the shell-cwd quirk the
    // nested home fixes does not apply; its home sits beside the (empty)
    // process folder. The server still lets `view_file` read the whole home.
    home: (userId, agentId, folderPath) =>
      syntheticRuntimeProfiles.get(agentId)?.userId === userId || aiFunctionProfiles.get(agentId)?.userId === userId
        ? `${folderPath}.agyhome` : antigravityIsolatedHome(folderPath),
    tasksSkill: () => {
      const info = tasksSkillInfo()
      return info.available ? { name: TASKS_SKILL_NAME, dir: info.dir } : null
    },
    artifactsSkill: () => {
      const info = artifactsSkillInfo()
      return { name: ARTIFACTS_SKILL_NAME, dir: info.available ? info.dir : null }
    },
    settings: (userId, agentId) => {
      const synthetic = syntheticRuntimeProfiles.get(agentId)
      if (synthetic?.userId === userId) return { model: synthetic.context.modelId, approval: 'ask' }
      const utility = aiFunctionProfiles.get(agentId)
      if (utility?.userId === userId) return { model: utility.modelId, approval: 'ask' }
      const conductor = agentRepo.getOwned(userId, agentId)
      if (conductor && isChatConductor(conductor)) return { model: conductorContext(conductor).modelId, approval: 'ask' }
      const development = desktopFeatures.developmentAgentContext(userId, agentId)
      if (development) return { model: development.runtime.modelId, approval: 'ask' }
      const agent = localAgentService.get(userId, agentId)
      const approval = desktopStateService.read(agent.path, agent.kind).antigravityApproval ?? 'ask'
      const resolved = runtimeService.resolve(agent.runtime, providerService.listMerged())
      return {
        // The declared model, else the work complexity's Flash level, else the
        // server's own default — `runtimeService` is the one place that decides.
        model: resolved.modelId,
        modelDeclared: resolved.modelSource === 'declared',
        approval,
        // Only here, the folder agent's branch: every branch above asks about everything.
        ...(approval === 'ask' ? { autoApprove: { scriptRoots: antigravityScriptRoots(agent) } } : {})
      }
    }
  }),
  custom: customAgentService.launcher,
  opencode: createOpencodeLauncher({
    companionAgentIds: (ctx) => syntheticRuntimeProfiles.has(ctx.agentId) ? [utilityAgentId(ctx.agentId)] : [],
    // Through the service, which memoises per *configured path* and never
    // caches a failure — so a path the user has just fixed in Settings is tried
    // on the next turn rather than after a restart, and because the path feeds
    // the launch spec's key, the running child is replaced too.
    binary: () => engineBinaryService.ensure(),
    // `refreshModels: false` for the same reason the old reconcile passed it:
    // this runs once per turn, and a per-turn fan-out of provider API calls
    // would put network latency in front of every message the user sends. The
    // local credentials are still re-asked, because `ollama pull` happens
    // between one turn and the next.
    configInput: async (userId) => {
      const input = await collectEngineConfigInput(userId, { refreshModels: false })
      for (const [agentId, synthetic] of syntheticRuntimeProfiles) {
        if (synthetic.userId !== userId) continue
        const context = synthetic.context
        input.agents.push({ agentId, slug: 'chat-runtime', description: 'Chat runtime', prompt: context.instructions, providerId: context.credentialId ?? '', modelId: context.modelId ?? '', permissionMode: 'replace', permissions: chatRuntimePermissions(context.toolPolicy !== 'none') })
        input.agents.push({ agentId: utilityAgentId(agentId), slug: 'ai-function', description: 'Chat title', prompt: TITLE_SYSTEM_PROMPT, providerId: context.credentialId ?? '', modelId: context.modelId ?? '', permissionMode: 'replace', permissions: { '*': 'deny' } })
      }
      for (const [agentId, utility] of aiFunctionProfiles) {
        if (utility.userId === userId && !utility.probe) input.agents.push({ agentId, slug: 'ai-function', description: 'One-shot AI function', prompt: utility.systemPrompt, providerId: utility.credentialId ?? '', modelId: utility.modelId ?? '', permissionMode: 'replace', permissions: { '*': 'deny' } })
      }
      for (const row of agentRepo.list(userId).filter(isChatConductor)) {
        const context = conductorContext(row)
        input.agents.push({ agentId: row.id, slug: `chat-${row.id}`, description: 'Chat runtime', prompt: context.instructions, providerId: context.credentialId ?? '', modelId: context.modelId ?? '', permissionMode: 'replace', permissions: chatRuntimePermissions(context.toolPolicy !== 'none') })
      }
      for (const row of agentRepo.list(userId).filter(isDevelopmentAgent)) {
        try {
          const context = desktopFeatures.contextForDevelopmentAgent(row)
          input.agents.push({ agentId: row.id, slug: `cinna-build-${row.id}`, description: row.description ?? '',
            prompt: context.instructions, providerId: context.runtime.credentialId ?? '', modelId: context.runtime.modelId ?? '' })
        } catch { /* Other profiles and previous runtimes are deliberately excluded. */ }
      }
      return input
    },
    configRoot: () => join(runtimeHost.getPath('userData'), 'acp'),
    childEnv: async () => withDeveloperToolShims(shellEnvForChild(await getShellEnv()))
  }),
  claude: createClaudeLauncher({
    // Through the service, exactly like Codex above.
    binary: async () => {
      try {
        return { path: (await claudeBinaryService.ensure()).path }
      } catch (error) {
        return { error: error instanceof ManagedAssetError ? error.message : CLAUDE_NOT_INSTALLED }
      }
    },
    binaryKnown: (options) => codexBinaryKnownFrom({
      state: () => claudeBinaryService.state(),
      refresh: () => claudeBinaryService.refresh(),
      known: runningBinary(claudeBinaryService)
    }, options),
    // The login probe holds its answer for a short window; a fresh check asks
    // the binary now, so a `claude login` the user just ran counts.
    claudeAuth: (options) => (options?.fresh ? claudeAuthProbe.refresh() : claudeAuthProbe.status()),
    adapterEntry: claudeAdapterEntry,
    nodeRuntime: hostNodeRuntime,
    claudeEnv: async () =>
      withDeveloperToolShims(buildClaudeEnv({ shellEnv: await getShellEnv(), appVersion: runtimeHost.getVersion() })),
    systemPrompt: folderSystemPrompt('claude'),
    tasksSkillPlugin: () => ensureTasksSkillPlugin(),
    artifactsSkillPlugin: () => ensureArtifactsSkillPlugin(),
    agentSkillsPlugin: kitAgentSkillsPlugin,
    // A model **alias** (`haiku` / `sonnet` / `opus`), not a catalogue id: a
    // plan serves what the plan serves, and `runtimeService.resolve` returns the
    // alias for this engine. Null hands the choice to the CLI's own default.
    model: (userId, agentId) => {
      const synthetic = syntheticRuntimeProfiles.get(agentId)
      if (synthetic?.userId === userId) return synthetic.context.modelId
      const utility = aiFunctionProfiles.get(agentId)
      if (utility?.userId === userId) return utility.modelId
      const conductor = agentRepo.getOwned(userId, agentId)
      if (conductor && isChatConductor(conductor)) return conductorContext(conductor).modelId
      const development = desktopFeatures.developmentAgentContext(userId, agentId)
      if (development) return development.runtime.modelId
      try {
        const agent = localAgentService.get(userId, agentId)
        return runtimeService.resolve(agent.runtime, providerService.listMerged()).modelId
      } catch {
        return null
      }
    },
    // Only a folder agent's own `runtime.model` is declared; tiers, chat modes and build sessions are not.
    modelDeclared: (userId, agentId) => {
      if (syntheticRuntimeProfiles.has(agentId) || aiFunctionProfiles.has(agentId)) return false
      const conductor = agentRepo.getOwned(userId, agentId)
      if (conductor && isChatConductor(conductor)) return false
      if (desktopFeatures.developmentAgentContext(userId, agentId)) return false
      try {
        return runtimeService.resolve(localAgentService.get(userId, agentId).runtime, providerService.listMerged()).modelSource === 'declared'
      } catch {
        return false
      }
    },
    // Only a folder agent declares an effort; every other source above leaves the CLI's own.
    effort: (userId, agentId) => {
      if (syntheticRuntimeProfiles.has(agentId) || aiFunctionProfiles.has(agentId)) return null
      const conductor = agentRepo.getOwned(userId, agentId)
      if (conductor && isChatConductor(conductor)) return null
      if (desktopFeatures.developmentAgentContext(userId, agentId)) return null
      try {
        return declaredEffort(localAgentService.get(userId, agentId).runtime)
      } catch {
        return null
      }
    },
    // Only a folder agent's runtime can fall to the floor; every other source above names its model.
    modelIsFloor: (userId, agentId) => {
      try {
        const agent = localAgentService.get(userId, agentId)
        return runtimeService.resolve(agent.runtime, providerService.listMerged()).modelSource === 'floor'
      } catch {
        return false
      }
    },
    // The desktop's own decision, beside the grants it governs. The default is
    // applied here so the launcher never has to know that "no choice" exists.
    // Unreadable state falls to the default too: the turn still runs, and every
    // ask the classifier declines still reaches the permission block.
    approval: (userId, agentId) => {
      try {
        const agent = localAgentService.get(userId, agentId)
        return (
          desktopStateService.read(agent.path, agent.kind).claudeApproval ?? DEFAULT_CLAUDE_APPROVAL
        )
      } catch {
        return DEFAULT_CLAUDE_APPROVAL
      }
    },
    // Read fresh each turn, like the prompt: a subagent definition edited while
    // the app runs takes effect on the next turn, not the next launch. Kit
    // folders only — the launcher does not ask for a bare folder's, which load
    // from its own settings.
    folderAgents: (agentPath) => readFolderAgents(agentPath).agents
  })
}

/**
 * A **kit** agent's own skills plugin, or null for everything else that runs
 * as an isolated folder: a synthetic chat runtime, an AI function, a chat
 * conductor and a build session each answer null before any folder is read.
 * A bare folder is never asked: it runs native. The folder is located through
 * its index row rather than re-validated whole; the plugin itself comes from
 * `ensureKitAgentSkillsPlugin`, the one builder OpenCode's config uses too.
 */
function kitAgentSkillsPlugin(userId: string, agentId: string): string | null {
  if (syntheticRuntimeProfiles.has(agentId) || aiFunctionProfiles.has(agentId)) return null
  const row = agentRepo.getOwned(userId, agentId)
  if (!row || isChatConductor(row) || isDevelopmentAgent(row)) return null
  const { agentDir } = localAgentService.locate(userId, agentId)
  return ensureKitAgentSkillsPlugin({ id: agentId, path: agentDir })?.dir ?? null
}

/**
 * The folder as it is on disk, for the driver's reconcile, its readiness and
 * its launcher's plan.
 *
 * A filesystem read, on the turn path — which is why it is guarded rather than
 * trusted. `localAgentService.get` throws `not_found` when the row is gone or
 * its folder moved; null then makes the turn keep the launcher its row names,
 * and the driver renders that state as a readable turn error of its own.
 */
function readAcpFolder(userId: string, agentId: string): AcpFolderView | null {
  try {
    const dto = localAgentService.get(userId, agentId)
    return {
      name: dto.name,
      slug: dto.slug,
      description: dto.description,
      path: dto.path,
      kind: dto.kind,
      // **The one place the rule lives.** A bare folder is somebody's own
      // repository, adopted for its instructions file alone, so a turn in it
      // is the turn a terminal session there would get; a kit folder is the
      // harness the desktop scaffolded and stays sealed.
      runtimeMode: dto.kind === 'bare' ? 'native' : 'isolated',
      enabled: dto.enabled,
      readiness: dto.readiness,
      readinessReason: dto.readinessReason,
      blocksTurn: folderReadinessBlocksTurn(dto),
      runtime: dto.runtime,
      coordinatorHandback: dto.kind === 'kit' && Array.isArray(dto.manifest.handovers) && dto.manifest.handovers.some(isCoordinatorHandover)
    }
  } catch (err) {
    logger.warn('a folder agent could not be read; keeping the launcher its row names', {
      agentId,
      error: err instanceof Error ? err.message : String(err)
    })
    return null
  }
}

async function readAcpRuntime(userId: string, agent: AgentRow, options?: ReadinessOptions): Promise<AcpRuntimeView | null> {
  if (isChatConductor(agent)) return chatConductorService.runtime(userId, agent)
  if (isDevelopmentAgent(agent)) {
    const context = await desktopFeatures.restoreDevelopmentContext(agent, options)
    const state = customAgentService.runtime(userId, agent)
    return {
      ...state, type: 'folder',
      // `kind: 'bare'` because this workspace has no manifest — but
      // **`runtimeMode: 'isolated'`**: it is a folder the desktop synced for
      // its own build session, not a repository the user adopted, and it runs
      // on the instructions `developmentContext` assembled rather than on
      // whatever `.claude/settings.json` the workspace happens to carry.
      folder: { name: agent.name, slug: `cinna-build-${agent.id}`, description: agent.description ?? '',
        path: context.workspacePath, kind: 'bare', runtimeMode: 'isolated',
        enabled: agent.enabled, readiness: 'ok', readinessReason: null, blocksTurn: false,
        runtime: { engine: context.runtime.launcher } },
      validate(chatId) { state.validate(chatId); desktopFeatures.contextForDevelopmentAgent(agent) }
    }
  }
  if (agent.source === 'local' && agent.driverConfig?.launcher === 'custom') return customAgentService.runtime(userId, agent)
  const folder = readAcpFolder(userId, agent.id)
  if (!folder) return null
  return {
    type: 'folder', folder, validate() {},
    readSession: (chatId) => readSession(chatId, agent.id),
    saveSession: (chatId, sessionId) => saveSession({ chatId, agentId: agent.id, agentDir: folder.path, agentKind: folder.kind, sessionId }),
    isGranted: (request) => isGranted(folder.path, folder.kind, request),
    rememberGrant: (request) => { permissionGrantService.remember(folder.path, folder.kind, request); return true }
  }
}

/**
 * The launcher a turn on `id` uses: the engine's own, wrapped for a chat
 * runtime (its profile-owned pool key and process folder, the chat tool policy
 * a verified engine needs, and — for Antigravity — sessions in that folder) and
 * for Cinna's own build session (its managed CLI tools on PATH).
 */
export function acpLauncherFor(id: AcpLauncherId): AcpLauncher | undefined {
  const launcher = acpLaunchers[id]
  if (!launcher) return undefined
  return { ...launcher, async plan(ctx) {
    const agent = agentRepo.getOwned(ctx.userId, ctx.agentId)
    if (agent && isChatConductor(agent) && ctx.folder) {
      const context = conductorContext(agent)
      const poolKey = syntheticRuntimePoolKey(ctx.userId, context)
      syntheticRuntimeProfiles.set(poolKey, { userId: ctx.userId, context })
      // Codex includes its process cwd in the launch identity. Keep that
      // profile-owned while acpDriver supplies each chat's own session cwd.
      const processCwd = stableProcessCwd(id) ? codexProcessCwd(poolKey) : ctx.folder.path
      let plan = await launcher.plan({ ...ctx, agentId: poolKey, folder: { ...ctx.folder, path: processCwd, slug: 'chat-runtime' } })
      if ('error' in plan) return plan
      if (id === 'codex') {
        try { plan = await prepareCodexConductorPolicy(plan, join(runtimeHost.getPath('userData'), 'acp')) }
        catch (error) {
          return { error: error instanceof Error && error.message.startsWith('Codex cannot enforce the chat tool policy:')
            ? error.message : 'Codex chat policy could not be verified. Check the installed runtime.' }
        }
      }
      // Antigravity's sessions run in the empty process folder itself, with
      // its home beside it: never in the chat folder. `view_file` can still
      // read the whole home (verified, drafts p7c), conversations included.
      if (id === 'antigravity') plan = { ...plan, sessionCwd: processCwd }
      acpProcessPool.share?.(ctx.agentId, poolKey)
      return plan
    }
    const development = desktopFeatures.developmentAgentContext(ctx.userId, ctx.agentId)
    if (!development) return launcher.plan(ctx)
    const execution = await desktopFeatures.developmentExecutionContext(development.profileId)
    const plan = await launcher.plan(ctx)
    desktopFeatures.developmentAgentContext(ctx.userId, ctx.agentId)
    if ('error' in plan) return plan
    // Keep runtime credential/environment policy; add only the managed CLI tools.
    // The development PATH replaces the one the launcher shimmed, so the
    // developer-tool shims go back in front of it (a no-op when already first).
    const path = (await withDeveloperToolShims({ PATH: execution.env.PATH ?? plan.spec.env.PATH ?? '' })).PATH ?? ''
    return { ...plan, spec: { ...plan.spec, env: { ...plan.spec.env, PATH: path },
      key: createHash('sha256').update(JSON.stringify([plan.spec.key, path])).digest('hex') } }
  } }
}

/**
 * Where a turn's attachments are copied for the engine to open with its own
 * tools ({@link agentUploadsDir}), or null to inline them as text. A remote
 * engine cannot see this disk, and a chat runtime runs with its file tools
 * removed, so both get text.
 */
function attachmentUploadsDir({ agent, runtime, plan }: AcpPromptTurn): string | null {
  if (plan.spec.remote || isChatConductor(agent)) return null
  return agentUploadsDir(agent.id, runtime.type === 'folder' && runtime.folder.kind === 'kit' && !isDevelopmentAgent(agent) ? runtime.folder.path : null)
}

export const acpDriver = createAcpDriver({
  prepareCredentials: async (agent, plan) => {
    if (agent.source !== 'folder' || isDevelopmentAgent(agent) || isChatConductor(agent) || plan.spec.remote) return plan
    const { serviceCredentialService } = await import('../../services/serviceCredentials/service')
    const prepared = await serviceCredentialService.prepare(agent.id)
    // Every engine (Claude, Codex, OpenCode) is launched with this env and passes it to the
    // shell its tools run in: the credentials path, and for a kit agent the skill runtime.
    const env = engineCredentialEnv(plan.spec.env, prepared)
    return { ...plan, credentialPrompt: prepared.prompt, spec: { ...plan.spec, env, key: `${plan.spec.key}:credentials:${prepared.generation}` } }
  },
  recordModelCatalog: (userId, launcher, metadata) => {
    if (isAgentEngine(launcher)) recordRuntimeModelCatalog(userId, launcher, metadata)
  },
  pool: acpProcessPool,
  prepareConductor: async (userId, agent, input, plan, stop, wake) => {
    const { conductorBridge } = await import('../../services/conductorBridge')
    return conductorBridge.prepare(userId, agent, input, plan, stop, wake)
  },
  conductorAbandoned: (chatId, agentId, reason) => {
    void import('../../services/conductorBridge').then(({ conductorBridge }) => conductorBridge.abandonWaiters(chatId, agentId, reason))
      .catch((error) => logger.warn('Could not release conductor calls after an abandoned follow-up', { agentId, error: String(error) }))
  },
  buildPrompt: (userId, input, connection, turn) => import('../../services/acpAttachments').then(({ buildAcpPrompt }) => buildAcpPrompt(userId, input, connection, attachmentUploadsDir(turn))),
  replayTranscript: (chatId, messageId, connection, userId, agentId, turn) => import('../../services/conductorTranscript').then(({ replayTranscript }) => replayTranscript(chatId, messageId, connection, userId, agentId, attachmentUploadsDir(turn))),
  launcher: (id) => acpLauncherFor(id),
  readRuntime: readAcpRuntime,
  // Read again under the turn lock: a kit agent's folder can be renamed while
  // a turn planned in it waits behind the rename.
  currentFolderPath: (userId, agent) => {
    if (isChatConductor(agent) || isDevelopmentAgent(agent)) return undefined
    if (agent.source === 'local' && agent.driverConfig?.launcher === 'custom') return undefined
    try {
      return localAgentService.locate(userId, agent.id).agentDir
    } catch {
      return null
    }
  },
  defaultEngine: () => defaultEngineService.current(),
  registerRequest: (input) => pendingRequests.register(input),
  resolveRequest,
  // Shared: turns on one agent run side by side (one per chat, which the run
  // service enforces); only the desktop's own exclusive folder writes keep them out.
  withLock: (agentId, owner, fn, queuedSignal, signal) => queuedSignal
    ? turnLock.withQueuedSharedLock(agentId, owner, queuedSignal, fn) : turnLock.withSharedLock(agentId, owner, fn, signal),
  // The title a Codex chat's root session gives its thread names the chat.
  sessionTitle: ({ profileUserId, chatId, agentId, title }) => {
    void import('../../services/chatTitleService')
      .then(({ chatTitleService }) => chatTitleService.applyEngineTitle({ userId: profileUserId, chatId, agentId, title }))
      .catch((err: unknown) => logger.warn('could not apply an engine title', { chatId, error: err instanceof Error ? err.message : String(err) }))
  },
  // Subagents and background processes a session reports, for the composer's badges.
  activity: sessionActivityHub,
  // Tokens, cost, context and login a session reports, for the mode badge's popover.
  telemetry: sessionTelemetryService,
  // A turn the agent starts between the user's turns becomes a run of the
  // chat. Imported when first needed: the service reaches this module back
  // through the run service.
  openFollowUp: (request) => {
    void import('../../services/followUpTurnService')
      .then(({ followUpTurnService }) => followUpTurnService.open(request))
      .catch((err: unknown) => {
        logger.error('the follow-up turn service could not be loaded', { error: err instanceof Error ? err.message : String(err) })
        request.abandon('the follow-up turn service could not be loaded')
      })
  }
})
// A trashed chat, or one that answers to another agent now, stops hearing its old sessions.
installChatSessionForgetter((chatId, agentId) => acpDriver.forgetChatSessions(chatId, agentId))
// Stop on a background process the composer's popover lists.
installSessionActivityStopper('acp', acpDriver.activityStopper)
// Measure a chat's context by category on demand (Claude; the telemetry popover asks).
sessionTelemetryService.installContextMeasurer((chatId) => acpDriver.measureContext(chatId))

/** Relaunch recovery of `a2a` turns, with the driver's own credential resolution. */
export const a2aTurnRecoverer = createA2aTurnRecoverer({
  resolveEndpoint: resolveEndpointIfNeeded,
  resolveAccessToken,
  isReauthRequired: (err) => err instanceof CinnaReauthRequired
})

/** Relaunch recovery of `managed` turns, with the driver's own binding resolution. */
export const managedTurnRecoverer = createManagedTurnRecoverer({
  findAgent: (settingsUserId, profileUserId, agentId) => agentService.findAgent(settingsUserId, profileUserId, agentId),
  readiness: (agent) => managedAgentService.readiness(agent),
  prepare: (ownerId, agent, chatId) => managedAgentService.prepare(ownerId, agent, chatId),
  registerRequest: (input) => pendingRequests.register(input)
})

/* ------------------------------------------------------------ the resolver */

const drivers: Record<AgentDriverId, AgentDriver> = {
  a2a: createA2aDriver({
    runTurn: runAgentTurn,
    resolveEndpoint: resolveEndpointIfNeeded,
    resolveAccessToken,
    fetchCard: fetchAgentCard,
    isReauthRequired: (err) => err instanceof CinnaReauthRequired,
    saveTaskState: ({ chatId, agentId, taskId, taskState }) =>
      agentSessionRepo.upsert({ chatId, agentId, contextId: null, taskId, taskState })
  }),
  acp: acpDriver,
  managed: createManagedDriver({
    prepare: (ownerId, agent, chatId) => managedAgentService.prepare(ownerId, agent, chatId),
    readiness: (agent) => managedAgentService.readiness(agent),
    registerRequest: (input) => pendingRequests.register(input)
  })
}

/**
 * Which driver runs an agent.
 *
 * The one dispatch point — the direct-chat IPC handler, the orchestrator's
 * agent tool and the answer path all ask it — so there is exactly one place to
 * look when asking "why did this agent take that path", and exactly one place
 * to change when another kind of agent arrives. Reads the row only: the ACP
 * driver checks the folder itself when it runs a turn, and picks its launcher
 * from what the folder says then.
 */
export function driverFor(agent: Pick<AgentRow, 'driver' | 'source'>): AgentDriver {
  const id = driverOfRow(agent)
  return id ? drivers[id] : unsupportedDriver
}

/**
 * Answer a parked ask whose agent row is gone.
 *
 * Removing an agents folder prunes its rows without waiting for the turn lock,
 * so a turn can still be parked on an agent no driver can be found for. Only
 * the ACP driver parks, and it shares the registry, so the answer is delivered
 * the way it delivers one — with no *Always allow* written, because there is no
 * agent left to keep a rule beside: `always` settles as `once`,
 * `remembered: false`. Synchronous, like `respond`.
 */
export function respondToOrphanedAsk(
  ask: ParkedAsk,
  resolution: Parameters<AgentDriver['respond']>[1]
): RespondOutcome {
  return respondToAcpAsk({ rememberGrant: () => false, resolveRequest }, ask, resolution)
}

/** The same runtime gates used by the turn, before presenting the build composer. */
export async function developmentRuntimeBlocker(engine: import('../../../shared/engine').AgentEngine): Promise<{ blocker: string | null; installTool?: 'claude' | 'codex' | null; loginTool?: EngineLoginId | null }> {
  const ready = await acpLaunchers[engine]?.readiness?.({ fresh: true })
  // Only Claude is a CLI the user installs. OpenCode and Codex are fetched by
  // Cinna, so offering to install a PATH copy of either would install a tool no
  // spawned session uses — a failed managed download is retried in Settings.
  if (ready && ready.state !== 'ok') return { blocker: ready.reason ?? 'Check your default runtime in Settings.',
    installTool: ready.state === 'not_installed' && engine === 'claude' ? engine : null,
    loginTool: ready.state === 'not_logged_in' ? ready.login ?? null : null }
  if (engine === 'opencode') {
    try { await engineBinaryService.ensure() } catch (error) {
      return { blocker: error instanceof Error ? error.message : 'OpenCode could not be installed. Check Runtime settings.' }
    }
  }
  return { blocker: null }
}
