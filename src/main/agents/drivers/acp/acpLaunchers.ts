/**
 * The only engine-specific code left in the turn path: how one agent's ACP
 * process is started, and what has to be said to a session before the first
 * prompt.
 *
 * Everything above this file — the driver, the translator, the permission
 * mapping, the process pool — is one implementation for every local CLI agent.
 * A launcher answers four questions and nothing else:
 *
 * 1. **What is spawned** (`AcpLaunchSpec`: command, args, the whole child
 *    environment, cwd, and a `key` that moves when any of those do).
 * 2. **What the client declares** at `initialize` — which is not the same for
 *    both engines, and the difference is load-bearing: Claude disables its
 *    `AskUserQuestion` tool unless the client advertises `elicitation.form`,
 *    while OpenCode has no question path over ACP at all.
 * 3. **What `session/new` carries** — the `_meta` the Claude adapter reads as
 *    SDK options, and the MCP servers.
 * 4. **What must be set on the session** before the first prompt.
 *
 * ## Why a *refusal* is a launcher's answer too
 *
 * `plan()` returns either a spec or a sentence. The two engines refuse for
 * completely different reasons — OpenCode because a credential is missing or a
 * runtime names no model (`configGenerator`'s skip codes), Claude because there
 * is no `claude` on this machine or it is not logged in — and both refusals
 * have to happen *before* a process is spawned and before the turn lock is
 * taken. Making the refusal part of the plan is what keeps that ordering in one
 * place instead of two pre-flight ladders in the driver.
 *
 * ## What the spike settled, per launcher
 *
 * **OpenCode** (`spike/acp/opencode/`, and the verdicts in the phase 3 plan):
 * a config file selected by `OPENCODE_CONFIG` applies in full — provider entry,
 * agent prompt, permission profile, and credentials named in `provider.<id>.env`
 * and read from the process environment. `session/set_config_option` with
 * `mode` selects the agent definition. **The agent entry's own `model` is
 * ignored over ACP**: selecting a mode never moved the session's model, and an
 * agent pointing at a non-existent model still ran on the session default. So
 * the model is stated twice — as the config's top-level `model` and again on
 * the session — because either one alone is a way for a turn to run on a model
 * the user did not choose.
 *
 * **Claude** (`spike/acp/claude/`): the adapter runs its own bundled CLI unless
 * `CLAUDE_CODE_EXECUTABLE` names the user's, authenticates from that install's
 * login with no API key, and reads `_meta.claudeCode.options` as SDK options —
 * so `settingSources: []`, `strictMcpConfig`, the assembled system prompt and
 * the model alias all travel there. **`permissionMode` in that `_meta` is
 * overridden**: the adapter reads `defaultMode` from the user's own
 * `~/.claude/settings.json` and from the folder's `.claude/settings*.json` even
 * with `settingSources: []`, so a session can start in *any* mode — bypass
 * included. `session/set_mode` after every `new` and `load`, before the first
 * prompt, is the only thing that makes the desktop's approval setting true.
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { InitializeRequest, McpServer, NewSessionRequest } from '@agentclientprotocol/sdk'
import type { CustomAgentConfig } from '../../../../shared/customAgents'
import type { AgentReadiness } from '../../../../shared/agentDrivers'
import type { ClaudeApproval } from '../../../../shared/engine'
import type { LocalAgentKind } from '../../../../shared/localAgents'
import { describeEngineSkip } from '../../../../shared/runtimeMessages'
import type { EngineConfigInput } from '../../../engine/configGenerator'
import { buildEngineConfig, digestEngineConfig } from '../../../engine/configGenerator'
import { createLogger } from '../../../logger/logger'
import type { ReadinessOptions } from '../driver'
import { ACP_PROTOCOL_VERSION, type AcpLaunchSpec, type AcpLauncherId } from './types'
import { airClientMeta } from './acpActivity'

const logger = createLogger('acp-launcher')

/** The folder an ACP turn runs in, as the driver read it a moment ago. */
export interface AcpAgentFolder {
  name: string
  slug: string
  description: string
  path: string
  kind: LocalAgentKind
}

export type AcpLaunchContext = { userId: string; agentId: string; binding?: string; accessToken?: string } & (
  | { folder: AcpAgentFolder; custom?: never }
  | { folder?: never; custom: CustomAgentConfig; accessToken?: string }
)

/** What the session needs said to it once it exists, in the order given. */
export interface AcpSessionSetup {
  /** `session/set_mode`. Claude's approval mode; OpenCode's agent definition would also fit. */
  modeId?: string
  /**
   * `session/set_config_option` calls, in order.
   *
   * `optional` marks one the turn may run without. It exists for exactly one
   * case and is not a general escape hatch: OpenCode's model catalogue is
   * populated asynchronously after start, so a `model` set issued milliseconds
   * after `session/new` can be refused — *"Invalid params: model not found"* —
   * for a model the session has **already** selected from the config's
   * top-level `model` (verified: `session/new` reports it as
   * `configOptions.model.currentValue`). Refusing the turn there would refuse
   * it over a race about something already true.
   */
  configOptions?: { configId: string; value: string; optional?: boolean }[]
}

export interface AcpLaunchPlan {
  spec: AcpLaunchSpec
  init: InitializeRequest
  /** Merged into `session/new` and `session/load` — `_meta`, `mcpServers`. */
  session: {
    mcpServers: McpServer[]
    meta?: Record<string, unknown>
  }
  setup: AcpSessionSetup
}

/** A refusal, in the sentence the user reads instead of a turn. */
export interface AcpLaunchRefusal {
  error: string
}

export type AcpPlanResult = AcpLaunchPlan | AcpLaunchRefusal

export function isRefusal(result: AcpPlanResult): result is AcpLaunchRefusal {
  return 'error' in result
}

export interface AcpLauncher {
  readonly id: AcpLauncherId
  /**
   * The engine ends every turn — the ones it starts on its own included —
   * with a `usage_update` that carries `cost` (`claude-agent-acp` does, at
   * each SDK result). A follow-up turn on such an engine ends only on that
   * marker, a Stop, the process exiting or the ceiling: a model that thinks
   * for a while is not a turn that ended. Absent: a follow-up also ends after
   * a quiet spell (`ACP_FOLLOW_UP_QUIET_MS`).
   */
  readonly endsTurnsWithCostedUsage?: boolean
  /**
   * Everything needed to start this agent, or the reason it cannot run.
   *
   * **Must not throw.** A launcher that cannot decide returns a sentence; the
   * driver renders it as a turn error, which is the only channel a user reads.
   */
  plan(ctx: AcpLaunchContext): Promise<AcpPlanResult>
  /**
   * The engine's own readiness rungs, asked only once the folder itself is
   * `ok`, and cheap enough for a list. Absent when the folder is the whole
   * answer — which is the case for OpenCode, whose binary this app will
   * download if it has to, and whose absence is therefore not a state a user
   * has to fix.
   */
  readiness?(options?: ReadinessOptions): Promise<AgentReadiness>
}

/* ------------------------------------------------------------------ OpenCode */

export interface OpencodeLauncherDeps {
  /**
   * The resolved `opencode` binary. Memoised by the caller: on a machine with
   * no install this downloads the pinned version, and a per-turn download is
   * not something a turn should discover twice.
   */
  binary(): Promise<{ path: string; version: string | null }>
  /** Every credential and folder agent this desktop has, as `configGenerator` wants them. */
  configInput(userId: string): Promise<EngineConfigInput>
  /** Where per-agent configs are written — `<userData>/acp`. */
  configRoot(): string
  /** The child environment before this launcher adds to it (the Child Inherit Set). */
  childEnv(): Promise<Record<string, string>>
}

/**
 * OpenCode over `opencode acp`.
 *
 * The config written here is the *shared server's* config minus the server:
 * `buildEngineConfig` is reused verbatim for the provider and agent entries, so
 * a folder agent's prompt, model and permission profile are byte-for-byte what
 * the HTTP engine loaded, and the credential still travels only as a
 * `CINNA_ENGINE_KEY_…` environment variable named from the config. What changes
 * is the scope: one file per agent, holding one agent, in the app's data
 * directory — never in the user's folder, which Invariant 2 keeps this app out
 * of.
 */
export function createOpencodeLauncher(deps: OpencodeLauncherDeps): AcpLauncher {
  return {
    id: 'opencode',

    async plan(ctx) {
      if (!ctx.folder) return { error: 'This launcher requires a local agent folder.' }
      let binary: { path: string; version: string | null }
      try {
        binary = await deps.binary()
      } catch (err) {
        // `EngineBinaryError`'s messages are already user-facing sentences
        // naming the remedy ("The engine path in Settings does not point at a
        // file"), which is why they are passed through rather than replaced.
        const message = err instanceof Error ? err.message : String(err)
        logger.warn('an OpenCode agent could not be started: no engine binary', {
          agentId: ctx.agentId,
          error: message
        })
        return { error: message }
      }

      const input = await deps.configInput(ctx.userId).catch((err: unknown) => {
        logger.warn('could not read this desktop’s engine config inputs', {
          agentId: ctx.agentId,
          error: err instanceof Error ? err.message : String(err)
        })
        return null
      })
      if (!input) {
        return { error: 'This agent’s credentials and runtime could not be read.' }
      }

      const mine = input.agents.find((agent) => agent.agentId === ctx.agentId)
      if (!mine) {
        // The collector drops an agent whose runtime names another engine, and
        // the driver only reaches this launcher when the folder names this one
        // — so the two disagree, which happens for the length of one save while
        // a manifest is being rewritten.
        return {
          error: 'This agent’s runtime changed while the turn was starting. Try again in a moment.'
        }
      }

      // **One agent per config**, and the providers narrowed to the one it
      // uses. The shared server needed every agent in one file; a process that
      // serves one agent has no reason to be told about the others, and a
      // config that changes whenever an unrelated agent is edited would restart
      // this process for nothing (the spec `key` is a digest of the config).
      const built = buildEngineConfig({
        providers: input.providers.filter((provider) => provider.id === mine.providerId),
        agents: [mine]
      })
      const skipped = built.skippedAgents.find((agent) => agent.agentId === ctx.agentId)
      if (skipped) return { error: describeEngineSkip(skipped.code) }

      const agentKey = built.agentKeys.get(ctx.agentId)
      const model = built.agentModels.get(ctx.agentId)
      if (!agentKey || !model) {
        // Unreachable while `skippedAgents` is the only way out of the builder,
        // and asserted rather than assumed: the alternative is a session that
        // silently runs OpenCode's own `build` agent — a general coding
        // assistant with this folder as its cwd — instead of the user's.
        logger.error('the engine config named no entry for an agent it did not skip', {
          agentId: ctx.agentId
        })
        return { error: 'This agent could not be prepared for the engine.' }
      }
      const modelRef = `${model.providerID}/${model.id}`

      // **The model, stated in the config as well as on the session.** The
      // agent entry's `model` is ignored over ACP (spike Q1), so without a
      // top-level `model` a session starts on whatever the engine picks first
      // — and picks it silently.
      const config = { ...built.config, model: modelRef }
      const dir = join(deps.configRoot(), 'opencode', configDirName(ctx.agentId))
      const configPath = join(dir, 'opencode.json')
      try {
        mkdirSync(dir, { recursive: true })
        // **Written to a temp file and renamed**, as the shared server's own
        // writer did: the engine reads this file at start, and a process that
        // died halfway through a plain write would leave a truncated config for
        // the next turn to spawn an agent on. The rename is atomic within the
        // directory, so a reader sees either the old file or the whole new one.
        const temp = `${configPath}.tmp`
        writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
        renameSync(temp, configPath)
      } catch (err) {
        logger.warn('could not write an ACP agent’s engine config', {
          agentId: ctx.agentId,
          error: err instanceof Error ? err.message : String(err)
        })
        return { error: 'This agent’s engine configuration could not be written.' }
      }

      const digest = digestEngineConfig({ ...built, config })
      const env: Record<string, string> = {
        ...(await deps.childEnv()),
        // **Both variables, for the reason the shared engine's manager used to
        // length.** `OPENCODE_CONFIG` is read only by the v1 loader; the v2
        // loader — the one behind every session's model resolution — builds its
        // document set from the config *directory* plus a walk up from the
        // session's own location, and consults `OPENCODE_CONFIG` nowhere. A
        // folder agent's session is located in the user's folder, which this
        // config is deliberately nowhere near.
        OPENCODE_CONFIG: configPath,
        OPENCODE_CONFIG_DIR: dir,
        // We pin and verify the binary; an engine that replaces itself
        // underneath that pin is what the checksum exists to prevent.
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        ...built.env
      }
      // **Neither `OPENCODE_CLIENT` nor `OPENCODE_ENABLE_QUESTION_TOOL` is
      // set, and that is a decision rather than an omission.** `opencode acp`
      // sets `OPENCODE_CLIENT=acp` itself, and the `question` tool is
      // registered only for `app`/`cli`/`desktop` clients or behind that flag.
      // Turning it on would hand the model a tool whose answer has no channel
      // over ACP: the probe's question hung for 150 s and had to be cancelled,
      // because the adapter bridges no `question.asked` and never calls
      // `elicitation/create` (spike Q3). A model that asks in prose is a
      // degradation; a tool that hangs the turn is a defect.

      return {
        spec: {
          command: binary.path,
          args: ['acp'],
          env,
          cwd: ctx.folder.path,
          key: specKey([
            binary.path,
            binary.version ?? '',
            'acp',
            digest.config,
            digest.env,
            configPath
          ])
        },
        init: {
          protocolVersion: ACP_PROTOCOL_VERSION,
          // No `fs`, no `terminal` — both are removed in the draft v2, and a
          // client that never declared them is forward-compatible. No
          // `elicitation` either: see the question note above.
          clientCapabilities: {},
          clientInfo: CLIENT_INFO
        },
        session: { mcpServers: [] },
        setup: {
          configOptions: [
            // The agent definition first: it carries the prompt and the
            // permission profile, and a session without it runs the engine's
            // stock coding agent in the user's folder — so that one is
            // mandatory.
            { configId: 'mode', value: agentKey },
            // Then the model, which the config's top-level `model` has already
            // selected; this states it again for a session that came back from
            // `session/load` under an older config. Optional for the reason
            // {@link AcpSessionSetup.configOptions} gives.
            { configId: 'model', value: modelRef, optional: true }
          ]
        }
      }
    }
  }
}

/* -------------------------------------------------------------------- Claude */

export interface ClaudeLauncherDeps {
  /** Absolute path of the `claude` this machine has, or null. */
  claudePath(options?: ReadinessOptions): Promise<string | null>
  /** Whether that install is logged in. Only a definite `logged_out` refuses. */
  claudeAuth(options?: ReadinessOptions): Promise<{ state: string }>
  /** Absolute path of the ACP adapter's entry point. Throws when it is not there. */
  adapterEntry(): string
  /** The executable that runs the adapter, and the environment that makes it behave as Node. */
  nodeRuntime(): { command: string; args: string[]; env: Record<string, string> }
  /** `buildClaudeEnv`'s answer: the stripped, allowlisted child environment. */
  claudeEnv(): Promise<Record<string, string>>
  /** The assembled folder prompt — never the SDK's `claude_code` preset. */
  systemPrompt(userId: string, agentId: string): string
  /** The model alias this agent's runtime resolved to, or null for the CLI's default. */
  model(userId: string, agentId: string): string | null
  /** The desktop's approval choice for this agent, with the default already applied. */
  approval(userId: string, agentId: string): ClaudeApproval
  /** The folder's own subagent definitions, which `settingSources: []` would otherwise hide. */
  folderAgents(agentPath: string): Record<string, unknown>
}

/**
 * Claude Code over `@agentclientprotocol/claude-agent-acp`.
 *
 * The same binary, the same login and the same isolation as the in-process SDK
 * runner — moved into its own process, which is the fix for the stdin bug this
 * app carried (`project_claude_sdk_stdin_closes_at_first_result`): a background
 * subagent's permission ask arrived after the parent's reply, was allowed, and
 * completed, with no "Stream closed" anywhere.
 */
export function createClaudeLauncher(deps: ClaudeLauncherDeps): AcpLauncher {
  const readiness = async (options?: ReadinessOptions): Promise<AgentReadiness> => {
    const claudePath = await deps.claudePath(options).catch(() => null)
    if (!claudePath) {
      return { state: 'not_installed', reason: describeEngineSkip('claude_not_installed') }
    }
    // Only a definite `logged_out` is not ready. A probe that could not answer
    // is `unknown`, which never blocks — the same rule the runner applied, for
    // the same reason: refusing a working engine on our own uncertainty is
    // worse than not checking.
    const auth = await deps.claudeAuth(options).catch(() => null)
    if (auth?.state === 'logged_out') {
      return { state: 'not_logged_in', reason: describeEngineSkip('claude_not_logged_in') }
    }
    return { state: 'ok', reason: null }
  }

  return {
    id: 'claude',
    endsTurnsWithCostedUsage: true,
    readiness,

    async plan(ctx) {
      if (!ctx.folder) return { error: 'This launcher requires a local agent folder.' }
      const ready = await readiness()
      if (ready.state !== 'ok') return { error: ready.reason ?? 'This agent cannot run right now.' }
      const claudePath = await deps.claudePath()
      if (!claudePath) return { error: describeEngineSkip('claude_not_installed') }

      let adapter: string
      try {
        adapter = deps.adapterEntry()
      } catch (err) {
        // A packaging fault, not a user's problem — but it has to say something
        // rather than fail as a protocol timeout thirty seconds later.
        logger.error('the Claude ACP adapter is missing from this installation', {
          error: err instanceof Error ? err.message : String(err)
        })
        return { error: 'The Claude adapter is missing from this installation.' }
      }

      const runtime = deps.nodeRuntime()
      const env: Record<string, string> = {
        ...(await deps.claudeEnv()),
        ...runtime.env,
        // **The user's binary, never the adapter's bundled one.** Left unset,
        // the adapter runs a `claude` it ships itself (2.1.257 in the probe,
        // against the user's 2.1.267) — a second Claude Code the user never
        // chose and cannot update. `electron-builder.yml` also refuses to ship
        // that copy; this is the half that makes the refusal safe.
        CLAUDE_CODE_EXECUTABLE: claudePath
      }

      const systemPrompt = safely(() => deps.systemPrompt(ctx.userId, ctx.agentId), '')
      const model = safely(() => deps.model(ctx.userId, ctx.agentId), null)
      const approval = safely(() => deps.approval(ctx.userId, ctx.agentId), 'ask' as ClaudeApproval)
      const agents = safely(() => deps.folderAgents(ctx.folder.path), {})

      return {
        spec: {
          command: runtime.command,
          args: [...runtime.args, adapter],
          env,
          cwd: ctx.folder.path,
          key: specKey([runtime.command, ...runtime.args, adapter, claudePath, envDigest(env)])
        },
        init: {
          protocolVersion: ACP_PROTOCOL_VERSION,
          // **`elicitation.form` is what keeps `AskUserQuestion` alive.**
          // Without it the adapter puts that tool in `disallowedTools`, and the
          // agent silently loses the ability to ask — the one capability the
          // in-process runner never had and this one gains.
          // `_meta.jetbrains.air`: report background work and subagents
          // (`acpActivity.ts`). With native subagent sessions a subagent's
          // frames arrive under its own session id; the driver routes them
          // back to the parent's turn.
          clientCapabilities: { elicitation: { form: {} }, _meta: airClientMeta(['asyncTasks', 'nativeSubagentSessions']) },
          clientInfo: CLIENT_INFO
        },
        session: {
          mcpServers: [],
          meta: {
            claudeCode: {
              options: {
                // The folder already says what this agent is, through
                // `promptAssembly`. The `claude_code` preset is a coding
                // assistant's prompt and would talk over it.
                ...(systemPrompt ? { systemPrompt } : {}),
                ...(model ? { model } : {}),
                // **The desktop's boundary**, and the pair is not optional:
                // `settingSources: []` alone leaves the user's own MCP
                // connectors attached — the probe found `claude.ai Gmail`,
                // Drive and Calendar registered beside ours — and with both,
                // only the injected servers are, and no user settings or
                // plugins load.
                settingSources: [],
                strictMcpConfig: true,
                mcpServers: {},
                // The folder's own subagents, omitted rather than passed empty
                // so a folder without them hands the adapter exactly what it
                // was handed before this option existed.
                ...(Object.keys(agents).length > 0 ? { agents } : {})
              }
            }
          }
        },
        setup: {
          // **After every `new` *and* every `load`.** The adapter reads
          // `defaultMode` from the user's own settings and the folder's, even
          // under `settingSources: []`, so a session can start in any mode —
          // bypass included. `auto` is what a terminal `claude` runs for this
          // user; `default` asks before every mutating call. Never anything
          // else: every other mode takes the permission callback, and with it
          // the desktop's grants and the transcript's record, out of the
          // decision.
          modeId: approval === 'auto' ? 'auto' : 'default'
        }
      }
    }
  }
}

/* -------------------------------------------------------------------- shared */

const CLIENT_INFO = { name: 'cinna-desktop', version: '1' }

/**
 * A directory name for one agent's generated config.
 *
 * An agent id is `folder:<manifest id>`, which is not a path component. Hashed
 * rather than sanitised so two ids that differ only in a character the
 * filesystem folds cannot share a directory and hand one agent the other's
 * prompt — the same reasoning as `engineAgentKey`'s hash suffix.
 */
function configDirName(agentId: string): string {
  return createHash('sha256').update(agentId).digest('hex').slice(0, 16)
}

/**
 * The spec key: everything the running process was started with, as a digest.
 *
 * **Never the values.** The environment carries API keys, so what goes in is a
 * digest of the environment rather than the environment — the pool logs this
 * key, and `types.ts` promises it holds no secret.
 */
function specKey(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)
}

function envDigest(env: Record<string, string>): string {
  const hash = createHash('sha256')
  for (const name of Object.keys(env).sort()) {
    hash.update(name)
    hash.update('\0')
    hash.update(env[name])
    hash.update('\0')
  }
  return hash.digest('hex')
}

/**
 * Read one input, or fall back.
 *
 * Every one of these reads a store that can throw — a folder that moved, a
 * manifest half-written by an assistant — and none of them is worth failing a
 * turn over: an agent with no assembled prompt still answers, and one whose
 * approval could not be read is asked about, which is the safe direction.
 */
function safely<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch (err) {
    logger.warn('an ACP launcher input could not be read; using the fallback', {
      error: err instanceof Error ? err.message : String(err)
    })
    return fallback
  }
}

/** `session/new` params for a plan, so the driver builds them in one place. */
export function newSessionParams(plan: AcpLaunchPlan, cwd: string): NewSessionRequest {
  return {
    cwd,
    mcpServers: plan.session.mcpServers,
    ...(plan.session.meta ? { _meta: plan.session.meta } : {})
  }
}
