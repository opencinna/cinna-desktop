import { beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUNTIME_PINS } from '../../../../../shared/runtimePins'
import { ConductorMcpServer } from '../../../../services/conductorMcpServer'
import { applyConductorToolPolicy, cinnaToolName } from '../conductorToolPolicy'
import { parseClaudeAuthStatus } from '../claudeAuth'
import { airClientMeta } from '../acpActivity'
import { readContextCategories } from '../acpTelemetry'
import { toInputQuestions } from '../acpQuestions'
import { pickPermissionOption } from '../acpPermissions'
import type { PermissionOption } from '@agentclientprotocol/sdk'
import { resolveOfferedModel, selectedModelOf } from '../acpMessages'
import type { AcpLaunchPlan } from '../acpLaunchers'
import { buildClaudeEnv, SUBPROCESS_SCRUB_ENV } from '../claudeEnv'
import { CLAUDE_CONTRACT } from './claude.contract'
import { runCli, spawnAdapter, type AdapterConnection, type AdapterMessage } from './codexHarness'
import {
  findContractClaude, makeClaudeScratch, startEgressTrap, startFakeAnthropic,
  type ClaudeProviderReply, type ClaudeProviderTurn, type EgressTrap, type FakeAnthropic
} from './claudeHarness'
import { lineDiff, sorted } from './snapshotTools'
import { probeFolderHandovers, handoverProbeSnapshot, type HandoverProbe } from './handoverProbes'

/**
 * The Claude Code interface contract, checked against the **real** CLI.
 *
 * `npm run test:contract` (its own vitest config — never part of `npm test`):
 * the managed pinned binary and the installed ACP adapter, over real stdio,
 * against a loopback fake Anthropic Messages endpoint, in a throwaway HOME, with
 * every other outbound connection refused and recorded. No login, no real
 * credential, no provider request. One `it` per entry of `claude.contract.ts`,
 * its title starting with the entry's id — `contractRegistry.test.ts` holds that
 * mapping. An entry tagged `live` is `it.skip`: it says why, and nothing fakes it.
 *
 * Two scenarios are driven once in `beforeAll` and every `it` asserts on what
 * was observed. The same observations, reduced to shapes, are **compared with**
 * the committed `snapshots/claude-<version>.json` (the last test) and written
 * only by `make contract-snapshot ENGINE=claude`.
 *
 * `CINNA_CONTRACT_CLAUDE=/abs/path` runs all of it against a candidate binary
 * without touching the pin (`make contract-next ENGINE=claude VERSION=x`).
 */

const here = dirname(fileURLToPath(import.meta.url))
const binaryRef = findContractClaude(RUNTIME_PINS.claude.cli)
const candidate = binaryRef?.source === 'override'
const adapter = createRequire(import.meta.url).resolve('@agentclientprotocol/claude-agent-acp/dist/index.js')

/** No binary is a **failure**, not a skip — for the reason the Codex contract gives. */
const allowSkip = process.env['CINNA_CONTRACT_ALLOW_SKIP'] === '1'
const NO_BINARY =
  `The Claude contract needs the managed Claude Code ${RUNTIME_PINS.claude.cli} and found none — nothing was checked.\n` +
  '  Install it with:  make contract ENGINE=claude   (or: node --experimental-strip-types scripts/install-runtime.mjs claude)\n' +
  '  Or point CINNA_CONTRACT_CLAUDE at a claude executable.\n' +
  '  To skip knowingly: CINNA_CONTRACT_ALLOW_SKIP=1'
if (!binaryRef && allowSkip) console.warn(`\nSKIPPED: ${NO_BINARY}\n`)
const writeSnapshot = process.env['CINNA_CONTRACT_WRITE_SNAPSHOT'] === '1'

const SYSTEM_MARKER = 'CONTRACT_SYSTEM_PROMPT_5a1'
const CLAUDE_MD_MARKER = 'CONTRACT_CLAUDE_MD_c77'
const SUBAGENT = 'contract-helper-3e9'
/** The desktop's plugin and skill name, and the name Claude must offer it under. */
const PLUGIN_SKILL = 'cinna-tasks'
const PLUGIN_SKILL_QUALIFIED = `${PLUGIN_SKILL}:${PLUGIN_SKILL}`
const PLUGIN_SKILL_MARKER = 'CONTRACT_PLUGIN_SKILL_4d2'
/** A kit agent's own skill, as `agentSkillsPlugin` lays it out: a link into the agent folder (the cwd). */
const AGENT_PLUGIN = 'contract-agent'
const AGENT_SKILL = 'contract-own-skill'
const AGENT_SKILL_QUALIFIED = `${AGENT_PLUGIN}:${AGENT_SKILL}`
const AGENT_SKILL_MARKER = 'CONTRACT_AGENT_SKILL_9b7'
const POLICY_MARKER = 'CONTRACT_POLICY_PROMPT_e52'
const FIRST_PROMPT = 'CONTRACT_FIRST_MESSAGE_81b. Answer OK.'
/** What the `claude_code` preset says and an agent's own prompt must not. */
const PRESET_TEXT = /interactive (CLI tool|agent) that helps users with software engineering/i
const NATIVE_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Agent', 'WebFetch']

type Json = Record<string, unknown>
const keys = (value: unknown): string[] => (value && typeof value === 'object' ? Object.keys(value as Json).sort() : [])
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check: () => boolean, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (check()) return true; await sleep(50) }
  return check()
}
const conversation = (turns: ClaudeProviderTurn[]): ClaudeProviderTurn[] => turns.filter((turn) => turn.kind === 'conversation')

/**
 * Whether the plugin's skill reached the model: its description marker, under
 * the plugin-qualified name or — when nothing else uses it — the bare one
 * (Claude Code namespaces plugin skills `<plugin>:<skill>`).
 */
function pluginSkillOffered(turns: ClaudeProviderTurn[]): boolean {
  return turns.some((turn) => turn.mentions(PLUGIN_SKILL_MARKER) &&
    (turn.mentions(PLUGIN_SKILL_QUALIFIED) || turn.mentions(PLUGIN_SKILL)))
}

/** Everything the two scenarios observed. Filled by `beforeAll`. */
const seen = {
  handover: null as HandoverProbe | null,
  versionOutput: '', versionStatus: null as number | null,
  authWithKey: { status: null as number | null, stdout: '' },
  authLoggedOut: { status: null as number | null, stdout: '' },
  wrapperRan: false,
  initialize: null as AdapterMessage | null,
  sessionNew: null as AdapterMessage | null,
  setModes: {} as Record<string, boolean>,
  folderTurns: [] as ClaudeProviderTurn[],
  firstPromptUpdates: [] as Json[],
  contextUsage: null as AdapterMessage | null,
  contextUsageUnknown: null as AdapterMessage | null,
  /** What the measurement asked of the provider: its requests off `/v1/messages`, and how many Messages requests. */
  contextUsageTraffic: { other: [] as string[], messages: 0 },
  question: { request: null as AdapterMessage | null, toolResults: [] as string[] },
  nativeMentionsClaudeMd: false, isolatedMentionsClaudeMd: true,
  /** Whether the plugin's skill reached the model, by its qualified name, per branch. */
  pluginSkill: { isolated: false, native: false },
  /** Whether the agent's own linked skill reached the isolated session, under `<plugin>:<folder>`. */
  agentSkillOffered: false,
  bypassInMetaMode: null as unknown,
  policyTurns: [] as ClaudeProviderTurn[],
  policyOptions: null as Json | null,
  permission: null as AdapterMessage | null, permissionCount: 0,
  toolCallUpdates: [] as Json[],
  mcpCalls: [] as { name: string; toolCallId: string; aborted: boolean }[],
  toolsAfterListChanged: [] as string[],
  cancel: { stopReason: null as unknown, ms: 0 },
  load: { ok: false, mode: null as unknown, replayed: [] as string[], continuedUserMessages: 0 },
  rateLimit: null as AdapterMessage | null,
  otherRequests: [] as string[],
  egress: [] as string[],
  /** Scenario C: the user's `settings.json` names a model, the desktop re-asserts its own. */
  model: { error: null as unknown, startedOn: null as string | null, resolved: null as string | null, set: false,
    /** The conversation's models before the re-assert, and after it. */
    before: [] as string[], after: [] as string[] },
  /** Scenario D: native tools and activity on a folder session, as the desktop declares itself. */
  tools: { error: null as unknown, fileAfterEdit: '' as string,
    /** Every tool_call / tool_call_update of the Read, and of the Edit. */
    read: [] as Json[], edit: [] as Json[],
    /** Every permission ask of the scenario, in order. */
    permissions: [] as AdapterMessage[],
    /** Every `sessionUpdate` kind of the background-shell and subagent prompts, and the updates of the activity kinds. */
    activityKinds: [] as string[], activity: [] as Json[] },
  /** Scenario E: a native Bash ask answered with Cinna's Deny (`pickPermissionOption(…, 'reject')`). */
  deny: { asks: [] as AdapterMessage[], sent: [] as (string | null)[], answer: null as AdapterMessage | null,
    turns: [] as ClaudeProviderTurn[], ran: false },
  /** Scenario F: API mode's environment as `buildClaudeEnv` builds it, with and without the subprocess scrub. */
  scrub: { on: null as ScrubRun | null, off: null as ScrubRun | null }
}

/** The CLI's own title request gets a title; only the conversation is scripted, so it cannot consume a step. */
const TITLE_REPLY: ClaudeProviderReply = { kind: 'text', text: 'Contract thread' }

const initParams = { protocolVersion: 1,
  // Exactly what the Claude launcher advertises: `elicitation.form` is what keeps AskUserQuestion alive.
  clientCapabilities: { elicitation: { form: {} }, _meta: airClientMeta(['asyncTasks', 'nativeSubagentSessions']) },
  clientInfo: { name: 'cinna-desktop', version: '1' } }

/* -------------------------------------------------------------- scenario A */

/** A folder-agent-shaped session: the isolated branch of the launcher, native tools on, no MCP. */
async function folderScenario(binary: string, trap: EgressTrap): Promise<void> {
  let provider: FakeAnthropic | undefined
  let connection: AdapterConnection | undefined
  let script: ClaudeProviderReply[] = []
  provider = await startFakeAnthropic((turn) => turn.kind === 'title' ? TITLE_REPLY : (script.shift() ?? { kind: 'text', text: 'OK' }))
  const scratch = makeClaudeScratch('cinna-contract-claude-folder-', { providerPort: provider.port, trapPort: trap.port })
  try {
    const version = runCli(binary, ['--version'], scratch.env, scratch.cwd)
    seen.versionOutput = version.stdout.trim().split('\n')[0] ?? ''
    seen.versionStatus = version.status
    const withKey = runCli(binary, ['auth', 'status'], scratch.env, scratch.cwd)
    seen.authWithKey = { status: withKey.status, stdout: withKey.stdout }
    // The same isolated HOME with no key at all: what a logged-out install says.
    const { ANTHROPIC_API_KEY: _key, ...noKey } = scratch.env
    void _key
    const loggedOut = runCli(binary, ['auth', 'status'], noKey, scratch.cwd)
    seen.authLoggedOut = { status: loggedOut.status, stdout: loggedOut.stdout }

    writeFileSync(join(scratch.cwd, 'CLAUDE.md'), `# Project\n\n${CLAUDE_MD_MARKER}\n`)
    // CLAUDE_CODE_EXECUTABLE is proven by a wrapper that leaves a mark before handing over.
    const marker = join(scratch.home, 'claude-path-used')
    const wrapper = join(scratch.home, 'claude-wrapper.sh')
    writeFileSync(wrapper, `#!/bin/sh\necho used >> '${marker}'\nexec '${binary}' "$@"\n`)
    chmodSync(wrapper, 0o700)
    connection = spawnAdapter({ adapterPath: adapter, cwd: scratch.cwd, env: { ...scratch.env, CLAUDE_CODE_EXECUTABLE: wrapper },
      answer: (request) => {
        if (request.method !== 'elicitation/create') return undefined
        seen.question.request ??= request
        return { action: 'accept', content: { question_0: 'Yes' } }
      } })
    seen.initialize = await connection.rpc('initialize', initParams)
    // The plugin as `tasksSkillService` lays it out, outside the project and HOME's settings.
    const plugin = join(scratch.home, 'cinna-plugins', PLUGIN_SKILL)
    mkdirSync(join(plugin, '.claude-plugin'), { recursive: true })
    mkdirSync(join(plugin, 'skills', PLUGIN_SKILL), { recursive: true })
    writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: PLUGIN_SKILL, description: 'Contract plugin.', version: '1' }))
    writeFileSync(join(plugin, 'skills', PLUGIN_SKILL, 'SKILL.md'),
      `---\nname: ${PLUGIN_SKILL}\ndescription: ${PLUGIN_SKILL_MARKER} Work with Cinna tasks.\nversion: "1"\nuser-invocable: false\n---\n\n# Cinna tasks\n`)
    const plugins = [{ type: 'local', path: plugin }]
    // The agent's own skill lives in the agent folder; the plugin holds only a link to it.
    const ownSkill = join(scratch.cwd, 'skills', AGENT_SKILL)
    mkdirSync(ownSkill, { recursive: true })
    writeFileSync(join(ownSkill, 'SKILL.md'), `---\nname: ${AGENT_SKILL}\ndescription: ${AGENT_SKILL_MARKER} Fill contract forms.\n---\n\n# Own skill\n`)
    const agentPlugin = join(scratch.home, 'cinna-plugins', 'agents', 'contract')
    mkdirSync(join(agentPlugin, '.claude-plugin'), { recursive: true })
    mkdirSync(join(agentPlugin, 'skills'), { recursive: true })
    writeFileSync(join(agentPlugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: AGENT_PLUGIN, description: 'Contract agent skills.', version: '1' }))
    symlinkSync(ownSkill, join(agentPlugin, 'skills', AGENT_SKILL), 'dir')
    const isolated = { systemPrompt: SYSTEM_MARKER, settingSources: [], strictMcpConfig: true, mcpServers: {},
      agents: { [SUBAGENT]: { description: 'A contract subagent.', prompt: 'Answer OK.' } },
      plugins: [...plugins, { type: 'local', path: agentPlugin }] }
    seen.sessionNew = await connection.rpc('session/new', { cwd: scratch.cwd, mcpServers: [], _meta: { claudeCode: { options: isolated } } }, 60_000)
    seen.wrapperRan = existsSync(marker)
    const sessionId = String(seen.sessionNew.result?.sessionId ?? '')
    if (!sessionId) return
    for (const modeId of ['auto', 'default']) {
      seen.setModes[modeId] = !(await connection.rpc('session/set_mode', { sessionId, modeId })).error
    }
    await connection.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: FIRST_PROMPT }] }, 90_000)
    // The second title request follows the turn rather than riding inside it.
    await until(() => provider!.turns.filter((turn) => turn.kind === 'title').length >= 2, 5_000)
    seen.firstPromptUpdates = [...connection.updates]
    // The patched adapter's measurement, between turns, after the session's first answered prompt.
    // Its provider traffic is its own entry's observation, kept out of the others'.
    const otherBefore = provider.otherRequests.length
    const messagesBefore = provider.turns.length
    seen.contextUsage = await connection.rpc('_cinna/contextUsage', { sessionId }, 60_000)
    seen.contextUsageUnknown = await connection.rpc('_cinna/contextUsage', { sessionId: 'no-such-session' })
    seen.contextUsageTraffic = { other: provider.otherRequests.splice(otherBefore), messages: provider.turns.length - messagesBefore }

    script = [{ kind: 'tool', name: 'AskUserQuestion', input: { questions: [{ question: 'Deterministic?', header: 'Probe', multiSelect: false,
      options: [{ label: 'Yes', description: 'Accept' }, { label: 'No', description: 'Decline' }] }] } }]
    await connection.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Ask a question.' }] }, 90_000)
    seen.question.toolResults = provider.turns.flatMap((turn) => turn.toolResults)
    seen.folderTurns = [...provider.turns]
    seen.isolatedMentionsClaudeMd = conversation(provider.turns).some((turn) => turn.mentions(CLAUDE_MD_MARKER))
    seen.pluginSkill.isolated = pluginSkillOffered(conversation(provider.turns))
    seen.agentSkillOffered = conversation(provider.turns).some((turn) => turn.mentions(AGENT_SKILL_MARKER) && turn.mentions(AGENT_SKILL_QUALIFIED))

    // The native branch, in the same folder: the launcher's other set of options.
    const before = provider.turns.length
    const native = await connection.rpc('session/new', { cwd: scratch.cwd, mcpServers: [], _meta: { claudeCode: { options: {
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'CONTRACT_NATIVE_APPEND' }, settingSources: ['user', 'project', 'local'], plugins } } } }, 60_000)
    const nativeId = String(native.result?.sessionId ?? '')
    if (nativeId) {
      await connection.rpc('session/set_mode', { sessionId: nativeId, modeId: 'default' })
      await connection.rpc('session/prompt', { sessionId: nativeId, prompt: [{ type: 'text', text: 'Answer OK.' }] }, 90_000)
      seen.nativeMentionsClaudeMd = conversation(provider.turns.slice(before)).some((turn) => turn.mentions(CLAUDE_MD_MARKER))
      seen.pluginSkill.native = pluginSkillOffered(conversation(provider.turns.slice(before)))
    }
    seen.otherRequests.push(...provider.otherRequests)
  } finally {
    await connection?.close()
    await provider?.close()
    scratch.dispose()
  }
}

/* -------------------------------------------------------------- scenario B */

/** A restricted chat, its options produced by the production policy helper itself. */
async function policyScenario(binary: string, trap: EgressTrap): Promise<void> {
  const mcp = new ConductorMcpServer()
  let provider: FakeAnthropic | undefined
  let connection: AdapterConnection | undefined
  let script: ClaudeProviderReply[] = []
  let refuse = false
  provider = await startFakeAnthropic((turn) => {
    if (turn.kind === 'title') return TITLE_REPLY
    // `x-should-retry: false` bounds the run: left to itself the SDK backs off
    // and retries a 429, which is a minute of waiting that checks nothing here.
    if (refuse) return { kind: 'status', status: 429, headers: { 'retry-after': '0', 'x-should-retry': 'false' },
      body: { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limit reached' } } }
    return script.shift() ?? { kind: 'text', text: 'OK' }
  })
  const scratch = makeClaudeScratch('cinna-contract-claude-policy-', { providerPort: provider.port, trapPort: trap.port })
  try {
    let tools = ['probe']
    let hang = false
    const cinna = await mcp.ensureSession('cinna', { getProviders: () => [{ providerType: 'mcp', displayName: 'contract',
      getTools: () => tools.map((name) => ({ name, description: 'Return literal OK.', inputSchema: { type: 'object', properties: {} }, providerType: 'mcp', mcpProviderId: name })),
      callTool: async (name: string, _input: unknown, options: { signal: AbortSignal; toolCallId: string }) => {
        const call = { name, toolCallId: options.toolCallId, aborted: false }
        seen.mcpCalls.push(call)
        if (hang) await new Promise<void>((resolve) => {
          options.signal.addEventListener('abort', () => { call.aborted = true; resolve() }, { once: true })
          setTimeout(resolve, 20_000).unref()
        })
        return { content: 'OK' }
      } }] } as never)
    // The launcher's isolated options with a value the policy must overwrite,
    // and a `permissionMode` the adapter must ignore.
    const plan = { spec: { command: process.execPath, args: [adapter], cwd: scratch.cwd, key: 'contract', env: {} },
      init: { protocolVersion: 1 }, setup: { modeId: 'default' },
      session: { mcpServers: [], meta: { claudeCode: { options: { systemPrompt: POLICY_MARKER, permissionMode: 'bypassPermissions' } } } }
    } as unknown as AcpLaunchPlan
    const restricted = applyConductorToolPolicy(plan, 'claude')
    seen.policyOptions = ((restricted.session.meta?.claudeCode as Json | undefined)?.options ?? null) as Json | null
    connection = spawnAdapter({ adapterPath: adapter, cwd: scratch.cwd, env: { ...scratch.env, CLAUDE_CODE_EXECUTABLE: binary },
      answer: (request) => {
        if (request.method !== 'session/request_permission') return undefined
        seen.permissionCount++
        seen.permission ??= request
        const option = ((request.params?.options as Json[] | undefined) ?? []).find((candidateOption) => candidateOption.kind === 'allow_once')
        return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : undefined
      } })
    await connection.rpc('initialize', initParams)
    const created = await connection.rpc('session/new', { cwd: scratch.cwd, mcpServers: [cinna.descriptor], _meta: restricted.session.meta }, 60_000)
    const sessionId = String(created.result?.sessionId ?? '')
    if (!sessionId) return
    seen.bypassInMetaMode = (created.result?.modes as Json | undefined)?.currentModeId ?? null
    await connection.rpc('session/set_mode', { sessionId, modeId: 'default' })
    const prompt = (text: string, ms = 90_000): Promise<AdapterMessage> => connection!.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, ms)

    script = [{ kind: 'tool', name: 'mcp__cinna__probe' }]
    await prompt('Call the Cinna probe, then answer OK.')
    seen.toolCallUpdates = connection.updates.filter((update) => update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')

    // A tool added mid-session, announced the way the app announces it.
    tools = ['probe', 'probe_added']
    await cinna.refreshTools()
    await sleep(1500)
    const beforeSecond = provider.turns.length
    await prompt('Answer OK again.')
    seen.toolsAfterListChanged = conversation(provider.turns.slice(beforeSecond))[0]?.tools ?? []

    // Stop while the MCP call is running — the state a user presses Stop in.
    hang = true
    script = [{ kind: 'tool', name: 'mcp__cinna__probe' }]
    const callsBefore = seen.mcpCalls.length
    const running = prompt('Call the probe and wait.', 40_000)
    await until(() => seen.mcpCalls.length > callsBefore, 20_000)
    const cancelledAt = Date.now()
    connection.notify('session/cancel', { sessionId })
    const cancelled = await running
    await until(() => seen.mcpCalls.at(-1)?.aborted === true, 5_000)
    seen.cancel = { stopReason: cancelled.result?.stopReason ?? cancelled.error ?? null, ms: Date.now() - cancelledAt }
    hang = false

    const updatesBefore = connection.updates.length
    const loaded = await connection.rpc('session/load', { sessionId, cwd: scratch.cwd, mcpServers: [cinna.descriptor], _meta: restricted.session.meta }, 60_000)
    seen.load.ok = !loaded.error
    seen.load.mode = (loaded.result?.modes as Json | undefined)?.currentModeId ?? null
    seen.load.replayed = connection.updates.slice(updatesBefore).map((update) => String(update.sessionUpdate))
    await connection.rpc('session/set_mode', { sessionId, modeId: 'default' })
    const beforeContinue = provider.turns.length
    await prompt('Answer OK after the load.')
    seen.load.continuedUserMessages = conversation(provider.turns.slice(beforeContinue))[0]?.userMessages ?? 0

    // Last: a refused request may leave the session in an error state.
    refuse = true
    seen.rateLimit = await prompt('This request is rate limited.', 120_000)
    seen.policyTurns = [...provider.turns]
    seen.otherRequests.push(...provider.otherRequests)
  } finally {
    await connection?.close()
    await mcp.dispose()
    await provider?.close()
    scratch.dispose()
  }
}

/* -------------------------------------------------------------- scenario C */

/**
 * What the user's own `~/.claude/settings.json` asks for, and what the agent was
 * set to. `Sonnet`, capitalised, because it is **not** an offered value
 * verbatim: the adapter skips its `setModel` only for a settings value the SDK
 * offered as is, assuming the CLI read the same file — which under
 * `settingSources: []` it did not. So `"sonnet"` reports `sonnet` but runs the
 * options' model, while `"Sonnet"` is `setModel`led and runs Sonnet. The real
 * report's `"opus"` resolves to `opus[1m]` the same way, but against this fake
 * provider's API key the 1M variant is not applied and the turn stays on the
 * options' model (observed 2026-10-11, 2.1.276 / adapter 0.76.0), so it cannot
 * show the defect here.
 */
const SETTINGS_MODEL = 'Sonnet'
const AGENT_MODEL = 'haiku'

/**
 * The user's settings name a model; the agent was set to another. Kept out of
 * the snapshot: what it observes is this entry's alone, and the baseline
 * describes the two scenarios above.
 */
async function modelScenario(binary: string, trap: EgressTrap): Promise<void> {
  let provider: FakeAnthropic | undefined
  let connection: AdapterConnection | undefined
  provider = await startFakeAnthropic((turn) => turn.kind === 'title' ? TITLE_REPLY : { kind: 'text', text: 'OK' })
  const scratch = makeClaudeScratch('cinna-contract-claude-model-', { providerPort: provider.port, trapPort: trap.port })
  try {
    // Where the adapter's SettingsManager reads the user's settings: `CLAUDE_CONFIG_DIR/settings.json`.
    mkdirSync(join(scratch.home, '.claude'), { recursive: true })
    writeFileSync(join(scratch.home, '.claude', 'settings.json'), JSON.stringify({ model: SETTINGS_MODEL }))
    connection = spawnAdapter({ adapterPath: adapter, cwd: scratch.cwd, env: { ...scratch.env, CLAUDE_CODE_EXECUTABLE: binary } })
    await connection.rpc('initialize', initParams)
    // The launcher's isolated options, `model` included — what the desktop sent before the re-assert.
    const created = await connection.rpc('session/new', { cwd: scratch.cwd, mcpServers: [], _meta: { claudeCode: { options: {
      systemPrompt: SYSTEM_MARKER, model: AGENT_MODEL, settingSources: [], strictMcpConfig: true, mcpServers: {} } } } }, 60_000)
    const sessionId = String(created.result?.sessionId ?? '')
    if (!sessionId) { seen.model.error = created.error ?? 'no session'; return }
    seen.model.startedOn = selectedModelOf(created.result?.configOptions) ?? null
    const prompt = async (): Promise<string[]> => {
      const before = provider!.turns.length
      await connection!.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Answer OK.' }] }, 90_000)
      return conversation(provider!.turns.slice(before)).map((turn) => String(turn.model))
    }
    seen.model.before = await prompt()
    // The driver's own resolution, against what this session offered.
    const match = resolveOfferedModel(created.result?.configOptions, AGENT_MODEL)
    seen.model.resolved = match?.value ?? null
    if (match?.value) {
      const set = await connection.rpc('session/set_config_option', { sessionId, configId: match.configId, value: match.value })
      seen.model.set = !set.error
      if (set.error) seen.model.error = set.error
    }
    seen.model.after = await prompt()
  } finally {
    await connection?.close()
    await provider?.close()
    scratch.dispose()
  }
}

/* -------------------------------------------------------------- scenario D */

const READ_MARKER = 'CONTRACT_READ_TEXT_6f1'
const EDIT_OLD = 'CONTRACT_EDIT_OLD_2b8'
const EDIT_NEW = 'CONTRACT_EDIT_NEW_2b8'
const ACTIVITY_KINDS = ['async_task_spawned', 'async_task_progress', 'async_task_state_update', 'subagent_spawned', 'subagent_state_update']

/**
 * A folder session's native tools and activity, on the capabilities the
 * desktop declares (`initParams`): a Read, an Edit that asks first, a
 * background shell and a subagent. These are the shapes the adapter reshapes
 * for the JetBrains AIR UI when it takes the AIR declaration for that UI, which
 * the adapter patch turns off. Kept out of the snapshot, like scenario C.
 */
async function toolsScenario(binary: string, trap: EgressTrap): Promise<void> {
  let provider: FakeAnthropic | undefined
  let connection: AdapterConnection | undefined
  let script: ClaudeProviderReply[] = []
  provider = await startFakeAnthropic((turn) => turn.kind === 'title' ? TITLE_REPLY : (script.shift() ?? { kind: 'text', text: 'OK' }))
  const scratch = makeClaudeScratch('cinna-contract-claude-tools-', { providerPort: provider.port, trapPort: trap.port })
  try {
    const file = join(scratch.cwd, 'notes.txt')
    writeFileSync(file, `${READ_MARKER}\n${EDIT_OLD}\n`)
    connection = spawnAdapter({ adapterPath: adapter, cwd: scratch.cwd, env: { ...scratch.env, CLAUDE_CODE_EXECUTABLE: binary },
      answer: (request) => {
        if (request.method !== 'session/request_permission') return undefined
        seen.tools.permissions.push(request)
        const option = ((request.params?.options as Json[] | undefined) ?? []).find((candidateOption) => candidateOption.kind === 'allow_once')
        return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : undefined
      } })
    await connection.rpc('initialize', initParams)
    const created = await connection.rpc('session/new', { cwd: scratch.cwd, mcpServers: [], _meta: { claudeCode: { options: {
      systemPrompt: SYSTEM_MARKER, settingSources: [], strictMcpConfig: true, mcpServers: {},
      agents: { [SUBAGENT]: { description: 'A contract subagent.', prompt: 'Answer OK.' } } } } } }, 60_000)
    const sessionId = String(created.result?.sessionId ?? '')
    if (!sessionId) { seen.tools.error = created.error ?? 'no session'; return }
    await connection.rpc('session/set_mode', { sessionId, modeId: 'default' })
    const run = async (reply: ClaudeProviderReply, text: string): Promise<Json[]> => {
      const before = connection!.updates.length
      script = [reply]
      const answer = await connection!.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, 90_000)
      if (answer.error) seen.tools.error ??= answer.error
      return connection!.updates.slice(before)
    }
    const callsOf = (updates: Json[], toolName: string): Json[] => {
      const id = updates.find((update) => update.sessionUpdate === 'tool_call' &&
        ((update._meta as Json | undefined)?.claudeCode as Json | undefined)?.toolName === toolName)?.toolCallId
      return id === undefined ? [] : updates.filter((update) => update.toolCallId === id)
    }

    seen.tools.read = callsOf(await run({ kind: 'tool', name: 'Read', input: { file_path: file } }, 'Read notes.txt.'), 'Read')
    seen.tools.edit = callsOf(await run({ kind: 'tool', name: 'Edit', input: { file_path: file, old_string: EDIT_OLD, new_string: EDIT_NEW } }, 'Edit notes.txt.'), 'Edit')
    seen.tools.fileAfterEdit = readFileSync(file, 'utf8')

    const activityFrom = connection.updates.length
    await run({ kind: 'tool', name: 'Bash', input: { command: 'sleep 1; echo contract-bg', description: 'Background probe', run_in_background: true } }, 'Run it in the background.')
    await run({ kind: 'tool', name: 'Agent', input: { subagent_type: SUBAGENT, description: 'Contract probe', prompt: 'Answer OK.' } }, 'Ask the helper.')
    // The background shell ends after its prompt returned; its terminal state follows on its own.
    await until(() => connection!.updates.slice(activityFrom).filter((update) => update.sessionUpdate === 'async_task_state_update').length > 0 &&
      connection!.updates.slice(activityFrom).some((update) => update.sessionUpdate === 'subagent_state_update'), 15_000)
    const activity = connection.updates.slice(activityFrom)
    seen.tools.activityKinds = [...new Set(activity.map((update) => String(update.sessionUpdate)))].sort()
    seen.tools.activity = activity.filter((update) => ACTIVITY_KINDS.includes(String(update.sessionUpdate)))
  } finally {
    await connection?.close()
    await provider?.close()
    scratch.dispose()
  }
}

/* -------------------------------------------------------------- scenario E */

/** A native Bash call in `default` mode, its ask refused the way Cinna's Deny answers it. */
async function denyScenario(binary: string, trap: EgressTrap): Promise<void> {
  let provider: FakeAnthropic | undefined
  let connection: AdapterConnection | undefined
  let script: ClaudeProviderReply[] = []
  provider = await startFakeAnthropic((turn) => turn.kind === 'title' ? TITLE_REPLY : (script.shift() ?? { kind: 'text', text: 'OK' }))
  const scratch = makeClaudeScratch('cinna-contract-claude-deny-', { providerPort: provider.port, trapPort: trap.port })
  try {
    const made = join(scratch.cwd, 'made.txt')
    connection = spawnAdapter({ adapterPath: adapter, cwd: scratch.cwd, env: { ...scratch.env, CLAUDE_CODE_EXECUTABLE: binary },
      answer: (request) => {
        if (request.method !== 'session/request_permission') return undefined
        seen.deny.asks.push(request)
        const optionId = pickPermissionOption((request.params?.options ?? []) as PermissionOption[], 'reject')
        seen.deny.sent.push(optionId)
        return optionId ? { outcome: { outcome: 'selected', optionId } } : undefined
      } })
    await connection.rpc('initialize', initParams)
    const created = await connection.rpc('session/new', { cwd: scratch.cwd, mcpServers: [], _meta: { claudeCode: { options: {
      systemPrompt: SYSTEM_MARKER, settingSources: [], strictMcpConfig: true, mcpServers: {} } } } }, 60_000)
    const sessionId = String(created.result?.sessionId ?? '')
    if (!sessionId) return
    await connection.rpc('session/set_mode', { sessionId, modeId: 'default' })
    script = [{ kind: 'tool', name: 'Bash', input: { command: `touch '${made}'`, description: 'Create a file' } }, { kind: 'text', text: 'AFTER_DENY' }]
    const from = provider.turns.length
    seen.deny.answer = await connection.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Create made.txt.' }] }, 90_000)
    seen.deny.turns = conversation(provider.turns.slice(from))
    seen.deny.ran = existsSync(made)
  } finally {
    await connection?.close()
    await provider?.close()
    scratch.dispose()
  }
}

/* -------------------------------------------------------------- scenario F */

/** What one API-mode session observed. Kept out of the snapshot, like scenarios C and D. */
type ScrubProbe = 'auto' | 'printenv' | 'bash' | 'write' | 'mcp'

interface ScrubRun {
  error: unknown
  /** Whether the child environment carried the scrub — the control run's is false. */
  scrubbed: boolean
  /** Whether `session/set_mode` answered without an error, per mode. */
  setModes: Record<string, boolean>
  /**
   * Permission asks per probe. `auto` is a Bash call right after `set_mode`
   * `auto` — no ask is how the mode is seen to have taken (the adapter sends no
   * `current_mode_update` for a client's own `set_mode`); the rest run in `default`.
   */
  asks: Record<ScrubProbe, number>
  /** The tool result the CLI sent back to the provider for each probe. */
  results: Record<ScrubProbe, string>
  /** Whether the dummy key appears anywhere in what the printenv probe returned. */
  keyInPrintenv: boolean
  /** Whether the dummy key appears anywhere in what the stdio MCP server's tool returned (its whole environment). */
  keyInMcp: boolean
  /** The command line of the stdio MCP server's parent process, as `ps` reports it — who spawned it. */
  mcpParent: string | null
  /** The contents of the files the Bash and Write probes made in the session cwd, or null. */
  bashFile: string | null
  writeFile: string | null
}

const SCRUB_BASH_TEXT = 'CONTRACT_SCRUB_BASH_4c1'
const SCRUB_WRITE_TEXT = 'CONTRACT_SCRUB_WRITE_4c1'
const SCRUB_PRINTENV_END = 'CONTRACT_SCRUB_PRINTENV_DONE'
const SCRUB_MCP_SERVER = 'scrubprobe'
const SCRUB_MCP_TOOL = 'env_probe'
const SCRUB_MCP_END = 'CONTRACT_SCRUB_MCP_DONE'

/**
 * A stdio MCP server with no dependencies: newline-delimited JSON-RPC, one tool
 * that returns its own `ANTHROPIC_API_KEY` (or `ABSENT`), its whole environment,
 * and its parent's command line — the process that spawned it.
 */
const SCRUB_MCP_SCRIPT = `'use strict'
const { execFileSync } = require('node:child_process')
let parent = 'unknown'
try { parent = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(process.ppid)], { encoding: 'utf8' }).trim() } catch {}
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    let request
    try { request = JSON.parse(line) } catch { continue }
    if (request.id === undefined) continue
    if (request.method === 'initialize') {
      send({ id: request.id, result: { protocolVersion: request.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: '${SCRUB_MCP_SERVER}', version: '1' } } })
    } else if (request.method === 'tools/list') {
      send({ id: request.id, result: { tools: [{ name: '${SCRUB_MCP_TOOL}', description: 'Report this server process environment.', inputSchema: { type: 'object', properties: {} } }] } })
    } else if (request.method === 'tools/call') {
      const text = 'KEY=' + (process.env.ANTHROPIC_API_KEY ?? 'ABSENT') + '\\nPARENT=' + parent + '\\nENV=' + JSON.stringify(process.env) + '\\n${SCRUB_MCP_END}'
      send({ id: request.id, result: { content: [{ type: 'text', text }] } })
    } else {
      send({ id: request.id, result: {} })
    }
  }
})
`

/**
 * A folder session on **API mode's environment, built by `buildClaudeEnv`**
 * from the scratch HOME's login variables and the dummy key as the picked
 * credential — then, for the harness only, the config dir and the egress trap's
 * proxy. `scrub: false` removes `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` again: the
 * control that makes "the key is not in the tool's output" mean something.
 *
 * In one session: `set_mode` to `auto`, then `default` (Cinna's two modes, in
 * the order a turn may need them), then three native calls in `default`, each
 * answered `allow_once` — `printenv ANTHROPIC_API_KEY`, a Bash write and a
 * Write tool write, both in the session cwd.
 */
async function scrubScenario(binary: string, trap: EgressTrap, scrub: boolean): Promise<ScrubRun> {
  const observed: ScrubRun = { error: null, scrubbed: false, setModes: {},
    asks: { auto: 0, printenv: 0, bash: 0, write: 0, mcp: 0 }, results: { auto: '', printenv: '', bash: '', write: '', mcp: '' },
    keyInPrintenv: false, keyInMcp: false, mcpParent: null, bashFile: null, writeFile: null }
  let provider: FakeAnthropic | undefined
  let connection: AdapterConnection | undefined
  let script: ClaudeProviderReply[] = []
  let asks = 0
  provider = await startFakeAnthropic((turn) => turn.kind === 'title' ? TITLE_REPLY : (script.shift() ?? { kind: 'text', text: 'OK' }))
  const scratch = makeClaudeScratch(`cinna-contract-claude-scrub-${scrub ? 'on' : 'off'}-`, { providerPort: provider.port, trapPort: trap.port })
  try {
    const dummyKey = scratch.env.ANTHROPIC_API_KEY
    const built = buildClaudeEnv({ shellEnv: scratch.env, appVersion: 'contract', processEnv: {},
      apiKey: { apiKey: dummyKey, baseUrl: scratch.env.ANTHROPIC_BASE_URL } })
    if (!scrub) delete built[SUBPROCESS_SCRUB_ENV]
    observed.scrubbed = built[SUBPROCESS_SCRUB_ENV] === '1'
    const harnessOnly = ['CLAUDE_CONFIG_DIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'NO_PROXY', 'no_proxy']
    const env = { ...built, ...Object.fromEntries(harnessOnly.map((key) => [key, scratch.env[key]])), CLAUDE_CODE_EXECUTABLE: binary }
    connection = spawnAdapter({ adapterPath: adapter, cwd: scratch.cwd, env,
      answer: (request) => {
        if (request.method !== 'session/request_permission') return undefined
        asks += 1
        const optionId = pickPermissionOption((request.params?.options ?? []) as PermissionOption[], 'allow')
        return optionId ? { outcome: { outcome: 'selected', optionId } } : undefined
      } })
    await connection.rpc('initialize', initParams)
    // A stdio MCP server as an ACP descriptor, with no `env` of its own: whatever
    // it holds, it inherited from whoever spawned it.
    const mcpScript = join(scratch.home, 'scrub-mcp-server.cjs')
    writeFileSync(mcpScript, SCRUB_MCP_SCRIPT)
    const stdioMcp = { name: SCRUB_MCP_SERVER, command: process.execPath, args: [mcpScript], env: [] }
    const created = await connection.rpc('session/new', { cwd: scratch.cwd, mcpServers: [stdioMcp], _meta: { claudeCode: { options: {
      systemPrompt: SYSTEM_MARKER, settingSources: [], strictMcpConfig: true, mcpServers: {} } } } }, 60_000)
    const sessionId = String(created.result?.sessionId ?? '')
    if (!sessionId) { observed.error = created.error ?? 'no session'; return observed }
    const setMode = async (modeId: string): Promise<void> => {
      const answer = await connection!.rpc('session/set_mode', { sessionId, modeId })
      observed.setModes[modeId] = !answer.error
      if (answer.error) observed.error ??= answer.error
    }
    const probe = async (name: ScrubProbe, reply: ClaudeProviderReply, text: string): Promise<void> => {
      const asksBefore = asks
      const turnsBefore = provider!.turns.length
      script = [reply]
      const answer = await connection!.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, 90_000)
      if (answer.error) observed.error ??= answer.error
      observed.asks[name] = asks - asksBefore
      observed.results[name] = conversation(provider!.turns.slice(turnsBefore)).flatMap((turn) => turn.toolResults).at(-1) ?? ''
    }
    await setMode('auto')
    await probe('auto', { kind: 'tool', name: 'Bash', input: { command: 'echo CONTRACT_SCRUB_AUTO > made-in-auto.txt', description: 'Write a file' } }, 'Write a file in auto mode.')
    await setMode('default')
    await probe('printenv', { kind: 'tool', name: 'Bash', input: { command: `printenv ANTHROPIC_API_KEY; env; echo ${SCRUB_PRINTENV_END}`, description: 'Print the environment' } }, 'Print the environment.')
    observed.keyInPrintenv = observed.results.printenv.includes(dummyKey)
    const bashFile = join(scratch.cwd, 'made-by-bash.txt')
    await probe('bash', { kind: 'tool', name: 'Bash', input: { command: `echo ${SCRUB_BASH_TEXT} > made-by-bash.txt && cat made-by-bash.txt`, description: 'Write a file' } }, 'Write a file with Bash.')
    observed.bashFile = existsSync(bashFile) ? readFileSync(bashFile, 'utf8') : null
    const writeFile = join(scratch.cwd, 'made-by-write.txt')
    await probe('write', { kind: 'tool', name: 'Write', input: { file_path: writeFile, content: `${SCRUB_WRITE_TEXT}\n` } }, 'Write a file.')
    observed.writeFile = existsSync(writeFile) ? readFileSync(writeFile, 'utf8') : null
    await probe('mcp', { kind: 'tool', name: `mcp__${SCRUB_MCP_SERVER}__${SCRUB_MCP_TOOL}`, input: {} }, 'Call the environment probe.')
    observed.keyInMcp = observed.results.mcp.includes(dummyKey)
    observed.mcpParent = /^PARENT=(.*)$/m.exec(observed.results.mcp)?.[1] ?? null
    return observed
  } catch (error) {
    observed.error ??= error instanceof Error ? error.message : String(error)
    return observed
  } finally {
    await connection?.close()
    await provider?.close()
    scratch.dispose()
  }
}

/** A tool call update's output as text, from `content[]` and `rawOutput` (the two places `acpMessages.toolOutputText` reads). */
function outputText(update: Json): string {
  const content = ((update.content as Json[] | undefined) ?? []).map((block) => {
    const inner = (block.content as Json | undefined) ?? block
    return typeof inner.text === 'string' ? inner.text : ''
  })
  const raw = update.rawOutput
  return [...content, typeof raw === 'string' ? raw : raw === undefined ? '' : JSON.stringify(raw)].join('\n')
}

/* ---------------------------------------------------------------- snapshot */

/** Shapes only: no paths, ids, ports, tokens, timestamps or prompt text, so two versions diff cleanly. */
function snapshot(): Json {
  const init = (seen.initialize?.result ?? {}) as Json
  const created = (seen.sessionNew?.result ?? {}) as Json
  const permission = (seen.permission?.params ?? {}) as Json
  const toolCall = (permission.toolCall ?? {}) as Json
  const rate = (seen.rateLimit?.error ?? {}) as Json
  const firstToolCall = seen.toolCallUpdates.find((update) => update.sessionUpdate === 'tool_call') ?? null
  const question = (seen.question.request?.params ?? {}) as Json
  const titles = (turns: ClaudeProviderTurn[]): Json => {
    const found = turns.filter((turn) => turn.kind === 'title')
    // Not the count: the title after a scenario's last turn races with the
    // connection closing, and a baseline that can flake gets rewritten unread.
    return { sentMoreThanOnce: found.length >= 2, models: [...new Set(found.map((turn) => turn.model))].sort(), tools: [...new Set(found.flatMap((turn) => turn.tools))].sort(),
      stream: [...new Set(found.map((turn) => turn.stream))], maxTokens: [...new Set(found.map((turn) => turn.maxTokens))] }
  }
  const authKeys = (stdout: string): string[] => { try { return keys(JSON.parse(stdout)) } catch { return [] } }
  return {
    folderHandovers: handoverProbeSnapshot(seen.handover),
    tool: 'claude', version: seen.versionOutput, adapter: RUNTIME_PINS.claude.adapter,
    cli: {
      authStatusLoggedOut: { exitCode: seen.authLoggedOut.status, keys: authKeys(seen.authLoggedOut.stdout), verdict: parseClaudeAuthStatus(seen.authLoggedOut.stdout).state },
      authStatusApiKey: { exitCode: seen.authWithKey.status, keys: authKeys(seen.authWithKey.stdout), verdict: parseClaudeAuthStatus(seen.authWithKey.stdout).state }
    },
    acp: {
      initialize: { protocolVersion: init.protocolVersion ?? null, agentCapabilities: init.agentCapabilities ?? null, agentInfo: init.agentInfo ?? null,
        authMethodIds: ((init.authMethods as Json[] | undefined) ?? []).map((method) => String(method.id)).sort(), meta: init._meta ?? null, resultKeys: keys(init) },
      sessionNew: { resultKeys: keys(created),
        modeIds: (((created.modes as Json | undefined)?.availableModes as Json[] | undefined) ?? []).map((mode) => String(mode.id)).sort(),
        currentModeId: (created.modes as Json | undefined)?.currentModeId ?? null,
        configOptionIds: ((created.configOptions as Json[] | undefined) ?? []).map((option) => String(option.id)).sort() },
      folderSessionOfferedTools: [...(conversation(seen.folderTurns)[0]?.tools ?? [])].sort(),
      updateKindsFirstPrompt: [...new Set(seen.firstPromptUpdates.map((update) => String(update.sessionUpdate)))].sort(),
      toolCall: firstToolCall ? { title: firstToolCall.title ?? null, kind: firstToolCall.kind ?? null, metaKeys: keys(firstToolCall._meta),
        claudeCodeMetaKeys: keys((firstToolCall._meta as Json | undefined)?.claudeCode), updateKeys: keys(firstToolCall) } : null,
      permissionRequest: { paramKeys: keys(permission), toolCallKeys: keys(toolCall), toolCallKind: toolCall.kind ?? null, toolCallTitle: toolCall.title ?? null,
        metaKeys: keys(permission._meta), options: ((permission.options as Json[] | undefined) ?? []).map((option) => `${String(option.kind)}:${String(option.optionId)}`).sort() },
      elicitation: { paramKeys: keys(question), mode: question.mode ?? null, schemaProperties: keys((question.requestedSchema as Json | undefined)?.properties) },
      listChangedAdopted: seen.toolsAfterListChanged.includes('mcp__cinna__probe_added'),
      cancel: { stopReason: typeof seen.cancel.stopReason === 'string' ? seen.cancel.stopReason : 'error', mcpCallAborted: seen.mcpCalls.at(-1)?.aborted ?? null },
      load: { ok: seen.load.ok, mode: seen.load.mode, replayedKinds: [...new Set(seen.load.replayed)].sort() },
      permissionModeInMeta: { sent: 'bypassPermissions', sessionStartedIn: seen.bypassInMetaMode },
      rateLimit: { errorCode: rate.code ?? null, dataKeys: keys(rate.data), errorKind: (rate.data as Json | undefined)?.errorKind ?? null,
        stopReason: seen.rateLimit?.result?.stopReason ?? null }
    },
    providerTraffic: {
      paths: [...new Set([...seen.folderTurns, ...seen.policyTurns].map((turn) => turn.path))].sort(),
      otherRequests: [...new Set(seen.otherRequests)].sort(),
      apiKeys: [...new Set([...seen.folderTurns, ...seen.policyTurns].map((turn) => turn.apiKey))].sort(),
      conversationModels: [...new Set(conversation([...seen.folderTurns, ...seen.policyTurns]).map((turn) => turn.model))].sort(),
      title: { folderSession: titles(seen.folderTurns), restrictedChat: titles(seen.policyTurns) },
      refusedEgressHosts: [...new Set(seen.egress)].sort()
    },
    deny: { stopReason: seen.deny.answer?.result?.stopReason ?? null, asks: seen.deny.asks.length,
      sentKind: ((seen.deny.asks[0]?.params?.options as Json[] | undefined) ?? []).find((option) => option.optionId === seen.deny.sent[0])?.kind ?? null,
      conversationRequests: seen.deny.turns.length, toolResultAfterDeny: seen.deny.turns[1]?.toolResults.at(-1) ?? null, commandRan: seen.deny.ran },
    restrictedPolicy: { options: seen.policyOptions ? { ...seen.policyOptions, systemPrompt: '<marker>' } : null,
      offeredTools: [...new Set(conversation(seen.policyTurns).flatMap((turn) => turn.tools))].sort() }
  }
}

/* ------------------------------------------------------------------- tests */

const entry = (id: string): string => {
  const found = CLAUDE_CONTRACT.find((candidateEntry) => candidateEntry.id === id)
  if (!found) throw new Error(`${id} is not in the registry`)
  return `${id} — ${found.live ? `LIVE ONLY: ${found.live}` : found.expectation}`
}

// Registered only when it applies: a `describe.runIf` guard is still collected
// when the binary IS there, and shows up as an unexplained skip in every run.
if (!binaryRef && !allowSkip) {
  describe('Claude interface contract — no binary', () => {
    it('has a managed Claude Code to check', () => { throw new Error(NO_BINARY) })
  })
}

describe.skipIf(!binaryRef)('Claude interface contract', () => {
  const binary = binaryRef?.path ?? ''

  beforeAll(async () => {
    const trap = await startEgressTrap()
    try {
      await folderScenario(binary, trap)
      await policyScenario(binary, trap)
      await modelScenario(binary, trap)
      await toolsScenario(binary, trap)
      await denyScenario(binary, trap)
      seen.scrub.off = await scrubScenario(binary, trap, false)
      seen.scrub.on = await scrubScenario(binary, trap, true)
      seen.handover = await probeFolderHandovers('claude', binary, adapter, trap)
    } finally {
      seen.egress = [...trap.attempts]
      await trap.close()
    }
  })

  /* launch & env */
  it(entry('claude.launch.version-output'), () => {
    expect(seen.versionStatus).toBe(0)
    if (candidate) expect(seen.versionOutput).toMatch(/^\d+\.\d+\.\d+ \(Claude Code\)$/)
    else expect(seen.versionOutput).toBe(RUNTIME_PINS.claude.versionOutput)
  })

  it(entry('claude.launch.executable'), () => {
    expect(seen.sessionNew?.error, JSON.stringify(seen.sessionNew?.error)).toBeUndefined()
    expect(seen.wrapperRan, 'the adapter did not start the executable CLAUDE_CODE_EXECUTABLE names').toBe(true)
  })

  it(entry('claude.launch.child-env'), () => {
    // The whole of both scenarios ran on `baseEnv()` + HOME + what the harness
    // adds: a completed conversation turn is the evidence.
    expect(conversation(seen.folderTurns).length).toBeGreaterThan(0)
    expect(seen.firstPromptUpdates.some((update) => update.sessionUpdate === 'agent_message_chunk')).toBe(true)
  })

  it.skip(entry('claude.launch.autoupdater-disabled'), () => undefined)

  it(entry('claude.launch.subprocess-env-scrub'), () => {
    const { on, off } = seen.scrub
    // The control: without the scrub the agent's own Bash prints the key.
    expect(off?.scrubbed).toBe(false)
    expect(off?.results.printenv, 'the control run never printed its environment').toContain(SCRUB_PRINTENV_END)
    expect(off?.keyInPrintenv, 'the control run did not leak the key, so the check below proves nothing').toBe(true)
    // With it, the same command runs and the key is not in what it returned.
    expect(on?.scrubbed).toBe(true)
    expect(on?.results.printenv, `the scrubbed run never printed its environment: ${JSON.stringify(on)}`).toContain(SCRUB_PRINTENV_END)
    expect(on?.keyInPrintenv, 'the key reached the agent’s own Bash under the scrub').toBe(false)
  })

  it(entry('claude.launch.subprocess-env-scrub-modes'), () => {
    const on = seen.scrub.on
    expect(on?.setModes, JSON.stringify(on?.error ?? null)).toEqual({ auto: true, default: true })
    // `auto` took: its Bash call raised no ask, exactly as without the scrub.
    expect(on?.asks.auto, `auto mode still asked under the scrub: ${on?.results.auto}`).toBe(0)
    // In `default` the native calls still come to the desktop to answer.
    expect(on?.asks.printenv, 'a Bash call in default mode raised no ACP ask under the scrub').toBe(1)
    expect(on?.asks).toMatchObject({ auto: 0, printenv: 1, bash: 1, write: 1 })
    expect(on?.asks).toEqual(seen.scrub.off?.asks)
  })

  it(entry('claude.launch.subprocess-env-scrub-mcp'), () => {
    const { on, off } = seen.scrub
    // Who spawns a stdio MCP server: the CLI (`--mcp-config` from the SDK), not the adapter's node process.
    expect(off?.mcpParent, `MCP result: ${off?.results.mcp}`).toContain(binary)
    // The control: without the scrub the MCP server inherits the key.
    expect(off?.results.mcp, `the control run's MCP tool never answered: ${JSON.stringify(off?.error ?? null)}`).toContain(SCRUB_MCP_END)
    expect(off?.keyInMcp, 'the control run’s MCP server did not hold the key, so the check below proves nothing').toBe(true)
    // With it, the same server answers and holds no key.
    expect(on?.results.mcp, `the scrubbed run's MCP tool never answered: ${JSON.stringify(on?.error ?? null)}`).toContain(SCRUB_MCP_END)
    expect(on?.mcpParent).toContain(binary)
    expect(on?.keyInMcp, `the key reached a stdio MCP server under the scrub: ${on?.results.mcp.split('\n')[0]}`).toBe(false)
  })

  it(entry('claude.launch.subprocess-env-scrub-tools'), () => {
    const on = seen.scrub.on
    expect(on?.error ?? null).toBeNull()
    expect(on?.bashFile, `Bash result: ${on?.results.bash}`).toBe(`${SCRUB_BASH_TEXT}\n`)
    expect(on?.results.bash).toContain(SCRUB_BASH_TEXT)
    expect(on?.writeFile, `Write result: ${on?.results.write}`).toBe(`${SCRUB_WRITE_TEXT}\n`)
  })

  /* auth */
  it(entry('claude.auth.status-json'), () => {
    const loggedOut = JSON.parse(seen.authLoggedOut.stdout) as Json
    expect(loggedOut).toMatchObject({ loggedIn: false, authMethod: 'none' })
    expect(parseClaudeAuthStatus(seen.authLoggedOut.stdout)).toEqual({ state: 'logged_out', authMethod: 'none', subscriptionType: null, email: null })
    // The other half of the shape, from the same binary: a login is `loggedIn: true` and names its method.
    const withKey = JSON.parse(seen.authWithKey.stdout) as Json
    expect(withKey).toMatchObject({ loggedIn: true, authMethod: 'api_key' })
    expect(parseClaudeAuthStatus(seen.authWithKey.stdout).state).toBe('logged_in')
  })

  it.skip(entry('claude.auth.login-follows-home'), () => undefined)

  /* session lifecycle */
  it(entry('claude.session.initialize'), () => {
    const result = (seen.initialize?.result ?? {}) as Json
    expect(result.protocolVersion).toBe(1)
    expect(result.agentInfo).toMatchObject({ name: '@agentclientprotocol/claude-agent-acp', version: RUNTIME_PINS.claude.adapter })
    expect(result.agentCapabilities).toMatchObject({ loadSession: true, mcpCapabilities: { http: true } })
    // Answered as to a plain client: the AIR UI's advertisement is gone with `air.client` (the adapter patch).
    expect(result._meta).toMatchObject({ steering: { supported: true } })
    expect(result._meta).not.toHaveProperty('jetbrains')
  })

  it(entry('claude.session.options-system-prompt'), () => {
    const first = conversation(seen.folderTurns)[0]
    expect(first?.systemText).toContain(SYSTEM_MARKER)
    expect(first?.systemText).not.toMatch(PRESET_TEXT)
  })

  it(entry('claude.session.options-setting-sources'), () => {
    expect(seen.isolatedMentionsClaudeMd, 'settingSources: [] let the project CLAUDE.md into an isolated session').toBe(false)
    expect(seen.nativeMentionsClaudeMd, 'the native branch did not load the project CLAUDE.md').toBe(true)
  })

  it(entry('claude.session.options-agents'), () => {
    const first = conversation(seen.folderTurns)[0]
    expect(first?.tools).toContain('Agent')
    expect(first?.mentions(SUBAGENT), 'the subagent passed in `agents` was not offered to the model').toBe(true)
  })

  it(entry('claude.session.options-plugins'), () => {
    expect(seen.pluginSkill.isolated, 'the plugin skill did not reach an isolated (`settingSources: []`) session').toBe(true)
    expect(seen.pluginSkill.native, 'the plugin skill did not reach a native session').toBe(true)
  })

  it(entry('claude.session.options-plugins-agent-skills'), () => {
    expect(seen.pluginSkill.isolated, 'cinna-tasks no longer loads beside a second plugin').toBe(true)
    expect(seen.agentSkillOffered, `the linked skill was not offered as \`${AGENT_SKILL_QUALIFIED}\` in an isolated session`).toBe(true)
  })

  it(entry('claude.session.set-mode'), () => {
    expect(seen.setModes).toEqual({ auto: true, default: true })
    expect((seen.sessionNew?.result?.modes as Json | undefined)?.currentModeId).toEqual(expect.any(String))
  })

  it(entry('claude.session.permission-mode-meta-inert'), () => {
    expect(seen.policyOptions).toMatchObject({ permissionMode: 'bypassPermissions' })
    expect(seen.bypassInMetaMode).toBe('default')
  })

  it(entry('claude.session.model-over-user-settings'), () => {
    expect(seen.model.error, JSON.stringify(seen.model.error)).toBeNull()
    // The finding: `options.model` loses to the user's settings.json — reported and run.
    expect(seen.model.startedOn).toBe('sonnet')
    expect(seen.model.before.length).toBeGreaterThan(0)
    expect(seen.model.before.every((model) => /sonnet/i.test(model)),
      `before the re-assert the turn ran on ${seen.model.before.join(', ')} — options.model may now win on its own`).toBe(true)
    // The fix: the alias resolves among the offered values, the set is accepted, and the conversation moves.
    expect(seen.model.resolved).toBe(AGENT_MODEL)
    expect(seen.model.set).toBe(true)
    expect(seen.model.after.length).toBeGreaterThan(0)
    expect(seen.model.after.every((model) => /haiku/i.test(model)), seen.model.after.join(', ')).toBe(true)
  })

  it(entry('claude.session.load-replay'), () => {
    expect(seen.load.ok).toBe(true)
    expect(seen.load.replayed).toEqual(expect.arrayContaining(['user_message_chunk', 'agent_message_chunk', 'tool_call']))
    // The prompt after the load carried the earlier turns: the same conversation, not a new one.
    expect(seen.load.continuedUserMessages).toBeGreaterThan(1)
  })

  it(entry('claude.session.costed-usage-ends-turn'), () => {
    const usage = seen.firstPromptUpdates.filter((update) => update.sessionUpdate === 'usage_update')
    expect(usage.at(-1)).toHaveProperty('cost')
  })

  it(entry('claude.session.context-usage'), () => {
    expect(seen.contextUsage?.error, JSON.stringify(seen.contextUsage?.error)).toBeUndefined()
    const result = (seen.contextUsage?.result ?? null) as Json | null
    expect(result).not.toBeNull()
    expect(result).not.toHaveProperty('gridRows')
    const reading = readContextCategories(result)
    expect(reading, 'the answer lost a field the desktop reads').not.toBeNull()
    expect(reading!.categories.length).toBeGreaterThan(0)
    expect(reading!.categories.every((category) => category.name !== '' && category.tokens >= 0)).toBe(true)
    expect(reading!.totalTokens).toBeGreaterThan(0)
    expect(reading!.maxTokens).toBeGreaterThan(0)
    expect(reading!.model).not.toBe('')
    expect((seen.contextUsageUnknown?.error as Json | undefined)?.code).toBe(-32602)
    // It counts tokens with the provider (the CLI's `count_tokens`), and sends no Messages request.
    expect(seen.contextUsageTraffic.messages).toBe(0)
    expect([...new Set(seen.contextUsageTraffic.other)]).toEqual(['POST /v1/messages/count_tokens'])
  })

  it(entry('claude.session.air-activity'), () => {
    expect(seen.tools.error, JSON.stringify(seen.tools.error)).toBeNull()
    expect(seen.tools.activityKinds).toEqual(expect.arrayContaining(['async_task_spawned', 'async_task_state_update', 'subagent_spawned', 'subagent_state_update']))
    expect(seen.tools.activity.find((update) => update.sessionUpdate === 'async_task_spawned')).toMatchObject({ asyncTaskId: expect.any(String) })
    expect(seen.tools.activity.find((update) => update.sessionUpdate === 'subagent_spawned')).toMatchObject({ subagentSessionId: expect.any(String) })
  })

  /* tools & MCP */
  it(entry('claude.tools.read-result-text'), () => {
    expect(seen.tools.error, JSON.stringify(seen.tools.error)).toBeNull()
    const done = seen.tools.read.find((update) => update.status === 'completed')
    expect(done, `the Read never completed: ${JSON.stringify(seen.tools.read)}`).toBeDefined()
    expect(outputText(done!), 'the Read result reached the client without the file text').toContain(READ_MARKER)
  })

  it(entry('claude.tools.edit-raw-input'), () => {
    expect(seen.tools.error, JSON.stringify(seen.tools.error)).toBeNull()
    const first = seen.tools.edit[0]
    expect(first?.sessionUpdate).toBe('tool_call')
    // The AIR UI shape leaves `rawInput` off the first report and the edit's text out of every one.
    expect(first).toHaveProperty('rawInput')
    const full = (update: Json | undefined): boolean => {
      const input = (update?.rawInput ?? {}) as Json
      return input.old_string === EDIT_OLD && input.new_string === EDIT_NEW
    }
    expect(seen.tools.edit.some(full), `no Edit update carried old_string/new_string: ${JSON.stringify(seen.tools.edit)}`).toBe(true)
    const ask = seen.tools.permissions.find((request) => (request.params?.toolCall as Json | undefined)?.toolCallId === first?.toolCallId)
    expect(ask, 'the Edit did not ask first in default mode').toBeDefined()
    expect(full(ask?.params?.toolCall as Json | undefined), `the ask's rawInput: ${JSON.stringify((ask?.params?.toolCall as Json | undefined)?.rawInput)}`).toBe(true)
    // `allow_once` ran it.
    expect(seen.tools.fileAfterEdit).toContain(EDIT_NEW)
  })

  it(entry('claude.mcp.session-injection'), () => {
    expect(seen.policyOptions).toMatchObject({ strictMcpConfig: true, mcpServers: {} })
    expect(conversation(seen.policyTurns)[0]?.tools).toContain('mcp__cinna__probe')
    expect(seen.mcpCalls[0]?.name).toBe('probe')
  })

  it(entry('claude.mcp.tool-naming'), () => {
    expect(conversation(seen.policyTurns)[0]?.tools).toEqual(['mcp__cinna__probe'])
    const call = seen.toolCallUpdates.find((update) => update.sessionUpdate === 'tool_call')
    expect(cinnaToolName(call?.title as string, call?.rawInput)).toBe('probe')
  })

  it(entry('claude.mcp.tool-name-meta'), () => {
    expect(seen.toolCallUpdates.length).toBeGreaterThan(1)
    for (const update of seen.toolCallUpdates.slice(0, 4)) {
      expect(((update._meta as Json | undefined)?.claudeCode as Json | undefined)?.toolName).toBe('mcp__cinna__probe')
    }
  })

  it(entry('claude.mcp.tool-use-id'), () => {
    const call = seen.toolCallUpdates.find((update) => update.sessionUpdate === 'tool_call')
    // `conductorMcpServer` uses the claude id when `_meta["claudecode/toolUseId"]`
    // carries one and invents `cinna-<uuid>` when it does not.
    expect(seen.mcpCalls[0]?.toolCallId).not.toMatch(/^cinna-/)
    expect(seen.mcpCalls[0]?.toolCallId).toBe(call?.toolCallId)
  })

  it(entry('claude.mcp.list-changed-adopted'), () => {
    expect(seen.toolsAfterListChanged).toEqual(['mcp__cinna__probe', 'mcp__cinna__probe_added'])
  })

  /* permissions & questions */
  it(entry('claude.permission.request-shape'), () => {
    const params = (seen.permission?.params ?? {}) as Json
    expect(params.toolCall).toMatchObject({ toolCallId: expect.any(String), title: 'mcp__cinna__probe', rawInput: {} })
    expect(((params.options as Json[] | undefined) ?? []).map((option) => option.kind).sort()).toEqual(['allow_always', 'allow_once', 'reject_once'])
    // `allow_once` ran the call, and the model got its result.
    expect(seen.policyTurns.flatMap((turn) => turn.toolResults)).toContain('OK')
  })

  it(entry('claude.permission.deny-continues'), () => {
    expect(seen.deny.asks.length, 'the Bash call raised no ask').toBe(1)
    const sent = ((seen.deny.asks[0].params?.options as Json[] | undefined) ?? []).find((option) => option.optionId === seen.deny.sent[0])
    expect(sent?.kind).toBe('reject_once')
    expect(seen.deny.ran, 'the refused command ran').toBe(false)
    // The same prompt went on: a second request carrying the refusal, then the end.
    expect(seen.deny.turns.length).toBe(2)
    expect(seen.deny.turns[1].toolResults.at(-1)).toContain('User refused permission to run tool')
    expect(seen.deny.answer?.error).toBeUndefined()
    expect(seen.deny.answer?.result?.stopReason).toBe('end_turn')
  })

  it(entry('claude.question.elicitation-form'), () => {
    expect(conversation(seen.folderTurns)[0]?.tools).toContain('AskUserQuestion')
    const params = (seen.question.request?.params ?? {}) as Json
    expect(params).toMatchObject({ mode: 'form', message: 'Deterministic?' })
    const property = ((params.requestedSchema as Json | undefined)?.properties as Json | undefined)?.question_0 as Json | undefined
    expect(((property?.oneOf as Json[] | undefined) ?? []).map((option) => option.const)).toEqual(['Yes', 'No'])
    // One question asked is one question shown: the adapter's free-text companion is not another.
    expect(toInputQuestions(params as never)?.fields.map((field) => field.key)).toEqual(['question_0'])
    expect(seen.question.toolResults.some((result) => /Yes/.test(result)), `tool results: ${JSON.stringify(seen.question.toolResults)}`).toBe(true)
  })

  /* cancellation */
  it(entry('claude.cancel.reaches-mcp-call'), () => {
    expect(seen.cancel.stopReason).toBe('cancelled')
    expect(seen.cancel.ms).toBeLessThan(10_000)
    expect(seen.mcpCalls.at(-1)?.aborted, 'Stop ended the prompt but the MCP call was left running').toBe(true)
  })

  /* restricted chat policy */
  it(entry('claude.policy.no-native-tools'), () => {
    expect(seen.policyOptions).toMatchObject({ tools: [] })
    const offered = new Set(conversation(seen.policyTurns).flatMap((turn) => turn.tools))
    expect([...offered].filter((name) => !name.startsWith('mcp__cinna__'))).toEqual([])
    // And it is that option doing it: the folder session, without it, gets the native set.
    expect(conversation(seen.folderTurns)[0]?.tools).toEqual(expect.arrayContaining(NATIVE_TOOLS))
  })

  /* provider traffic */
  it(entry('claude.provider.base-url'), () => {
    const all = [...seen.folderTurns, ...seen.policyTurns]
    expect(all.length).toBeGreaterThan(5)
    expect([...new Set(all.map((turn) => `${turn.method} ${turn.path}`))]).toEqual(['POST /v1/messages'])
    expect([...new Set(all.map((turn) => turn.apiKey))]).toEqual(['dummy'])
  })

  it(entry('claude.provider.auxiliary-request'), () => {
    const titles = seen.folderTurns.filter((turn) => turn.kind === 'title')
    expect(titles.length).toBeGreaterThanOrEqual(2)
    // Beside the first prompt, before the conversation's own request, carrying the user's message.
    expect(seen.folderTurns[0]?.kind).toBe('title')
    expect(titles[0]?.mentions('CONTRACT_FIRST_MESSAGE_81b')).toBe(true)
    for (const title of titles) {
      expect(title.tools).toEqual([])
      expect(title.model).toBe(conversation(seen.folderTurns)[0]?.model)
      // The agent's own instructions do not travel with it.
      expect(title.systemText).not.toContain(SYSTEM_MARKER)
    }
    // Nothing but titles and the conversation: no compaction, no other endpoint.
    expect([...new Set(seen.otherRequests)]).toEqual([])
  })

  it(entry('claude.provider.no-real-egress'), () => {
    // The trap saw something: an empty list would mean the CLI stopped honouring
    // HTTPS_PROXY, and then "only this host" below would be true of nothing.
    expect(seen.egress.length).toBeGreaterThan(0)
    // Refused before TLS, every one, and only ever this host.
    expect([...new Set(seen.egress)]).toEqual(['api.anthropic.com:443'])
  })

  /* limits */
  it(entry('claude.limits.rate-limit-kind'), () => {
    const error = (seen.rateLimit?.error ?? {}) as Json
    expect(seen.rateLimit?.result).toBeUndefined()
    expect((error.data as Json | undefined)?.errorKind).toBe('rate_limit')
    expect(String(error.message)).toMatch(/429/)
  })

  it.skip(entry('claude.limits.subscription-limit'), () => undefined)

  it(entry('claude.permission.write-outside-cwd'), () => {
    expect(seen.handover?.writes).toHaveLength(2)
    expect(seen.handover?.writes[0]).toMatchObject({ mode: 'default', accepted: true, permissionCount: 1, kinds: ['edit'], wrote: true, promptError: null })
    expect(seen.handover?.writes[1]).toMatchObject({ mode: 'auto', accepted: true, permissionCount: 0, wrote: false, promptError: null })
    expect(seen.handover?.writes[1].outputs.join(' ')).toContain('Auto mode could not evaluate')
  })

  it(entry('claude.mcp.folder-session-load'), () => {
    expect(seen.handover?.mcp).toMatchObject({ nativeTools: true, first: true, second: true, loaded: true, differentDescriptors: true, calls: ['first', 'second', 'first'] })
    expect(seen.handover?.mcp.listReads).toBeGreaterThan(0)
    expect(seen.handover?.mcp.outputs.join(' ')).toContain('HANDOVER_SESSION_first')
    expect(seen.handover?.mcp.outputs.join(' ')).toContain('HANDOVER_SESSION_second')
  })

  // Last on purpose: it reads what every scenario above observed. Not a registry
  // entry — it is the "what changed" report, not an interface.
  it('the observed shapes match the committed snapshot', () => {
    expect(seen.versionOutput, 'the CLI never reported a version, so there is nothing to snapshot').toBeTruthy()
    const observed = JSON.stringify(sorted(snapshot()), null, 2) + '\n'
    const pinnedPath = join(here, 'snapshots', `claude-${RUNTIME_PINS.claude.cli}.json`)
    const pinned = existsSync(pinnedPath) ? readFileSync(pinnedPath, 'utf8') : null

    if (candidate) {
      // A candidate is expected to differ: report, never fail, and never land in the tree.
      const version = seen.versionOutput.replace(/\s*\(Claude Code\)$/, '')
      const directory = join(tmpdir(), 'cinna-contract-snapshots')
      mkdirSync(directory, { recursive: true })
      const path = join(directory, `claude-${version}.json`)
      writeFileSync(path, observed)
      const diff = pinned === null ? '(no pinned snapshot to compare with)' : lineDiff(pinned, observed)
      // Beside the snapshot, for whoever reads the run as files rather than as a log. Empty when nothing changed.
      writeFileSync(path.replace(/\.json$/, '.diff'), diff ? `${diff}\n` : '')
      console.log(`\n--- snapshot diff: claude ${RUNTIME_PINS.claude.cli} -> ${version} (candidate snapshot: ${path})\n${diff || '(no observed change)'}\n`)
      return
    }
    if (writeSnapshot) {
      mkdirSync(dirname(pinnedPath), { recursive: true })
      writeFileSync(pinnedPath, observed)
      return
    }
    expect(pinned, `no committed snapshot at ${pinnedPath} — write it with \`make contract-snapshot ENGINE=claude\``).not.toBeNull()
    const diff = lineDiff(pinned ?? '', observed)
    expect(diff === '', `the pinned CLI no longer matches its committed snapshot (- committed, + observed):\n${diff}\n` +
      'If the change is intended: make contract-snapshot ENGINE=claude').toBe(true)
  })
})
