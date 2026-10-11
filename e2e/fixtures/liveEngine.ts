import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { LocalAgentRuntimeInput } from '../../src/shared/engine'
import { RUNTIME_PINS } from '../../src/shared/runtimePins'
import { expect, test, type CinnaApp, type CinnaOptions } from './app'
import { LIVE_REQUESTED, OPENAI_API_KEY, requireLiveKey, seedOpenAiDefaultMode } from './live'
import { NO_AGENT_TURN } from './mainLog'
import type { RealLogin } from './realLogin'

/**
 * **Which engine the billed live task specs run on**: `CINNA_E2E_LIVE_ENGINE`,
 * `opencode` (the default), `claude` or `codex`.
 *
 * - `opencode` — unchanged: the cached pinned OpenCode (`engine: true`) on the
 *   OpenAI key in `.env` (`requireLiveKey`, `seedOpenAiDefaultMode`).
 * - `claude` / `codex` — the developer's own login, through the real-`HOME`
 *   exception in `realLogin.ts` (throwaway userData, a throwaway
 *   `~/.cinna-e2e-<engine>-*` folder for every agent, the engine's session
 *   records removed afterwards). Each folder agent a spec arranges is given a
 *   runtime block naming the engine and a cheap model (`useLiveRuntime`), so
 *   neither the Sonnet floor nor `~/.codex/config.toml`'s model is spent.
 *   The OpenAI key is still seeded as the default chat mode when `.env` has
 *   one (nothing on these engines spends it); it is not required.
 *
 * Binaries (never downloaded — every launch has `CINNA_*_DOWNLOAD=off`):
 * - Claude: `CINNA_E2E_CLAUDE_PATH`, else `~/.local/bin/claude` resolved to its
 *   real path (the developer's own install, whatever its version), else the
 *   installed app's pinned `runtimes/claude-<pin>/claude`.
 * - Codex: `CINNA_E2E_CODEX_PATH`, else the installed app's
 *   `runtimes/codex-<pin>/codex`, else the verified runtime cache
 *   `~/.cache/cinna-runtimes/codex-<pin>/codex` (`make contract ENGINE=codex`).
 *
 * A missing binary or a logged-out CLI is a skip with the reason, found with
 * the free status commands (`claude auth status`, `codex login status`).
 *
 * Models (`CINNA_E2E_LIVE_MODEL` overrides either):
 * - Claude: the **Medium** tier (`sonnet`), not `haiku`. On `haiku` the CLI has
 *   no auto-mode reviewer and runs *Ask every time* instead of Automatic
 *   (`claude_engine.md`, "Approval fallback"; on some CLIs `set_mode auto`
 *   fails the turn outright), so every write in an unattended task would wait
 *   on an ask nobody answers. An override names a model alias (`haiku`).
 * - Codex: `gpt-5.6-luna`, the cheapest slug in the pinned CLI's catalog
 *   (contract snapshot `codex-0.155.0.json`), as T2.3c uses.
 */
export type LiveEngineName = 'opencode' | 'claude' | 'codex'

export interface LiveEngine {
  name: LiveEngineName
  /** For logs and annotations: `opencode`, `claude sonnet`, `codex gpt-5.6-luna`. */
  label: string
  /** The real login a Claude/Codex run launches on; null on OpenCode. */
  realLogin: RealLogin | null
  /** The runtime block every agent the spec arranges gets; null on OpenCode (the agent keeps the Default runtime). */
  runtime: LocalAgentRuntimeInput | null
  /** Why this run cannot go ahead (no binary, not logged in), or null. */
  skipReason: string | null
  /**
   * How the agent's prompt names the `cinna` MCP tools: each engine shows them
   * under its own prefix. OpenCode's sentence is the one the specs always had.
   */
  toolNote: string
}

/** The cheapest model in the pinned Codex CLI's catalog (contract snapshot `codex-0.155.0.json`). */
export const CODEX_LIVE_MODEL = 'gpt-5.6-luna'

const RAW = (process.env.CINNA_E2E_LIVE_ENGINE ?? '').trim() || 'opencode'
if (RAW !== 'opencode' && RAW !== 'claude' && RAW !== 'codex') {
  throw new Error(`CINNA_E2E_LIVE_ENGINE must be opencode, claude or codex, not "${RAW}"`)
}
const MODEL_OVERRIDE = (process.env.CINNA_E2E_LIVE_MODEL ?? '').trim()

export const LIVE_ENGINE: LiveEngine = resolve(RAW)

/**
 * `test.use(liveEngineOptions())` at the top of a live spec: the cached
 * OpenCode always (harmless on the other engines), the real login when the
 * run is on Claude or Codex, and the proof that the turns ran there — after a
 * passing test the fixture reads the main process's output (`mainLog.ts`):
 * at least one `ACP turn complete` on this launcher, none on another, and on
 * Claude/Codex the resolved binary is the one named here. The run log prints
 * `live engine: <engine> <version> <source> <path> — <n> turns completed …`.
 */
export function liveEngineOptions(): Partial<CinnaOptions> {
  return {
    engine: true,
    realLogin: LIVE_ENGINE.realLogin,
    liveEngineCheck: { engine: LIVE_ENGINE.name, binary: LIVE_ENGINE.realLogin?.binary ?? null }
  }
}

/** For a test that runs no agent turn at all (it stops at a gate): the engine check then only forbids other engines. */
export function expectNoAgentTurn(): void {
  test.info().annotations.push({ type: NO_AGENT_TURN, description: 'this test stops before any agent turn' })
}

/** `test.beforeEach(() => requireLiveEngine())`: the live gate, then this engine's prerequisites. */
export function requireLiveEngine(): void {
  if (LIVE_ENGINE.name === 'opencode') return requireLiveKey()
  test.skip(!LIVE_REQUESTED, 'live specs run only through make e2e-live or make e2e-one SPEC=<live spec>')
  test.skip(LIVE_ENGINE.skipReason !== null, LIVE_ENGINE.skipReason ?? '')
}

/** For a test that only makes sense on OpenCode (the cloud channel, an OpenCode-only seam). */
export function requireOpenCode(reason: string): void {
  test.skip(LIVE_ENGINE.name !== 'opencode', `OpenCode only: ${reason}`)
}

/**
 * The model setup a live spec starts from: on OpenCode the OpenAI default
 * mode (answers its model id); on Claude/Codex the same mode when `.env` has a
 * key, and the engine's label either way.
 */
export async function seedLiveModel(cinna: CinnaApp): Promise<string> {
  if (LIVE_ENGINE.name === 'opencode') return seedOpenAiDefaultMode(cinna)
  if (OPENAI_API_KEY !== '') await seedOpenAiDefaultMode(cinna)
  return LIVE_ENGINE.label
}

/**
 * Put this run's engine and model on one agent, kit (`updateField` into the
 * manifest, under its stamp) or bare (`setRuntime`, desktop state). A no-op on
 * OpenCode, which keeps every agent on the Default runtime as before. Call it
 * after the agent exists and before the relaunch that lets pickers see it.
 */
export async function useLiveRuntime(cinna: CinnaApp, agentId: string): Promise<void> {
  const runtime = LIVE_ENGINE.runtime
  if (runtime === null) return
  const outcome = await cinna.page.evaluate(async ({ agentId, runtime }) => {
    const got = await window.api.localAgents.get(agentId)
    if (!got.ok) return { ok: false as const, message: got.message }
    if (got.value.kind === 'bare') return window.api.localAgents.setRuntime(agentId, runtime)
    const stamp = got.value.stamps['cinna-agent.json']
    if (!stamp) return { ok: false as const, message: 'the kit agent has no manifest stamp' }
    return window.api.localAgents.updateField({ agentId, update: { field: 'runtime', value: runtime }, expectedStamp: stamp })
  }, { agentId, runtime })
  expect(outcome.ok, `the ${LIVE_ENGINE.label} runtime is saved on ${agentId}: ${outcome.ok ? '' : outcome.message}`).toBe(true)
}

function resolve(name: LiveEngineName): LiveEngine {
  if (name === 'opencode') {
    return {
      name,
      label: 'opencode',
      realLogin: null,
      runtime: null,
      skipReason: null,
      toolNote: 'The Cinna tools come from the "cinna" MCP server; in your tool list they may be named with a cinna_ prefix (for example cinna_tasks_create).'
    }
  }
  if (name === 'claude') {
    const binary = claudeBinary()
    // A tier unless a model alias is named: `simple` / `medium` / `complex` stay tiers.
    const tier = MODEL_OVERRIDE === '' ? 'medium' : ['simple', 'medium', 'complex'].includes(MODEL_OVERRIDE) ? MODEL_OVERRIDE : null
    return {
      name,
      label: `claude ${tier === null ? MODEL_OVERRIDE : tier === 'simple' ? 'haiku' : tier === 'medium' ? 'sonnet' : 'opus'}`,
      realLogin: binary ? { engine: 'claude', binary, pathSetting: 'localAgentsClaudePath' } : null,
      runtime: { engine: 'claude', credential: null, modelId: tier === null ? MODEL_OVERRIDE : null, complexity: (tier ?? null) as LocalAgentRuntimeInput['complexity'] },
      skipReason: binary === null
        ? 'CINNA_E2E_LIVE_ENGINE=claude: no Claude Code binary (set CINNA_E2E_CLAUDE_PATH, or install ~/.local/bin/claude)'
        : claudeLoginProblem(binary),
      toolNote: 'The Cinna tools come from the "cinna" MCP server; in your tool list they are named with an mcp__cinna__ prefix (for example mcp__cinna__tasks_create).'
    }
  }
  const binary = codexBinary()
  const model = MODEL_OVERRIDE || CODEX_LIVE_MODEL
  return {
    name,
    label: `codex ${model}`,
    realLogin: binary ? { engine: 'codex', binary, pathSetting: 'localAgentsCodexPath' } : null,
    runtime: { engine: 'codex', credential: null, modelId: model, complexity: null },
    skipReason: binary === null
      ? `CINNA_E2E_LIVE_ENGINE=codex: no Codex binary (set CINNA_E2E_CODEX_PATH, or run make contract ENGINE=codex for the pinned ${RUNTIME_PINS.codex.cli})`
      : codexLoginProblem(binary),
    toolNote: 'The Cinna tools come from the "cinna" MCP server; in your tool list they may carry the server name as a prefix (for example cinna.tasks_create or mcp__cinna__tasks_create).'
  }
}

function firstExisting(candidates: readonly string[]): string | null {
  for (const path of candidates) {
    if (path !== '' && existsSync(path)) return realpathSync(path)
  }
  return null
}

function claudeBinary(): string | null {
  return firstExisting([
    (process.env.CINNA_E2E_CLAUDE_PATH ?? '').trim(),
    join(homedir(), '.local', 'bin', 'claude'),
    join(homedir(), 'Library', 'Application Support', 'cinna-desktop', 'runtimes', `claude-${RUNTIME_PINS.claude.cli}`, 'claude')
  ])
}

function codexBinary(): string | null {
  const folder = `codex-${RUNTIME_PINS.codex.cli}`
  return firstExisting([
    (process.env.CINNA_E2E_CODEX_PATH ?? '').trim(),
    join(homedir(), 'Library', 'Application Support', 'cinna-desktop', 'runtimes', folder, 'codex'),
    join(process.env.CINNA_RUNTIME_CACHE ?? join(homedir(), '.cache', 'cinna-runtimes'), folder, 'codex')
  ])
}

/** `claude auth status` — runs no turn and bills nothing; JSON with a boolean `loggedIn`. */
function claudeLoginProblem(binary: string): string | null {
  const out = spawnSync(binary, ['auth', 'status'], { encoding: 'utf8', timeout: 15_000 })
  try {
    if (JSON.parse(out.stdout)?.loggedIn === true) return null
  } catch {
    // not JSON: reported below
  }
  return `CINNA_E2E_LIVE_ENGINE=claude: ${binary} is not logged in on this machine (claude auth status)`
}

/** `codex login status` — prints `Logged in using …` (on stderr) when there is a login. */
function codexLoginProblem(binary: string): string | null {
  const out = spawnSync(binary, ['login', 'status'], { encoding: 'utf8', timeout: 15_000 })
  if (/^Logged in (?:using|with)\b/im.test(`${out.stdout ?? ''}\n${out.stderr ?? ''}`)) return null
  return `CINNA_E2E_LIVE_ENGINE=codex: ${binary} is not logged in on this machine (codex login status)`
}
