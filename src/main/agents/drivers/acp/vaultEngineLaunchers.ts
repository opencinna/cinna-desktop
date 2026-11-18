/**
 * Codex and OpenCode in an Agent Vault. Like Claude's vault launcher
 * (`vaultLauncher.ts`): the engine runs inside the guest, started by
 * cinna-vaultd, which builds its command and writes its config from the
 * vault's own `cinna.launch` / `cinna.instructions` (D34; vaultd
 * `engineConfig.ts`). What a plan adds here is only the ACP side — the
 * client capabilities the host launcher declares and the session setup —
 * and it too reads the vault's settings, never the host row.
 *
 * Against the host launchers (`codexLauncher.ts`, `acpLaunchers.ts`
 * OpenCode): no MCP servers (no loopback `cinna`, D6), no host plugins or
 * skills, no host config or login; the vault's API key is the login.
 *
 * Antigravity starts in a vault (probed on a real guest: the pinned server
 * answers `initialize`, and `session/new` asks for a login) and signs in with
 * the vault's Gemini API key; its Google sign-in cannot be completed there yet.
 */
import { antigravityModelForComplexity, codexEffortForRuntime } from '../../../../shared/engine'
import { airClientMeta } from './acpActivity'
import { ANTIGRAVITY_ISOLATED_DISABLED_TOOLS, antigravityPreamble } from './antigravityLauncher'
import type { AcpLauncher, AcpPlanResult } from './acpLaunchers'
import { ACP_TOOL_STALL_MS } from './acpToolStall'
import { opencodeClientMeta } from './opencodeChildren'
import { ACP_PROTOCOL_VERSION, VAULT_AGENT_CWD } from './types'
import { readVaultLaunchFacts, specKey, VAULT_ANTIGRAVITY_SIGNED_OUT, type VaultLauncherDeps } from './vaultLauncher'

const CLIENT_INFO = { name: 'cinna-desktop', version: '1' }

/** The agent entry vaultd's OpenCode config defines (vaultd `engineConfig.ts` `OPENCODE_VAULT_AGENT`). */
export const VAULT_OPENCODE_AGENT = 'cinna'

/** Codex in a vault: the pinned `codex` behind the pinned `codex-acp`, both installed inside. */
export function createVaultCodexLauncher(deps: VaultLauncherDeps): AcpLauncher {
  return {
    id: 'codex',
    async plan(ctx): Promise<AcpPlanResult> {
      const facts = await readVaultLaunchFacts(deps, ctx, 'codex')
      if ('error' in facts) return facts
      const { info, auth, launch, runtime } = facts
      const cwd = deps.agentCwd?.(info.vaultId) ?? VAULT_AGENT_CWD
      // The host launcher's mapping (codexLauncher.ts); vaultd opens the session in it too (INITIAL_AGENT_MODE).
      const modeId = launch.approval === 'auto' ? 'agent' : 'workspace-write'
      return {
        spec: {
          vault: { agentId: ctx.agentId, vaultId: info.vaultId, engine: 'codex', extraEnv: {} },
          command: '',
          args: [],
          env: {},
          cwd,
          // By identity, never a secret: the installed runtime and adapter, the login kind and the vault's settings.
          key: specKey(['vault', info.vaultId, 'codex', runtime.executable.sha256, runtime.adapter?.sha256 ?? '', auth.method ?? 'login', modeId, launch.kind, launch.model ?? '', facts.instructions ?? '']),
          authFingerprint: `vault:${info.vaultId}:${auth.method ?? 'login'}`
        },
        sessionCwd: cwd,
        init: {
          protocolVersion: ACP_PROTOCOL_VERSION,
          // As on the host: background terminals only (see codexLauncher.ts).
          clientCapabilities: { elicitation: { form: {} }, _meta: airClientMeta(['asyncTasks']) },
          clientInfo: CLIENT_INFO
        },
        session: { mcpServers: [] },
        sessionToolsFixed: true,
        // The model is vaultd's (`CODEX_CONFIG` from `cinna.launch`); the effort is set per
        // session as the host's tier mapping resolves it (`codexEffortForRuntime`: the effort
        // beside a model, else the complexity's, else medium). Optional, as Claude's.
        setup: { modeId, configOptions: [{ configId: 'reasoning_effort', value: codexEffortForRuntime(launch), optional: true }] }
      }
    }
  }
}

/** OpenCode in a vault: the pinned `opencode acp`, on the model and provider key the vault holds. */
export function createVaultOpencodeLauncher(deps: VaultLauncherDeps): AcpLauncher {
  return {
    id: 'opencode',
    toolStallMs: ACP_TOOL_STALL_MS,
    async plan(ctx): Promise<AcpPlanResult> {
      const facts = await readVaultLaunchFacts(deps, ctx, 'opencode')
      if ('error' in facts) return facts
      const { info, auth, launch, runtime } = facts
      if (!launch.model) return { error: 'This agent names no model for OpenCode inside its vault.' }
      const cwd = deps.agentCwd?.(info.vaultId) ?? VAULT_AGENT_CWD
      const modelRef = `${launch.provider}/${launch.model}`
      return {
        spec: {
          vault: { agentId: ctx.agentId, vaultId: info.vaultId, engine: 'opencode', extraEnv: {} },
          command: '',
          args: [],
          env: {},
          cwd,
          key: specKey(['vault', info.vaultId, 'opencode', runtime.executable.sha256, auth.method ?? 'login', launch.approval, launch.kind, modelRef, facts.instructions ?? '']),
          authFingerprint: `vault:${info.vaultId}:${auth.method ?? 'login'}`
        },
        sessionCwd: cwd,
        init: {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { elicitation: { form: {} }, _meta: opencodeClientMeta() },
          clientInfo: CLIENT_INFO
        },
        session: { mcpServers: [] },
        sessionToolsFixed: true,
        setup: {
          configOptions: [
            // The vault's agent entry: its prompt and permission profile. Mandatory,
            // as on the host — without it the session runs OpenCode's stock agent.
            { configId: 'mode', value: VAULT_OPENCODE_AGENT },
            { configId: 'model', value: modelRef, optional: true }
          ]
        }
      }
    }
  }
}

/** Antigravity's ACP login method that reads `GEMINI_API_KEY` from its environment. */
export const VAULT_ANTIGRAVITY_AUTH_METHOD = 'gemini-api-key'

/**
 * Antigravity in a vault: the pinned server on the vault's Gemini API key
 * (`authenticate {methodId: 'gemini-api-key'}` right after initialize). As on
 * the host: no client capabilities, its subagent and schedule tools off (an
 * isolated home), the prompt as a preamble to the first message, and the mode
 * and model set after new and load — all from the vault's own settings.
 */
export function createVaultAntigravityLauncher(deps: VaultLauncherDeps): AcpLauncher {
  return {
    id: 'antigravity',
    async plan(ctx): Promise<AcpPlanResult> {
      const facts = await readVaultLaunchFacts(deps, ctx, 'antigravity')
      if ('error' in facts) return facts
      const { info, auth, launch, runtime, instructions } = facts
      // Only the key method is offered inside; anything else is Google's sign-in.
      if (auth.method !== 'api_key') return { error: VAULT_ANTIGRAVITY_SIGNED_OUT }
      const cwd = deps.agentCwd?.(info.vaultId) ?? VAULT_AGENT_CWD
      // The vault's model, else its complexity's Flash level (the host's mapping); none: the server's default.
      const model = launch.model ?? antigravityModelForComplexity(launch.complexity)
      return {
        spec: {
          vault: { agentId: ctx.agentId, vaultId: info.vaultId, engine: 'antigravity', extraEnv: {}, authMethod: VAULT_ANTIGRAVITY_AUTH_METHOD },
          command: '',
          args: [],
          env: {},
          cwd,
          // Mode, model and prompt are per session: one warm server serves every chat.
          key: specKey(['vault', info.vaultId, 'antigravity', runtime.executable.sha256, auth.method]),
          authFingerprint: `vault:${info.vaultId}:${auth.method}`
        },
        sessionCwd: cwd,
        init: { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: CLIENT_INFO },
        session: { mcpServers: [], meta: { agy: { disabledTools: [...ANTIGRAVITY_ISOLATED_DISABLED_TOOLS] } } },
        ...(instructions ? { firstPromptPreamble: antigravityPreamble(instructions) } : {}),
        setup: {
          modeId: launch.approval === 'auto' ? 'yolo' : 'default',
          ...(model ? { configOptions: [{ configId: 'model', value: model, optional: true }] } : {})
        }
      }
    }
  }
}
