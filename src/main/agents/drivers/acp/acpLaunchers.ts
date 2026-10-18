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
 *    and OpenCode bridges its `question` tool to it too.
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
 * so the setting sources, the MCP policy, the system prompt and the model alias
 * all travel there. **`permissionMode` in that `_meta` is overridden**: the
 * adapter reads `defaultMode` from the user's own
 * `~/.claude/settings.json` and from the folder's `.claude/settings*.json` even
 * with `settingSources: []`, so a session can start in *any* mode — bypass
 * included. `session/set_mode` after every `new` and `load`, before the first
 * prompt, is the only thing that makes the desktop's approval setting true.
 *
 * ## A kit folder is isolated; a bare folder is not
 *
 * `ctx.folder.runtimeMode` forks the Claude session options. Nothing here asks
 * what *kind* of folder it is: the answer is derived once, where the folder
 * view is built (`drivers/index.ts`), so that the one folder whose kind lies —
 * Cinna's own build session, a synthetic `bare` view over a synced workspace —
 * cannot pick up a repository's runtime by accident. An **isolated** folder is
 * a harness the desktop scaffolded, so its session stays sealed: `settingSources: []`,
 * `strictMcpConfig: true`, `mcpServers: {}`, the assembled prompt instead of
 * the preset, and the folder's `.claude/agents` shimmed back in by hand because
 * those options hide them. A **native** folder is somebody's own repository,
 * adopted for its instructions file alone, and it gets what a terminal session
 * in it gets: `settingSources: ['user', 'project', 'local']`, no MCP override,
 * no subagent shim, and the `claude_code` preset with the desktop's context
 * appended. The approval mode is the one thing that does not fork — the
 * desktop's choice wins over the folder's `defaultMode` on both branches.
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
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
import {
  ACP_PROTOCOL_VERSION,
  type AcpLaunchSpec,
  type AcpLauncherId,
  type AcpRuntimeMode
} from './types'
import { airClientMeta } from './acpActivity'
import type { AntigravityAutoApprovalPolicy } from './antigravityAutoApproval'
import { RAW_SDK_MESSAGE_FILTER } from './acpSdkTelemetry'
import type { CodexBinaryKnown } from './codexLauncher'
import { ACP_TOOL_STALL_MS } from './acpToolStall'
import { startAcpConnection } from './acpConnection'

const logger = createLogger('acp-launcher')

/** The folder an ACP turn runs in, as the driver read it a moment ago. */
export interface AcpAgentFolder {
  name: string
  slug: string
  description: string
  path: string
  kind: LocalAgentKind
  /**
   * Sealed session or the folder's own, decided by the caller that built this
   * view. A launcher reads this and never the kind: see {@link AcpRuntimeMode}.
   */
  runtimeMode: AcpRuntimeMode
}

export type AcpLaunchContext = {
  userId: string
  agentId: string
  binding?: string
  accessToken?: string
  /**
   * The plan is only compared with a process that is already warm and is
   * never started from (a `warmOnly` AI function). A launcher skips the
   * one-time work a start would need — OpenCode's database bootstrap — so a
   * background check never spawns an engine.
   */
  warmOnly?: boolean
} & (
  | { folder: AcpAgentFolder; custom?: never }
  | { folder?: never; custom: CustomAgentConfig; accessToken?: string }
)

/** What the session needs said to it once it exists, in the order given. */
export interface AcpSessionSetup {
  /** `session/set_mode`. Claude's approval mode; OpenCode's agent definition would also fit. */
  modeId?: string
  /**
   * A model the desktop chose, re-asserted through the session's own `model`
   * config option, resolved against the values the session offered
   * (`resolveOfferedModel`). Applied before `modeId`.
   *
   * Claude's: the adapter picks a session's model as `ANTHROPIC_MODEL`, then
   * the user's own `~/.claude/settings.json` `model` (read even under
   * `settingSources: []`), then a resumed session's model, then its first —
   * and `setModel`s it, so the `model` in `_meta.claudeCode.options` loses to
   * a user's `"model": "opus"` (claude-agent-acp 0.76.0 `session-model.js`
   * `getAvailableModels`). Not a refusal when the session offers no match: the
   * turn runs on the session's own model, and the driver logs it.
   */
  model?: string
  /**
   * The model this setup names (through {@link model} or a `model` config
   * option) is one the **agent declares** (`runtime.model`), not a tier's
   * alias, a chat mode's or a build session's. Only then does a model the
   * session does not offer earn a notice in the chat; the user chose it.
   */
  modelDeclared?: boolean
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
  credentialPrompt?: string
  /** Main-only seal, set after verifying the native runtime's restricted launch. */
  conductorPolicy?: 'no-native-tools'
  /**
   * The engine reads a session's MCP tools once, when the session starts, and
   * ignores `tools/list_changed` (observed on an authenticated Codex
   * 0.154.0-alpha.6.2: a specialist attached mid-chat never became callable).
   * A conductor on such an engine gets a new session, with the transcript
   * replayed, when its tool list changes.
   */
  sessionToolsFixed?: boolean
  /**
   * The engine connects a session's MCP servers only after `session/new` (or
   * `session/load`) has answered, so a first prompt must wait for Cinna's
   * server to have answered the session's `tools/list` — and then `settleMs`
   * more, the time the engine still needs before the model is offered those
   * tools. Set by OpenCode (probed on 2.0.27: a prompt 80 ms after the list
   * ran with no Cinna tool, one 110 ms after it had them). Absent: no wait,
   * the only safe answer for an engine never measured: one that connects
   * lazily, at its first prompt, would otherwise cost every new session the
   * whole bounded wait. See the driver's `awaitCinnaTools`.
   */
  awaitMcpTools?: { settleMs: number }
  spec: AcpLaunchSpec
  init: InitializeRequest
  /** Merged into `session/new` and `session/load` — `_meta`, `mcpServers`. */
  session: {
    mcpServers: McpServer[]
    meta?: Record<string, unknown>
  }
  setup: AcpSessionSetup
  /**
   * Text the driver puts first in the **first `session/prompt` of a new
   * session** — never a loaded or resumed one, whose history (this text
   * included) the engine replays and keeps. For an engine with no
   * system-prompt channel over ACP (Antigravity); an edited prompt therefore
   * applies from the next new session. Such a session is saved for the chat
   * only once the engine has taken that prompt, so a turn that ends before it
   * leaves nothing to load without them.
   */
  firstPromptPreamble?: string
  /**
   * The cwd `session/new` and `session/load` name, when it must not be the
   * folder's: an Antigravity chat runtime runs its sessions in its own empty,
   * desktop-owned process folder (its home is beside it), never in the chat
   * folder. The server lets `view_file` read the cwd and the whole home.
   */
  sessionCwd?: string
  /**
   * Antigravity only, and only for a folder agent on **Ask for approval**: the
   * folder and the pinned skills' folders the driver's permission gate reads
   * to settle an in-folder edit, the agent's own script or a read-only command
   * without asking (`antigravityAutoApproval.ts`). Absent everywhere else, so
   * a chat runtime, an AI function, a conductor or a build session asks.
   */
  autoApprove?: AntigravityAutoApprovalPolicy
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
   * How long a tool call the engine opened with no input may go with no
   * `session/update` at all before the turn is stopped and failed (the stall
   * watch, `acpToolStall.ts`). Absent: no watch — the turn ceiling is the only
   * bound. Set for an engine known to open a call and then fall silent
   * (OpenCode); left off where a running call can legitimately look bare
   * (`claude-agent-acp` never sends `in_progress`) or never does (Codex).
   */
  readonly toolStallMs?: number
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
  /**
   * The login a turn on this engine runs on, for session telemetry — only for
   * an engine that does not say so over ACP (Codex). Kind, label and plan
   * only; never an account or a key. Must not throw.
   */
  telemetryAuth?(): Promise<import('../../../../shared/sessionTelemetry').SessionTelemetryAuth | null>
  /**
   * The sentence for an error from `session/new` or `session/prompt` that
   * means the engine's login is gone, or null for any other error. A launcher
   * that answers also re-reads its login, so readiness changes with it.
   * Must not throw.
   */
  authError?(error: unknown): string | null
  /**
   * The sentence refusing a user prompt this engine must never be sent, or
   * null. Antigravity's `/logout` signs every home on the computer out.
   */
  refusePrompt?(text: string): string | null
}

/* ------------------------------------------------------------------ OpenCode */

export interface OpencodeLauncherDeps {
  /** Trusted companion modes sharing this generated process config (utility calls only). */
  companionAgentIds?(ctx: AcpLaunchContext): string[]
  /**
   * The resolved `opencode` binary. Memoised by the caller: on a machine with
   * no install this downloads the pinned version, and a per-turn download is
   * not something a turn should discover twice.
   */
  binary(): Promise<{ path: string; version: string | null }>
  /** Every credential and folder agent this desktop has, as `configGenerator` wants them. */
  configInput(userId: string): Promise<EngineConfigInput>
  /** Where per-agent configs, and Cinna's own OpenCode database, are written — `<userData>/acp`. */
  configRoot(): string
  /** The child environment before this launcher adds to it (the Child Inherit Set). */
  childEnv(): Promise<Record<string, string>>
  /**
   * Creates a missing `OPENCODE_DB`: one engine started with `spec` until it
   * has answered `init`, then stopped. Defaults to {@link bootstrapOpencodeAcp};
   * a test seam. See {@link ensureOpencodeDatabase} for why it exists.
   */
  bootstrapDatabase?(spec: AcpLaunchSpec, init: InitializeRequest): Promise<void>
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
    // Pinned OpenCode opened a `write` with `{}` and never said another word.
    toolStallMs: ACP_TOOL_STALL_MS,

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

      // Keep only this runtime and explicitly trusted companion modes, with
      // its provider. Unrelated agent edits must not restart the process. A
      // synthetic chat may include a no-tools utility mode so a fresh title
      // session can reuse the same warm process without its chat instructions.
      const companionIds = deps.companionAgentIds?.(ctx) ?? []
      const built = buildEngineConfig({
        // The bundled `cinna-tasks` folder; the agent's own `skills/` travels
        // on its entry (`EngineAgentInput.skillPaths`).
        ...(input.skillPaths?.length ? { skillPaths: input.skillPaths } : {}),
        providers: input.providers.filter((provider) => provider.id === mine.providerId),
        agents: [mine, ...input.agents.filter((agent) =>
          agent.agentId !== mine.agentId && companionIds.includes(agent.agentId) && agent.providerId === mine.providerId)]
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
      //
      // **The user's own Claude and agent skills stay out.** OpenCode's
      // built-in `opencode.config.compatibility` plugin reads
      // `~/.claude/skills` and `~/.agents/skills` (and a project's `.claude` /
      // `.agents` skills) into every session; the `-` entry turns that plugin
      // off. Probed on 2.0.27: both personal folders gone, the kit's skill
      // (`skills.paths`) still listed, no warning. The project folders go too,
      // which is accepted. 2.x has no narrower switch, and `OPENCODE_TEST_HOME`
      // would also move `~/…` for read/edit and the shell, and the cloud
      // credential lookups.
      const config = { ...built.config, model: modelRef, plugins: [OPENCODE_NO_COMPATIBILITY_PLUGIN] }
      const dir = join(deps.configRoot(), 'opencode', configDirName(ctx.agentId))
      const configPath = join(dir, 'opencode.json')
      const database = opencodeDatabasePath(deps.configRoot())
      try {
        mkdirSync(dir, { recursive: true })
        // Before spawn, always: 2.x given an `OPENCODE_DB` whose directory is
        // missing dies without a word, and the client then waits for ever.
        mkdirSync(dirname(database), { recursive: true })
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
        // **Cinna's sessions in Cinna's own database**, not the user's shared
        // `~/.local/share/opencode/opencode.db`, which 2.x would otherwise
        // migrate and write in place. A chat whose session id lives in that
        // shared database misses on `session/load` and starts a fresh engine
        // session (its transcript stays). Only the database moves: logs and
        // shell output captures still go to XDG data, which is accepted —
        // `XDG_DATA_HOME` would leak into every shell command the agent runs.
        OPENCODE_DB: database,
        ...built.env
      }
      // **Questions: `elicitation.form` is declared.** OpenCode always
      // registers its `question` tool and bridges it to `elicitation/create`
      // for a client that declares form elicitation (probed on 2.0.27; the
      // form is mapped in `acpQuestions.ts`), as Claude's and Codex's adapters do.
      const init: InitializeRequest = {
        protocolVersion: ACP_PROTOCOL_VERSION,
        // No `fs`, no `terminal` — both are removed in the draft v2, and a
        // client that never declared them is forward-compatible. Form
        // elicitation: see the question note above.
        clientCapabilities: { elicitation: { form: {} } },
        clientInfo: CLIENT_INFO
      }
      const spec: AcpLaunchSpec = {
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
          configPath,
          database,
          // The inherited PATH decides which `git` the engine runs — the
          // developer-tool shims come and go with Apple's command line tools.
          env.PATH ?? ''
        ]),
        // See {@link OPENCODE_EARLY_EXIT_RETRY}; the bootstrap below inherits it.
        earlyExitRetry: OPENCODE_EARLY_EXIT_RETRY
      }

      // **A missing database is created by one engine first** — see
      // {@link ensureOpencodeDatabase}. A failed bootstrap is logged and the
      // plan still returned, so the turn's own spawn reports whatever went
      // wrong in the words every other launch failure uses. A warm-only plan
      // starts nothing, so it creates nothing either.
      if (!ctx.warmOnly) {
        await ensureOpencodeDatabase(database, () =>
          (deps.bootstrapDatabase ?? bootstrapOpencodeAcp)({ ...spec, cwd: dirname(database) }, init)
        ).catch((err: unknown) => {
          logger.warn('could not create Cinna’s OpenCode database before the first start', {
            agentId: ctx.agentId,
            error: err instanceof Error ? err.message : String(err)
          })
        })
      }

      return {
        spec,
        init,
        session: { mcpServers: [] },
        awaitMcpTools: { settleMs: OPENCODE_MCP_SETTLE_MS },
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

/** {@link AcpLaunchPlan.awaitMcpTools} `settleMs` for OpenCode: the ~100 ms measured, with margin. */
export const OPENCODE_MCP_SETTLE_MS = 300

/**
 * **A start that dies on `database is locked` is started again.** Concurrent
 * OpenCode 2.0.27 processes on the shared `OPENCODE_DB` lose about one start
 * in twenty at open — `SQLiteError: database is locked`, then *"Standalone
 * server exited before reporting readiness"* — even with
 * {@link ensureOpencodeDatabase} and with starts serialised (likely: 2.x sets
 * WAL before its busy_timeout). A respawn a few hundred milliseconds later
 * opens cleanly (`opencode.launch.database-first-start`). Three spawns in all.
 *
 * **Matched on the readiness line, not the SQLite error.** The lock reaches
 * only the engine's `log/opencode.log`; stderr carries the readiness line and
 * a stack, nothing more (4/4 lost starts captured). So any server that dies
 * before readiness is retried, a non-transient one too — two extra spawns,
 * inside the one start timeout, before the same error surfaces.
 */
export const OPENCODE_EARLY_EXIT_RETRY = {
  stderr: /Standalone server exited before reporting readiness/,
  attempts: 3
} as const

/** The `plugins` entry that turns off OpenCode's Claude/agents-folder compatibility plugin. */
export const OPENCODE_NO_COMPATIBILITY_PLUGIN = '-opencode.config.compatibility'

/**
 * In-flight and finished creations of a missing `OPENCODE_DB`, by path. A
 * failed one is removed, so the next start tries again.
 */
const opencodeBootstraps = new Map<string, Promise<void>>()

/**
 * **One engine creates a missing database; the others wait for it.** OpenCode
 * 2.0.27 bootstraps its schema with a check outside its transaction followed by
 * plain `CREATE TABLE`s, so several `opencode acp` started together on a
 * database that does not exist yet race: the losers' server dies on
 * `database is locked` or `table … already exists`, and `acp` exits with
 * *"Standalone server exited before reporting readiness"* (probed: 2 of 3
 * concurrent starts died in most trials). Every user upgrading to Cinna's own
 * database starts on an empty one, so the first autorun or delegation burst
 * would lose turns at spawn (`opencode.launch.database-first-start`).
 *
 * Answering `initialize` is enough: `acp` awaits its standalone server's
 * readiness — the database opened and migrated — before it reads a request
 * (the losers fail inside that wait), and every table was there at the answer
 * (probed: 42 of 42 concurrent starts reached `session/new` after an
 * initialize-only bootstrap). No session is created for it.
 *
 * **Not the whole story.** Concurrent starts on an existing database still
 * lose a process now and then on `database is locked` in the contract's
 * rounds — with this bootstrap, and also with every start serialised until the
 * one before had answered `initialize` — so a start that overlaps another
 * OpenCode process's database work can die at open on 2.0.27 regardless.
 * {@link OPENCODE_EARLY_EXIT_RETRY} starts such a process again.
 *
 * A finished creation is remembered for the process's life, so an engine that
 * never writes a database (the E2E fakes) is not bootstrapped on every turn.
 */
export async function ensureOpencodeDatabase(database: string, create: () => Promise<void>): Promise<void> {
  const pending = opencodeBootstraps.get(database)
  if (pending) return pending
  if (existsSync(database)) return
  const created = create()
  opencodeBootstraps.set(database, created)
  created.catch(() => {
    if (opencodeBootstraps.get(database) === created) opencodeBootstraps.delete(database)
  })
  return created
}

/**
 * The bootstrap's own start timeout, shorter than the turn's
 * (`ACP_START_TIMEOUT_MS`): a turn waits for the bootstrap and then for its
 * own start, so a hung bootstrap would otherwise double the wait before the
 * turn's error. {@link OPENCODE_EARLY_EXIT_RETRY}'s respawns share it. A
 * bootstrap that runs out is logged and the turn starts anyway.
 */
export const OPENCODE_BOOTSTRAP_START_TIMEOUT_MS = 10_000

/**
 * Bootstraps in flight, by the controller that stops them. They run outside
 * `acpProcessPool`, so app shutdown stops them here
 * ({@link shutdownOpencodeBootstraps}).
 */
const bootstrapsInFlight = new Map<AbortController, Promise<void>>()
/** Set at shutdown: a plan made after it starts no bootstrap engine. */
let bootstrapsClosed = false

/**
 * The default {@link OpencodeLauncherDeps.bootstrapDatabase}: start the engine,
 * complete `initialize`, stop it. `startAcpConnection` bounds the wait
 * ({@link OPENCODE_BOOTSTRAP_START_TIMEOUT_MS}) and kills the process tree on
 * every path, an abort from {@link shutdownOpencodeBootstraps} included.
 */
export async function bootstrapOpencodeAcp(spec: AcpLaunchSpec, init: InitializeRequest): Promise<void> {
  if (bootstrapsClosed) throw new Error('The app is closing; Cinna’s OpenCode database was not created.')
  const abort = new AbortController()
  const run = (async () => {
    const connection = await startAcpConnection(spec, init, {
      startTimeoutMs: OPENCODE_BOOTSTRAP_START_TIMEOUT_MS,
      signal: abort.signal
    })
    await connection.dispose()
  })()
  bootstrapsInFlight.set(abort, run.catch(() => undefined))
  try {
    await run
  } finally {
    bootstrapsInFlight.delete(abort)
  }
}

/**
 * App shutdown: stop every database bootstrap still starting, and refuse new
 * ones. The abort reaches the engine's start synchronously, so its process
 * tree is signalled before the first await, as `shutdownHubCore` requires;
 * the promise settles once each is gone.
 */
export function shutdownOpencodeBootstraps(): Promise<void> {
  bootstrapsClosed = true
  const pending = [...bootstrapsInFlight.entries()]
  for (const [abort] of pending) abort.abort()
  return Promise.all(pending.map(([, settled]) => settled)).then(() => undefined)
}

/**
 * `OPENCODE_DB` for every Cinna OpenCode process: one database beside the
 * per-agent configs, `<configRoot>/opencode-data/opencode.db`. Shared by the
 * agents as the user's own database is shared by theirs.
 */
export function opencodeDatabasePath(configRoot: string): string {
  return join(configRoot, 'opencode-data', 'opencode.db')
}

/* -------------------------------------------------------------------- Claude */

/**
 * Only ever a **failed install**, for the reason `CODEX_NOT_INSTALLED` gives:
 * Cinna verifies its own pinned Claude Code, so the CLI is here, on its way (the
 * turn waits for it), or could not be fetched — and only the last one refuses.
 */
export const CLAUDE_NOT_INSTALLED = 'Claude Code could not be installed. Try again in Settings → Agents → Runtime.'

export interface ClaudeLauncherDeps {
  /**
   * The binary this session runs on: the explicit path from Settings
   * (unpinned), else the pinned Claude Code — the user's own install when it
   * reports exactly the pinned version, otherwise Cinna's managed copy,
   * **downloaded and verified if this machine has none**. A failure is returned
   * as its user-facing sentence rather than thrown.
   */
  binary(): Promise<{ path: string } | { error: string }>
  /** Free, and never starts a download. `fresh` retries a failed install. */
  binaryKnown(options?: ReadinessOptions): Promise<CodexBinaryKnown>
  /** Whether that install is logged in. Only a definite `logged_out` refuses. */
  claudeAuth(options?: ReadinessOptions): Promise<{ state: string }>
  /** Absolute path of the ACP adapter's entry point. Throws when it is not there. */
  adapterEntry(): string
  /** The executable that runs the adapter, and the environment that makes it behave as Node. */
  nodeRuntime(): { command: string; args: string[]; env: Record<string, string> }
  /** `buildClaudeEnv`'s answer: the stripped, allowlisted child environment. */
  claudeEnv(): Promise<Record<string, string>>
  /**
   * The system prompt for this turn, chosen by the folder's runtime mode: an
   * **isolated** folder's whole assembled document, which replaces the SDK's
   * `claude_code` preset, or a **native** folder's desktop context, which is
   * appended to it. Read on every plan, so an edited folder takes effect on the
   * next turn.
   */
  systemPrompt(userId: string, agentId: string, mode: AcpRuntimeMode): string
  /** The model alias this agent's runtime resolved to, or null for the CLI's default. */
  model(userId: string, agentId: string): string | null
  /**
   * Whether {@link model} is only the desktop's floor (no model or tier named
   * for the agent). A native folder then keeps the model its user's own Claude
   * settings name; absent means "chosen".
   */
  modelIsFloor?(userId: string, agentId: string): boolean
  /**
   * The reasoning effort the agent declares beside its model (`runtime.effort`),
   * or null for the CLI's own. Set through the session's `effort` config option,
   * optional: a value the session does not offer is logged and the turn runs.
   */
  effort?(userId: string, agentId: string): string | null
  /** Whether {@link model} is the agent's own `runtime.model` (see `AcpSessionSetup.modelDeclared`). */
  modelDeclared?(userId: string, agentId: string): boolean
  /** The desktop's approval choice for this agent, with the default already applied. */
  approval(userId: string, agentId: string): ClaudeApproval
  /**
   * The folder's own subagent definitions, which `settingSources: []` would
   * otherwise hide. Isolated sessions only — a native one loads them from
   * settings, and this is not called for it.
   */
  folderAgents(agentPath: string): Record<string, unknown>
  /**
   * The desktop-owned local plugin that carries the `cinna-tasks` skill
   * (`tasksSkillService.ensureTasksSkillPlugin`), or null when this build has
   * no skill. Passed as `plugins` on **both** branches: a desktop plugin is
   * not a user or project setting, so `settingSources: []` does not hide it
   * (`claude.session.options-plugins` in the contract).
   */
  tasksSkillPlugin?(): string | null
  /**
   * The desktop-owned plugin carrying `cinna-artifacts`
   * (`artifactsSkill.ensureArtifactsSkillPlugin`), or null while the active
   * profile's instance keeps no artifacts — an agent never reads about a tool
   * it is not offered. Read per session, beside `cinna-tasks`.
   */
  artifactsSkillPlugin?(): string | null
  /**
   * The local plugin carrying a **kit** agent's own skills
   * (`agentSkillsPlugin.ensureAgentSkillsPlugin`), or null when this session
   * is not a kit agent's or the agent has no deliverable skill. Asked on the
   * isolated branch only: a native folder loads its own skills from its
   * settings. The answer for a conductor, an AI function, a synthetic chat or
   * a build session is null — the dep decides that, since every one of them
   * is an isolated folder too.
   */
  agentSkillsPlugin?(userId: string, agentId: string): string | null
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
    const known = await deps.binaryKnown(options).catch((): CodexBinaryKnown => ({ state: 'pending' }))
    // Only a *failed* install refuses. `pending` stays `ok` on purpose: a send
    // joins the install at the top of its turn, and refusing while the CLI was
    // merely on its way would block the one action that fetches it.
    if (known.state === 'failed') {
      return { state: 'not_installed', reason: CLAUDE_NOT_INSTALLED, detail: known.error }
    }
    // Only a definite `logged_out` is not ready. A probe that could not answer
    // is `unknown`, which never blocks — the same rule the runner applied, for
    // the same reason: refusing a working engine on our own uncertainty is
    // worse than not checking.
    const auth = await deps.claudeAuth(options).catch(() => null)
    if (auth?.state === 'logged_out') {
      return { state: 'not_logged_in', reason: describeEngineSkip('claude_not_logged_in'), login: 'claude' }
    }
    return { state: 'ok', reason: null }
  }

  return {
    id: 'claude',
    endsTurnsWithCostedUsage: true,
    readiness,

    async plan(ctx) {
      if (!ctx.folder) return { error: 'This launcher requires a local agent folder.' }
      // The binary first — this is the step that may download — and the login
      // after it, because the login is asked *of that binary*. A failure here is
      // not remembered: the next turn simply tries again.
      const binary = await deps.binary().catch((): { error: string } => ({ error: CLAUDE_NOT_INSTALLED }))
      if ('error' in binary) return { error: binary.error }
      const claudePath = binary.path
      const auth = await deps.claudeAuth().catch(() => null)
      if (auth?.state === 'logged_out') return { error: describeEngineSkip('claude_not_logged_in') }

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
        // **The pinned binary, never the adapter's bundled one.** Left unset,
        // the adapter runs a `claude` it ships itself (2.1.257 in the probe) —
        // an accidental, invisible second Claude Code at a version nobody
        // checked. `electron-builder.yml` also refuses to ship that copy; this
        // is the half that makes the refusal safe. The login is unaffected by
        // which file this is: it follows HOME, not the binary.
        CLAUDE_CODE_EXECUTABLE: claudePath
      }

      // **The fork**, on the mode the caller derived rather than on what kind
      // of folder this is. An isolated session is a harness the desktop built,
      // so it stays sealed; a native one runs on what a terminal `claude` in
      // that folder runs on.
      const native = ctx.folder.runtimeMode === 'native'
      const systemPrompt = safely(
        () => deps.systemPrompt(ctx.userId, ctx.agentId, ctx.folder.runtimeMode),
        ''
      )
      const model = safely(() => deps.model(ctx.userId, ctx.agentId), null)
      const effort = model ? safely(() => deps.effort?.(ctx.userId, ctx.agentId) ?? null, null) : null
      const approval = safely(() => deps.approval(ctx.userId, ctx.agentId), 'ask' as ClaudeApproval)
      // Not even asked on the native branch: the folder's `.claude/agents` load
      // from the settings that branch keeps enabled, and passing them as well
      // would hand the adapter every definition twice.
      const agents = native ? {} : safely(() => deps.folderAgents(ctx.folder.path), {})
      // Default `argv` delivery (one `--plugin-dir`), the delivery the
      // contract checks; `pluginDelivery: 'initialize'` (SDK 0.3.261+, the
      // adapter runs 0.3.293 under 0.89.1) is not used.
      const pluginPath = safely(() => deps.tasksSkillPlugin?.() ?? null, null)
      // The agent's own skills, beside cinna-tasks in the same array (two
      // local plugins load together, proven on 2.1.276 / adapter 0.76.0).
      const agentSkillsPath = native ? null : safely(() => deps.agentSkillsPlugin?.(ctx.userId, ctx.agentId) ?? null, null)
      const artifactsPluginPath = safely(() => deps.artifactsSkillPlugin?.() ?? null, null)
      const pluginPaths = [pluginPath, artifactsPluginPath, agentSkillsPath].filter((path): path is string => !!path)
      const plugins = pluginPaths.length > 0
        ? { plugins: pluginPaths.map((path) => ({ type: 'local' as const, path })) }
        : {}

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
              // Claude's raw SDK stream, for session telemetry only
              // (`acpSdkTelemetry.ts`): the resolved model from turn 0, the
              // cache TTL, per-model cost and context window.
              emitRawSDKMessages: RAW_SDK_MESSAGE_FILTER.map((filter) => ({ ...filter })),
              options: native
                ? {
                    // **The folder's own runtime.** `settingSources` names the
                    // three scopes a terminal session loads, which is what
                    // brings the folder's `CLAUDE.md`, its hooks, its skills,
                    // its plugins, its `.claude/agents` and its `.mcp.json`
                    // into the session — the memory file, the hooks, the
                    // subagents and the MCP server all watched on the wire
                    // against claude 2.1.274 and adapter 0.76.0. No
                    // `strictMcpConfig` and no `mcpServers` override, because
                    // either one would take the folder's MCP servers back out
                    // again.
                    systemPrompt: {
                      // The preset is a coding assistant's prompt, and for a
                      // repository that is the right one; the desktop appends
                      // only what the folder cannot know about this turn.
                      type: 'preset',
                      preset: 'claude_code',
                      ...(systemPrompt ? { append: systemPrompt } : {})
                    },
                    ...(model ? { model } : {}),
                    settingSources: ['user', 'project', 'local'],
                    ...plugins
                  }
                : {
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
                    ...(Object.keys(agents).length > 0 ? { agents } : {}),
                    // Desktop-owned, so not "user plugins" the pair above
                    // shuts out: cinna-tasks and the agent's own skills.
                    ...plugins
                  }
            }
          }
        },
        setup: {
          // **After every `new` *and* every `load`, on both branches.** The
          // adapter reads `defaultMode` from the user's own settings and the
          // folder's, even under `settingSources: []`, so a session can start
          // in any mode — bypass included. `auto` is what a terminal `claude`
          // runs for this user; `default` asks before every mutating call.
          // Never anything else: every other mode takes the permission
          // callback, and with it the desktop's grants and the transcript's
          // record, out of the decision.
          //
          // `session/set_mode` is not belt-and-braces, it is the whole
          // mechanism: `_meta.claudeCode.options.permissionMode` was watched
          // being **ignored** (sent `default`, the session came up
          // `acceptEdits` from the project's `settings.local.json`), so
          // "simplifying" this into the `session/new` options would silently
          // hand a bare folder its own permission mode.
          modeId: approval === 'auto' ? 'auto' : 'default',
          // **After every `new` and `load`, on both branches, when the desktop
          // chose a model.** The `model` in the options above loses to the
          // user's own `~/.claude/settings.json` `model`, which the adapter
          // reads under any `settingSources` and `setModel`s over ours: an
          // agent set to Haiku ran on `claude-opus-5[1m]` because the user's
          // settings say `"opus"`. Not `ANTHROPIC_MODEL`, which would win too
          // but is part of the process's environment, and so of the spec key:
          // one warm adapter per model instead of per agent.
          // A native folder runs on its user's own settings, so there only a
          // model the agent names (declared, or by tier) is re-asserted, never
          // the desktop's floor; a sealed session never reads them by design.
          ...(model && !(native && safely(() => deps.modelIsFloor?.(ctx.userId, ctx.agentId) ?? false, false)) ? { model } : {}),
          ...(model && safely(() => deps.modelDeclared?.(ctx.userId, ctx.agentId) ?? false, false) ? { modelDeclared: true } : {}),
          // The effort the agent declares beside its model, after the model so
          // it is asked of the model the turn runs on. Optional: an effort the
          // session does not offer is logged, never a refused turn.
          ...(effort ? { configOptions: [{ configId: 'effort', value: effort, optional: true }] } : {})
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
