/**
 * The launcher for an agent in an Agent Vault (README "Layer 3"): the engine
 * runs inside the guest, started by cinna-vaultd (`engine.spawn`), and every
 * input a host launcher reads from the folder or the user's home is either
 * inside the vault or not offered at all.
 *
 * Claude, Codex, OpenCode and Antigravity run in a vault (the other plans are
 * in `vaultEngineLaunchers.ts`); Antigravity signs in with a Gemini API key,
 * since its Google login cannot be completed inside a vault yet. What a
 * Claude session is given, against the host Claude launcher
 * (`acpLaunchers.ts` `createClaudeLauncher`):
 *
 * - cwd `/vault/agent`; HOME is the vault's `/vault/home`, so `settingSources`
 *   `user` never reaches the host `~/.claude`;
 * - a **kit** agent runs sealed like on the host (`settingSources: []`,
 *   `strictMcpConfig`), on the prompt the host assembled when it moved in
 *   (kept in the vault, `VAULT_KV_INSTRUCTIONS`); a **bare** one runs native,
 *   on the `claude_code` preset and its own folder's settings;
 * - no host paths: no plugins (cinna-tasks, skills, artifacts, dashboards),
 *   no `.claude/agents` read from a host folder, no design-pack read rule;
 * - no MCP servers, and in particular no loopback `cinna` server (D6);
 * - the login is the vault's own (`auth.status`: an API key or a token put
 *   with `secrets.put`); nothing of the host's Claude auth is involved;
 * - **how it behaves comes from inside the vault** (D34): approval mode,
 *   model, sealed or native, and the prompt are read from the vault's kv
 *   (`cinna.launch`, `cinna.instructions`) on every launch. The host row's
 *   copies (`VaultAgentLaunchInfo.kind/model/approval`) are for display only:
 *   Cinna's database is not trusted to change what the agent may do.
 */
import { createHash } from 'node:crypto'
import type { AgentReadiness } from '../../../../shared/agentDrivers'
import type { ClaudeApproval } from '../../../../shared/engine'
import type { RuntimeKind, VaultEngine, VaultState } from '../../../../shared/vault/protocol'
import type { VaultdClient } from '../../../vault/vaultdClient'
import { parseLaunchSettings, VAULT_KV_INSTRUCTIONS, VAULT_KV_LAUNCH, VAULT_LAUNCH_FALLBACK, type VaultLaunchSettings } from '../../../vault/vaultAgentState'
import { airClientMeta } from './acpActivity'
import type { AcpLauncher, AcpPlanResult } from './acpLaunchers'
import { RAW_SDK_MESSAGE_FILTER } from './acpSdkTelemetry'
import { ACP_PROTOCOL_VERSION, VAULT_AGENT_CWD } from './types'
import { currentRuntimeRow, matchesPin, type RuntimePin } from '../../../vault/runtimeInstall'

/** `driverConfig.vault` as the launcher reads it. */
export interface VaultAgentLaunchInfo {
  vaultId: string
  engine: VaultEngine
  /** Display copy only (D34): the launch reads the vault's own `cinna.launch`. */
  kind: 'kit' | 'bare'
  /** Display copy only (D34). */
  model: string | null
  /** Display copy only (D34). */
  approval: ClaudeApproval
}

export interface VaultLauncherDeps {
  /** The vault agent's launch facts, or null when the agent is not in a vault. */
  vaultOf(userId: string, agentId: string): VaultAgentLaunchInfo | null
  /** Last known state of a vault (never asks the backend). */
  stateOf(vaultId: string): VaultState
  /** The vault's vaultd control connection (rejects while locked). */
  client(vaultId: string): Promise<Pick<VaultdClient, 'request'>>
  /** The agent folder as processes in the vault see it (`/vault/agent` in a guest). Default: that. */
  agentCwd?(vaultId: string): string
  /**
   * What this app installs of an engine (`RuntimeSource.pins`): a runtime in
   * the vault that is not this, by version and sha256, is never started.
   */
  pins(engine: VaultEngine): RuntimePin[]
}

export const VAULT_LOCKED_REASON = 'This agent is in a vault that is locked. Unlock it to send a message.'
/** Antigravity in a vault signs in with a Gemini API key; its Google sign-in cannot be completed there (no browser, no host login handed in). */
export const VAULT_ANTIGRAVITY_SIGNED_OUT = 'Set a Gemini API key; Google sign-in isn’t supported inside a vault yet.'
export const VAULT_OPENCODE_NO_PROVIDER = 'This agent’s model is not an OpenAI or Anthropic one, the only providers OpenCode can reach inside a vault.'
const CLIENT_INFO = { name: 'cinna-desktop', version: '1' }

export const VAULT_ENGINE_NAME: Record<VaultEngine, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', antigravity: 'Antigravity' }
const KEY_OWNER: Record<string, string> = { ANTHROPIC_API_KEY: 'an Anthropic', OPENAI_API_KEY: 'an OpenAI', GEMINI_API_KEY: 'a Gemini' }

/** Said when an engine's runtime (or its adapter) is not in the vault. */
export function vaultEngineMissing(engine: VaultEngine): string {
  return `${VAULT_ENGINE_NAME[engine]} is not installed in this vault. Use Update dependencies on the agent’s Security tab.`
}

/** Said when the runtime an engine would run in the vault is not the one this app pins (another version, or other bytes). */
export function vaultEngineNotPinned(engine: VaultEngine): string {
  return `The ${VAULT_ENGINE_NAME[engine]} in this vault isn’t the one this app pins. Use Update dependencies on the agent’s Security tab.`
}

/** Said when an engine is not signed in inside the vault; `keyName` is the secret `auth.status` named. */
export function vaultEngineSignedOut(engine: VaultEngine, keyName: string | undefined): string {
  if (engine === 'antigravity') return VAULT_ANTIGRAVITY_SIGNED_OUT
  const owner = (keyName && KEY_OWNER[keyName]) ?? 'an'
  return `${VAULT_ENGINE_NAME[engine]} is not signed in inside this vault. Add ${owner} API key on the agent’s Security tab.`
}

export function specKey(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)
}

type RuntimeRow = { engine: VaultEngine; version: string; kind: RuntimeKind; sha256: string }

/**
 * The executable (or archive) and adapter an engine would run in the vault —
 * the last installed of each kind, as cinna-vaultd picks them — when each is
 * exactly what `pins` names (version and sha256). `missing`: one it needs is
 * not there; `not_pinned`: what is there is another version or other bytes.
 */
export function installedRuntime(
  runtimes: readonly RuntimeRow[],
  engine: VaultEngine,
  pins: readonly RuntimePin[]
): { executable: RuntimeRow; adapter: RuntimeRow | null } | 'missing' | 'not_pinned' {
  const executablePin = pins.find((pin) => pin.engine === engine && pin.kind !== 'adapter')
  const adapterPin = pins.find((pin) => pin.engine === engine && pin.kind === 'adapter') ?? null
  if (!executablePin) return 'missing'
  const executable = currentRuntimeRow(runtimes, engine, false)
  const adapter = adapterPin ? currentRuntimeRow(runtimes, engine, true) : null
  if (!executable || (adapterPin && !adapter)) return 'missing'
  if (!matchesPin(executable, executablePin) || (adapterPin && adapter && !matchesPin(adapter, adapterPin))) return 'not_pinned'
  return { executable, adapter }
}

function runtimeProblem(engine: VaultEngine, found: 'missing' | 'not_pinned'): string {
  return found === 'missing' ? vaultEngineMissing(engine) : vaultEngineNotPinned(engine)
}

/** Everything a plan reads from inside the vault, at every launch (D34). */
export interface VaultLaunchFacts {
  info: VaultAgentLaunchInfo
  runtime: { executable: RuntimeRow; adapter: RuntimeRow | null }
  auth: { loggedIn: boolean; method?: string; keyName?: string }
  launch: VaultLaunchSettings
  /** A kit agent's captured prompt; null for a bare one. */
  instructions: string | null
}

/** Read {@link VaultLaunchFacts} for an engine, or the sentence a plan fails with. */
export async function readVaultLaunchFacts(deps: VaultLauncherDeps, ctx: { userId: string; agentId: string }, engine: VaultEngine): Promise<VaultLaunchFacts | { error: string }> {
  const info = deps.vaultOf(ctx.userId, ctx.agentId)
  if (!info) return { error: 'This agent is not in a vault.' }
  if (info.engine !== engine) return { error: `This agent runs on ${VAULT_ENGINE_NAME[info.engine]}, not ${VAULT_ENGINE_NAME[engine]}.` }
  if (deps.stateOf(info.vaultId) !== 'unlocked') return { error: VAULT_LOCKED_REASON }
  let runtimes: RuntimeRow[]
  let auth: { loggedIn: boolean; method?: string; keyName?: string }
  let instructions: string | null = null
  let launch: VaultLaunchSettings
  try {
    const client = await deps.client(info.vaultId)
    runtimes = (await client.request('runtime.status', {})).runtimes
    auth = await client.request('auth.status', { engine })
    // The vault's word, never the row's (D34).
    const stored = (await client.request('kv.get', { key: VAULT_KV_LAUNCH })).value
    launch = stored === undefined || stored === null ? { ...VAULT_LAUNCH_FALLBACK } : parseLaunchSettings(stored)
    if (launch.kind === 'kit') {
      const { value } = await client.request('kv.get', { key: VAULT_KV_INSTRUCTIONS })
      instructions = typeof value === 'string' && value.trim() ? value : null
    }
  } catch {
    return { error: deps.stateOf(info.vaultId) !== 'unlocked' ? VAULT_LOCKED_REASON : 'The vault did not answer.' }
  }
  const runtime = installedRuntime(runtimes, engine, deps.pins(engine))
  if (typeof runtime === 'string') return { error: runtimeProblem(engine, runtime) }
  if (engine === 'opencode' && !launch.provider) return { error: VAULT_OPENCODE_NO_PROVIDER }
  if (!auth.loggedIn) return { error: vaultEngineSignedOut(engine, auth.keyName) }
  return { info, runtime, auth, launch, instructions }
}

/** Readiness of a vault agent: locked, runtime missing, signed out, else ok. Never throws. */
export async function vaultReadiness(deps: VaultLauncherDeps, info: VaultAgentLaunchInfo): Promise<AgentReadiness> {
  if (deps.stateOf(info.vaultId) !== 'unlocked') return { state: 'vault_locked', reason: VAULT_LOCKED_REASON }
  try {
    const client = await deps.client(info.vaultId)
    const { runtimes } = await client.request('runtime.status', {})
    const runtime = installedRuntime(runtimes, info.engine, deps.pins(info.engine))
    if (typeof runtime === 'string') return { state: 'not_installed', reason: runtimeProblem(info.engine, runtime) }
    if (info.engine === 'opencode') {
      const stored = (await client.request('kv.get', { key: VAULT_KV_LAUNCH })).value
      if (!parseLaunchSettings(stored).provider) return { state: 'invalid', reason: VAULT_OPENCODE_NO_PROVIDER }
    }
    const auth = await client.request('auth.status', { engine: info.engine })
    if (!auth.loggedIn) return { state: 'not_logged_in', reason: vaultEngineSignedOut(info.engine, auth.keyName) }
    return { state: 'ok', reason: null }
  } catch (error) {
    // A vault that locked between the state read and the request.
    if (deps.stateOf(info.vaultId) !== 'unlocked') return { state: 'vault_locked', reason: VAULT_LOCKED_REASON }
    return { state: 'invalid', reason: 'The vault did not answer.', detail: error instanceof Error ? error.message : String(error) }
  }
}

/** Claude in a vault. */
export function createVaultClaudeLauncher(deps: VaultLauncherDeps): AcpLauncher {
  return {
    id: 'claude',
    endsTurnsWithCostedUsage: true,

    async plan(ctx): Promise<AcpPlanResult> {
      const facts = await readVaultLaunchFacts(deps, ctx, 'claude')
      if ('error' in facts) return facts
      const { info, auth, launch, instructions } = facts
      const executable = facts.runtime.executable
      const adapter = facts.runtime.adapter!

      const sealed = launch.kind === 'kit'
      const cwd = deps.agentCwd?.(info.vaultId) ?? VAULT_AGENT_CWD
      const model = launch.model
      const mode = launch.approval === 'auto' ? 'auto' : 'default'
      return {
        spec: {
          vault: { agentId: ctx.agentId, vaultId: info.vaultId, engine: 'claude', extraEnv: {}, mode },
          command: '',
          args: [],
          env: {},
          cwd,
          // What the process was started with, by identity: the installed
          // runtime and adapter (their hashes), the login kind. No secret.
          key: specKey(['vault', info.vaultId, executable.sha256, adapter.sha256, auth.method ?? 'login', mode, launch.kind, model ?? '']),
          authFingerprint: `vault:${info.vaultId}:${auth.method ?? 'login'}`
        },
        expectedAuth: auth.method === 'api_key' ? 'api_key' : 'account',
        sessionCwd: cwd,
        init: {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { elicitation: { form: {} }, _meta: airClientMeta(['asyncTasks', 'nativeSubagentSessions']) },
          clientInfo: CLIENT_INFO
        },
        session: {
          mcpServers: [],
          meta: {
            claudeCode: {
              emitRawSDKMessages: RAW_SDK_MESSAGE_FILTER.map((filter) => ({ ...filter })),
              options: sealed
                ? {
                    ...(instructions ? { systemPrompt: instructions } : {}),
                    ...(model ? { model } : {}),
                    settingSources: [],
                    strictMcpConfig: true,
                    mcpServers: {},
                    promptSuggestions: false
                  }
                : {
                    systemPrompt: { type: 'preset', preset: 'claude_code' },
                    ...(model ? { model } : {}),
                    settingSources: ['user', 'project', 'local'],
                    promptSuggestions: false
                  }
            }
          }
        },
        setup: {
          modeId: mode,
          ...(model ? { model } : {})
        }
      }
    }
  }
}
