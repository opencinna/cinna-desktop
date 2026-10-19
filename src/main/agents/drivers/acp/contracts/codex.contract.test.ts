import { beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUNTIME_PINS } from '../../../../../shared/runtimePins'
import { ConductorMcpServer } from '../../../../services/conductorMcpServer'
import { prepareCodexConductorPolicy } from '../codexConductorPolicy'
import { cinnaToolName } from '../conductorToolPolicy'
import { isPromptPlaceholder } from '../acpSessionTitle'
import { parseCodexAuthStatus } from '../codexAuth'
import { airClientMeta, createAcpActivityState, translateActivity } from '../acpActivity'
import { parsePromptTelemetry } from '../acpTelemetry'
import { AcpMessageStream } from '../acpMessages'
import { pickPermissionOption } from '../acpPermissions'
import { KIND_METADATA_KEY, TOOL_NAME_METADATA_KEY, type PartLike } from '../../../streamPartsAccumulator'
import type { PermissionOption, SessionNotification } from '@agentclientprotocol/sdk'
import type { AcpLaunchPlan } from '../acpLaunchers'
import { CODEX_CONTRACT } from './codex.contract'
import { lineDiff, sorted } from './snapshotTools'
import { probeFolderHandovers, handoverProbeSnapshot, type HandoverProbe } from './handoverProbes'
import {
  askAppServer, findContractCodex, makeScratch, runCli, spawnAdapter, startFakeProvider, writeProviderConfig,
  type AdapterConnection, type AdapterMessage, type FakeProvider, type ProviderReply, type ProviderTurn
} from './codexHarness'

/**
 * The Codex interface contract, checked against the **real** CLI.
 *
 * `npm run test:contract` (its own vitest config — never part of `npm test`):
 * the managed pinned binary and the installed, patched ACP adapter, over real
 * stdio, against a loopback fake provider. No login, no credential, no provider
 * request. One `it` per entry of `codex.contract.ts`, its title starting with
 * the entry's id — `contractRegistry.test.ts` holds that mapping.
 *
 * Two scenarios are driven once in `beforeAll` and every `it` asserts on what
 * was observed, because a session costs seconds and twenty-four of them would
 * cost minutes. The same observations, reduced to shapes, are **compared with**
 * the committed `snapshots/codex-<version>.json` (the last test) and written
 * only by `make contract-snapshot`; the diff is the "what changed" report.
 *
 * `CINNA_CONTRACT_CODEX=/abs/path` runs all of it against a candidate binary
 * without touching the pin (`make contract-next ENGINE=codex VERSION=x`).
 */

const here = dirname(fileURLToPath(import.meta.url))
const binaryRef = findContractCodex(RUNTIME_PINS.codex.cli)
const candidate = binaryRef?.source === 'override'
const adapter = createRequire(import.meta.url).resolve('@agentclientprotocol/codex-acp/dist/index.js')

/**
 * No binary is a **failure**, not a skip: `npm run test:contract` exiting 0
 * having checked nothing reads, in a terminal and in CI alike, as "the contract
 * holds". `CINNA_CONTRACT_ALLOW_SKIP=1` is for the machine that knowingly has none.
 */
const allowSkip = process.env['CINNA_CONTRACT_ALLOW_SKIP'] === '1'
const NO_BINARY =
  `The Codex contract needs the managed Codex ${RUNTIME_PINS.codex.cli} and found none — nothing was checked.\n` +
  '  Install it with:  make contract ENGINE=codex   (or: node --experimental-strip-types scripts/install-runtime.mjs codex)\n' +
  '  Or point CINNA_CONTRACT_CODEX at a codex executable.\n' +
  '  To skip knowingly: CINNA_CONTRACT_ALLOW_SKIP=1'
if (!binaryRef && allowSkip) console.warn(`\nSKIPPED: ${NO_BINARY}\n`)

/**
 * The committed snapshot is the baseline, so a run **compares** and only
 * `CINNA_CONTRACT_WRITE_SNAPSHOT=1` (`make contract-snapshot ENGINE=codex`)
 * writes. Rewriting it on every run made "what changed" invisible: the file
 * simply became whatever the last run saw.
 */
const writeSnapshot = process.env['CINNA_CONTRACT_WRITE_SNAPSHOT'] === '1'

const MODEL = 'gpt-5.5'
const NEXT_MODEL = 'gpt-6-astra'
/** The model the CLI names threads on (0.155.0 and 0.162.1 alike). Not configured by Cinna, and not the conversation's. */
const TITLE_MODEL = 'gpt-5.6-luna'
const FIRST_PROMPT = 'Answer OK.'
const NEXT_MODEL_PROMPT = 'Answer OK on the new model.'
const CHAT_FIRST_PROMPT = 'Call the Cinna probe, then answer OK.'
const UTILITY_MARKER = 'CONTRACT_UTILITY_PROMPT_b09'
const UTILITY_PROMPT = 'CONTRACT_UTILITY_INPUT_4d7'
const FOLDER_MARKER = 'CONTRACT_FOLDER_INSTRUCTIONS_7c1'
const POLICY_MARKER = 'CONTRACT_SESSION_PROMPT_e52'
/** What the backgrounded command prints before and after it outlives its turn. */
const STREAM_MARKERS = ['CINNA_STREAM_BEFORE_7a', 'CINNA_STREAM_AFTER_7a'] as const
/** What a restricted session may be offered. Anything else is a native tool that came back. */
const ALLOWED_TOOLS = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource', 'request_user_input'])

type Json = Record<string, unknown>
const keys = (value: unknown): string[] => (value && typeof value === 'object' ? Object.keys(value as Json).sort() : [])
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check: () => boolean, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (check()) return true; await sleep(50) }
  return check()
}

/** Everything the two scenarios observed. Filled by `beforeAll`. */
const seen = {
  handover: null as HandoverProbe | null,
  versionOutput: '', versionStatus: null as number | null,
  login: { status: null as number | null, output: '' },
  features: [] as string[],
  catalog: null as { models: Json[] } | null,
  appServer: [] as AdapterMessage[],
  wrapperRan: false,
  initialize: null as AdapterMessage | null,
  sessionNew: null as AdapterMessage | null,
  setModes: {} as Record<string, boolean>,
  firstTurn: null as ProviderTurn | null,
  /** The folder session's first prompt answer, and the one after the model change. */
  answers: [] as Json[],
  /** Requests (title requests aside) each of those prompts made, in the same order. */
  answerRequests: [] as number[],
  /**
   * The same session resumed on a fresh adapter process after its turns: the
   * last answer before the restart and the first after, and that prompt's requests.
   */
  resumed: { loaded: false, before: null as Json | null, after: null as Json | null, requests: 0 },
  /**
   * A shell command left running when its turn ends, with the launcher's
   * capabilities: every update from its prompt until it completed, how many
   * of them came before the prompt answered, and the prompt's answer.
   */
  command: { updates: [] as Json[], beforeAnswer: 0, answer: null as Json | null, requests: 0 },
  /**
   * A `spawn_agent` call with the launcher's capabilities: every root-session
   * update from the prompt until the subagent's completion arrived, the tools
   * the first request offered, and the provider's outputs for the parent.
   */
  subagent: { updates: [] as Json[], offered: [] as string[], spawnOutputs: [] as string[] },
  /** The same with the model on the V1 collaboration tools (`multi_agent_version: "v1"`, as `gpt-5.6-luna`). */
  subagentV1: { updates: [] as Json[], offered: [] as string[], spawnOutputs: [] as string[] },
  /** Every update of the prompt after the model change, which compacts. */
  modelChangeUpdates: [] as Json[],
  /**
   * Cinna's Deny (`pickPermissionOption(…, 'reject')`) on an escalated command
   * and on an `apply_patch` outside the workspace, one fresh session each: the
   * ask, the option sent, the prompt's answer, the conversation requests the
   * prompt made, and whether the target file was written.
   */
  deny: [] as { name: string; asks: AdapterMessage[]; sent: (string | null)[]; answer: Json | null; requests: number; written: boolean }[],
  permission: null as AdapterMessage | null,
  permissionCount: 0, mcpCalls: 0,
  toolCall: null as Json | null,
  /** Every `session_info_update` title the folder session reported after its first prompt, in order. */
  infoTitles: [] as string[],
  toolsAfterListChanged: [] as string[],
  cancel: { stopReason: null as unknown, ms: 0 },
  load: { ok: false, modeBefore: null as unknown, modeAfter: null as unknown },
  /** Every provider request of the folder session, and the ones from the model change on. */
  folderTurns: [] as ProviderTurn[],
  afterModelChange: [] as ProviderTurn[],
  /** Requests the restricted process made for the utility session alone. */
  utilityTurns: [] as ProviderTurn[],
  rateLimit: null as AdapterMessage | null,
  rateLimitUpdates: [] as Json[],
  policy: {
    marker: null as unknown, configOptionSet: false, turns: [] as ProviderTurn[], firstTools: [] as string[],
    collaborationOption: null as Json | null, defaultAccepted: false,
    questionOutputs: [] as string[], questionClientRequests: [] as string[]
  }
}

const configOption = (message: AdapterMessage | null, id: string): Json | null =>
  ((message?.result?.configOptions as Json[] | undefined) ?? []).find((option) => option.id === id) ?? null

function mcpProvider(tools: () => string[], onCall: () => void): never {
  return { getProviders: () => [{ providerType: 'mcp', displayName: 'contract',
    getTools: () => tools().map((name) => ({ name, description: 'Return literal OK.', inputSchema: { type: 'object', properties: {} }, providerType: 'mcp', mcpProviderId: name })),
    callTool: async () => { onCall(); return { content: 'OK' } } }] } as never
}

/**
 * The CLI's own requests get the answer their shape asks for. A title request
 * answered with plain text leaves the thread untitled, and what the CLI does
 * with an untitled thread is not what a real provider would ever show us.
 */
const CONTRACT_TITLE = 'Contract thread'
const ownRequestReply = (turn: ProviderTurn): ProviderReply =>
  turn.kind === 'title' ? { kind: 'text', text: JSON.stringify({ title: CONTRACT_TITLE }) } : { kind: 'text', text: 'Summary: nothing to hand over.' }

const allowOnce = (request: AdapterMessage): Json | undefined => {
  if (request.method !== 'session/request_permission') return undefined
  const option = ((request.params?.options as Json[] | undefined) ?? []).find((candidateOption) => candidateOption.kind === 'allow_once')
  return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : undefined
}

/* -------------------------------------------------------------- scenario A */

/**
 * A folder-agent-shaped session: the launcher's env and **no MCP servers**, as
 * `codexLauncher` plans it. Cinna's MCP server is only ever injected into a
 * restricted session, so everything about it is observed in scenario B — in an
 * unrestricted one this CLI hides MCP tools behind `tool_search` anyway.
 */
async function folderScenario(binary: string): Promise<void> {
  const scratch = makeScratch('cinna-contract-folder-')
  let provider: FakeProvider | undefined
  let connection: AdapterConnection | undefined
  try {
    let mode: 'text' | 'stall' | 'rate-limit' = 'text'
    let script: ProviderReply[] = []
    provider = await startFakeProvider((turn): ProviderReply => {
      // The CLI's own requests (thread title, compaction) are told apart by
      // content, never by model; only the conversation is scripted, so they
      // cannot consume a scripted step.
      if (turn.kind !== 'conversation') return ownRequestReply(turn)
      const scripted = script.shift()
      if (scripted) return scripted
      if (mode === 'stall') return { kind: 'stall' }
      if (mode === 'rate-limit') return { kind: 'status', status: 429, body: { error: { message: 'Rate limit reached', type: 'rate_limit_exceeded', code: 'rate_limit_exceeded' } } }
      return { kind: 'text', text: 'OK' }
    })
    writeProviderConfig(scratch.codexHome, provider.port, MODEL)
    // CODEX_PATH is proven by a wrapper that leaves a mark before handing over.
    const marker = join(scratch.home, 'codex-path-used')
    const wrapper = join(scratch.home, 'codex-wrapper.sh')
    writeFileSync(wrapper, `#!/bin/sh\necho used >> '${marker}'\nexec '${binary}' "$@"\n`)
    chmodSync(wrapper, 0o700)
    connection = spawnAdapter({
      adapterPath: adapter, cwd: scratch.cwd, answer: allowOnce,
      env: { ...scratch.env, CODEX_PATH: wrapper, INITIAL_AGENT_MODE: 'workspace-write', MODEL_PROVIDER: 'probe',
        CODEX_CONFIG: JSON.stringify({ model: MODEL, model_provider: 'probe', developer_instructions: FOLDER_MARKER, model_reasoning_effort: 'high' }) }
    })
    // Exactly what `codexLauncher` advertises, AIR `asyncTasks` included: what the
    // adapter reports (session failures among it) depends on the client's capabilities.
    seen.initialize = await connection.rpc('initialize', { protocolVersion: 1,
      clientCapabilities: { elicitation: { form: {} }, _meta: airClientMeta(['asyncTasks']) }, clientInfo: { name: 'cinna-desktop', version: '1' } })
    seen.sessionNew = await connection.rpc('session/new', { cwd: scratch.cwd, mcpServers: [] })
    seen.wrapperRan = existsSync(marker)
    const sessionId = String(seen.sessionNew.result?.sessionId ?? '')
    if (!sessionId) return
    for (const modeId of ['agent', 'workspace-write']) {
      seen.setModes[modeId] = !(await connection.rpc('session/set_mode', { sessionId, modeId })).error
    }
    const prompt = (text: string, timeoutMs?: number): Promise<AdapterMessage> =>
      connection!.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, timeoutMs)

    /** Requests of the session from `from` on, the CLI's thread-title requests aside. */
    const requestsSince = (from: number): number => provider!.turns.slice(from).filter((turn) => turn.kind !== 'title').length
    const firstAt = provider.turns.length
    const firstAnswer = await prompt(FIRST_PROMPT)
    seen.answers.push((firstAnswer.result ?? {}) as Json)
    seen.answerRequests.push(requestsSince(firstAt))
    // The title request runs beside the turn, not inside it: give it a moment to land.
    await until(() => provider!.turns.some((turn) => turn.kind === 'title'), 5_000)
    // And the title it produced is reported after that, often after the turn.
    const infoTitles = (): string[] => connection!.updates
      .filter((update) => update.sessionUpdate === 'session_info_update' && typeof update.title === 'string')
      .map((update) => String(update.title))
    await until(() => infoTitles().some((title) => title !== FIRST_PROMPT), 5_000)
    seen.infoTitles = infoTitles()
    seen.firstTurn = provider.turns.find((turn) => turn.kind === 'conversation') ?? null

    // A command that streams, outlives its turn (yielded after 500 ms, the
    // model then answers) and is reported as a background task until it ends.
    script = [
      { kind: 'tool', name: 'exec_command', args: JSON.stringify({ cmd: `printf '${STREAM_MARKERS[0]}\\n'; sleep 2; printf '${STREAM_MARKERS[1]}\\n'`, yield_time_ms: 500, max_output_tokens: 1000 }) },
      { kind: 'text', text: 'started' }
    ]
    const commandUpdatesAt = connection.updates.length
    const commandAt = provider.turns.length
    const commandAnswer = await prompt('Run the command in the background.')
    seen.command.answer = (commandAnswer.result ?? {}) as Json
    seen.command.requests = requestsSince(commandAt)
    seen.command.beforeAnswer = connection.updates.length - commandUpdatesAt
    script = []
    const commandDone = (): boolean => connection!.updates.slice(commandUpdatesAt).some((update) =>
      update.sessionUpdate === 'tool_call_update' && (update.status === 'completed' || update.status === 'failed'))
    await until(commandDone, 15_000)
    await sleep(300)
    seen.command.updates = connection.updates.slice(commandUpdatesAt)

    mode = 'stall'
    const stalledAt = provider.turns.length
    const running = prompt('Wait until cancelled.', 25_000)
    await until(() => provider!.turns.length > stalledAt)
    const cancelledAt = Date.now()
    connection.notify('session/cancel', { sessionId })
    const cancelled = await running
    seen.cancel = { stopReason: cancelled.result?.stopReason ?? cancelled.error ?? null, ms: Date.now() - cancelledAt }
    mode = 'text'

    const plan = await connection.rpc('session/set_config_option', { sessionId, configId: 'collaboration_mode', value: 'plan' })
    seen.load.modeBefore = configOption(plan, 'collaboration_mode')?.currentValue ?? (plan.error ? 'set-failed' : 'plan')
    const loaded = await connection.rpc('session/load', { sessionId, cwd: scratch.cwd, mcpServers: [] })
    seen.load.ok = !loaded.error
    seen.load.modeAfter = configOption(loaded, 'collaboration_mode')?.currentValue ?? null
    await connection.rpc('session/set_config_option', { sessionId, configId: 'collaboration_mode', value: 'default' })

    await connection.rpc('session/set_config_option', { sessionId, configId: 'model', value: NEXT_MODEL })
    const changedAt = provider.turns.length
    const changeUpdatesAt = connection.updates.length
    const nextAnswer = await prompt(NEXT_MODEL_PROMPT)
    seen.answers.push((nextAnswer.result ?? {}) as Json)
    seen.answerRequests.push(requestsSince(changedAt))
    await sleep(1500)
    seen.modelChangeUpdates = connection.updates.slice(changeUpdatesAt)
    seen.afterModelChange = provider.turns.slice(changedAt)
    seen.folderTurns = [...provider.turns]

    // Last: a refused request may leave the session in an error state.
    mode = 'rate-limit'
    const updatesBefore = connection.updates.length
    seen.rateLimit = await prompt('This request is rate limited.')
    await sleep(300)
    seen.rateLimitUpdates = connection.updates.slice(updatesBefore)

    // After everything: the process goes, and the same session is resumed on a
    // fresh one the way the driver resumes a chat after a restart.
    mode = 'text'
    seen.resumed.before = seen.answers[1] ?? null
    await connection.close()
    connection = spawnAdapter({
      adapterPath: adapter, cwd: scratch.cwd, answer: allowOnce,
      env: { ...scratch.env, CODEX_PATH: binary, INITIAL_AGENT_MODE: 'workspace-write', MODEL_PROVIDER: 'probe',
        CODEX_CONFIG: JSON.stringify({ model: MODEL, model_provider: 'probe', developer_instructions: FOLDER_MARKER, model_reasoning_effort: 'high' }) }
    })
    await connection.rpc('initialize', { protocolVersion: 1,
      clientCapabilities: { elicitation: { form: {} }, _meta: airClientMeta(['asyncTasks']) }, clientInfo: { name: 'cinna-desktop', version: '1' } })
    const reloaded = await connection.rpc('session/load', { sessionId, cwd: scratch.cwd, mcpServers: [] })
    seen.resumed.loaded = !reloaded.error
    if (seen.resumed.loaded) {
      await connection.rpc('session/set_config_option', { sessionId, configId: 'model', value: NEXT_MODEL })
      const resumedAt = provider.turns.length
      const resumedAnswer = await connection.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Answer OK after the restart.' }] })
      seen.resumed.after = (resumedAnswer.result ?? null) as Json | null
      seen.resumed.requests = requestsSince(resumedAt)
    }
  } finally {
    await connection?.close()
    await provider?.close()
    scratch.dispose()
  }
}

/* -------------------------------------------------------------- scenario B */

/** A restricted chat, prepared by the production policy helper itself. */
async function policyScenario(binary: string, versionOutput: string): Promise<void> {
  const scratch = makeScratch('cinna-contract-policy-')
  const mcp = new ConductorMcpServer()
  let provider: FakeProvider | undefined
  let connection: AdapterConnection | undefined
  try {
    let tools = ['probe']
    const cinna = await mcp.ensureSession('cinna', mcpProvider(() => tools, () => { seen.mcpCalls++ }))
    // A personal MCP server the user already had: the policy must keep it out.
    const personal = await mcp.ensureSession('unwanted', mcpProvider(() => ['unwanted'], () => undefined))
    let step: 'tool' | 'question' | 'text' = 'text'
    provider = await startFakeProvider((turn): ProviderReply => {
      if (turn.kind !== 'conversation') return ownRequestReply(turn)
      if (step === 'tool') { step = 'text'; return { kind: 'tool', name: 'probe' } }
      if (step === 'question') {
        step = 'text'
        return { kind: 'tool', name: 'request_user_input', args: JSON.stringify({ questions: [{ id: 'q', header: 'Probe', question: 'Deterministic?',
          options: [{ label: 'Yes', description: 'Accept' }, { label: 'No', description: 'Decline' }] }] }) }
      }
      return { kind: 'text', text: 'OK' }
    })
    writeProviderConfig(scratch.codexHome, provider.port, MODEL, [])
    writeFileSync(join(scratch.codexHome, 'config.toml'), readFileSync(join(scratch.codexHome, 'config.toml'), 'utf8') + [
      '[mcp_servers.unwanted]', 'enabled = true', `url = ${JSON.stringify(personal.descriptor.url)}`,
      '[mcp_servers.unwanted.http_headers]', `Authorization = ${JSON.stringify(personal.descriptor.headers[0].value)}`
    ].join('\n') + '\n')
    const plan = {
      spec: { command: process.execPath, args: [adapter], cwd: scratch.cwd, key: 'contract',
        env: { ...scratch.env, CODEX_PATH: binary, INITIAL_AGENT_MODE: 'workspace-write', MODEL_PROVIDER: 'probe',
          CODEX_CONFIG: JSON.stringify({ model: MODEL, model_provider: 'probe', developer_instructions: POLICY_MARKER }) } },
      init: { protocolVersion: 1 }, session: { mcpServers: [] }, setup: { modeId: 'workspace-write' }
    } as unknown as AcpLaunchPlan
    mkdirSync(join(scratch.home, 'policy'))
    const prepared = await prepareCodexConductorPolicy(plan, join(scratch.home, 'policy'), candidate ? {
      // A candidate is by definition not the pinned version. The gate itself is
      // `codex.launch.version-output`'s business; everything *behind* it is what
      // a candidate run exists to check, so the gate alone is told what it
      // expects to hear. Every other inspection still asks the real binary.
      deps: { run: async (input, args) => args[0] === '--version' ? RUNTIME_PINS.codex.versionOutput
        : runCli(input.binary, args, input.env, input.cwd).stdout }
    } : {})
    void versionOutput
    seen.policy.marker = prepared.conductorPolicy
    seen.policy.configOptionSet = (prepared.setup.configOptions ?? []).some((option) => option.configId === 'collaboration_mode' && option.value === 'default')
    connection = spawnAdapter({ adapterPath: adapter, cwd: scratch.cwd, env: prepared.spec.env, answer: (request) => {
      if (request.method === 'session/request_permission') { seen.permissionCount++; seen.permission ??= request }
      return allowOnce(request)
    } })
    await connection.rpc('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'cinna-contract', version: '1' } })
    const created = await connection.rpc('session/new', { cwd: scratch.cwd, mcpServers: [cinna.descriptor], _meta: prepared.session.meta })
    const sessionId = String(created.result?.sessionId ?? '')
    if (!sessionId) return
    seen.policy.collaborationOption = configOption(created, 'collaboration_mode')
    seen.policy.defaultAccepted = !(await connection.rpc('session/set_config_option', { sessionId, configId: 'collaboration_mode', value: 'default' })).error
    const prompt = (text: string): Promise<AdapterMessage> => connection!.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
    step = 'tool'
    await prompt(CHAT_FIRST_PROMPT)
    seen.policy.firstTools = provider.turns.find((turn) => turn.kind === 'conversation')?.tools ?? []
    seen.toolCall = connection.updates.find((update) => update.sessionUpdate === 'tool_call' && cinnaToolName(update.title as string, update.rawInput) === 'probe') ?? null

    // A tool added mid-session, announced the way the app announces it.
    tools = ['probe', 'probe_added']
    await cinna.refreshTools()
    await sleep(1500)
    const beforeSecond = provider.turns.length
    await prompt('Answer OK again.')
    seen.toolsAfterListChanged = provider.turns.slice(beforeSecond).find((turn) => turn.kind === 'conversation')?.tools ?? []

    const beforeQuestion = connection.clientRequests.length
    step = 'question'
    await prompt('Ask a question.')
    seen.policy.turns = [...provider.turns]
    seen.policy.questionOutputs = provider.turns.flatMap((turn) => turn.outputs)
    seen.policy.questionClientRequests = connection.clientRequests.slice(beforeQuestion).map((request) => String(request.method))

    // A utility session in the same warm process, the way an AI function runs:
    // no MCP server, its own system prompt. Recorded apart from the chat's turns.
    const utilityCwd = join(scratch.home, 'utility')
    mkdirSync(utilityCwd)
    const utility = await connection.rpc('session/new', { cwd: utilityCwd, mcpServers: [], _meta: { cinna: { systemPrompt: UTILITY_MARKER } } })
    const utilityId = String(utility.result?.sessionId ?? '')
    if (utilityId) {
      await connection.rpc('session/set_config_option', { sessionId: utilityId, configId: 'collaboration_mode', value: 'default' })
      const beforeUtility = provider.turns.length
      await connection.rpc('session/prompt', { sessionId: utilityId, prompt: [{ type: 'text', text: UTILITY_PROMPT }] })
      await until(() => provider!.turns.slice(beforeUtility).some((turn) => turn.kind === 'title'), 5_000)
      seen.utilityTurns = provider.turns.slice(beforeUtility)
    }
  } finally {
    await connection?.close()
    await mcp.dispose()
    await provider?.close()
    scratch.dispose()
  }
}

/* -------------------------------------------------------------- scenario C */

/** The subagent the fake model spawns, and the root path the CLI gives it. */
const SUBAGENT_NAME = 'helper'

/** What the V1 subagent answers, which only its `wait` carries to the client. */
const SUBAGENT_REPORT = 'HELPER REPORT'

/**
 * A folder session whose model spawns a subagent, waits for it, and answers.
 * The fake model's catalog entry names no `multi_agent_version`, so the CLI
 * would offer it no agent tool; it is given `v2`, which most bundled real
 * models carry, or `v1`, which `gpt-5.6-luna` carries. The child's own
 * request is answered with text at once (V1: with {@link SUBAGENT_REPORT}).
 * V1's agent tools are deferred behind `tool_search`, as the real model found
 * them (by searching its code-mode `ALL_TOOLS`).
 */
async function subagentScenario(binary: string, version: 'v1' | 'v2' = 'v2'): Promise<void> {
  const into = version === 'v1' ? seen.subagentV1 : seen.subagent
  const scratch = makeScratch('cinna-contract-subagent-')
  let provider: FakeProvider | undefined
  let connection: AdapterConnection | undefined
  try {
    let spawned = false
    let waited = false
    let searched = false
    provider = await startFakeProvider((turn): ProviderReply => {
      if (turn.kind !== 'conversation') return ownRequestReply(turn)
      if (version === 'v1') {
        // V1's agent tools are deferred: the parent finds them with tool_search,
        // then spawns and waits on the id; the child, which has no spawn tool, answers.
        if (!searched) {
          searched = true
          return { kind: 'tool-search', args: { query: 'spawn agent', limit: 5 } }
        }
        if (!turn.tools.some((name) => name.endsWith('spawn_agent'))) return { kind: 'text', text: SUBAGENT_REPORT }
        if (!spawned) {
          spawned = true
          into.offered = turn.tools
          return { kind: 'tool', name: 'spawn_agent', args: JSON.stringify({ message: 'Answer done.' }) }
        }
        if (!waited) {
          waited = true
          into.spawnOutputs = turn.outputs
          const spawn = JSON.parse(turn.outputs.at(-1) ?? '{}') as Json
          return { kind: 'tool', name: 'wait_agent', args: JSON.stringify({ targets: [spawn.agent_id], timeout_ms: 15_000 }) }
        }
        return { kind: 'text', text: 'OK' }
      }
      // The parent's first request spawns; the child's (no output yet, after the spawn) answers.
      if (!spawned) {
        spawned = true
        into.offered = turn.tools
        return { kind: 'tool', name: 'spawn_agent', args: JSON.stringify({ task_name: SUBAGENT_NAME, message: 'Answer done.' }) }
      }
      if (turn.pendingOutputs === 1 && !waited) {
        waited = true
        into.spawnOutputs = turn.outputs
        return { kind: 'tool', name: 'wait_agent', args: JSON.stringify({ timeout_ms: 15_000 }) }
      }
      return { kind: 'text', text: turn.pendingOutputs === 0 ? 'done' : 'OK' }
    })
    const catalog = JSON.parse(runCli(binary, ['debug', 'models', '--bundled'], scratch.env, scratch.cwd).stdout) as { models: Json[] }
    for (const model of catalog.models) if (model.slug === MODEL) model.multi_agent_version = version
    const catalogPath = join(scratch.home, 'catalog.json')
    writeFileSync(catalogPath, JSON.stringify(catalog))
    writeProviderConfig(scratch.codexHome, provider.port, MODEL, [`model_catalog_json = ${JSON.stringify(catalogPath)}`])
    connection = spawnAdapter({
      adapterPath: adapter, cwd: scratch.cwd, answer: allowOnce,
      env: { ...scratch.env, CODEX_PATH: binary, INITIAL_AGENT_MODE: 'workspace-write', MODEL_PROVIDER: 'probe',
        CODEX_CONFIG: JSON.stringify({ model: MODEL, model_provider: 'probe' }) }
    })
    await connection.rpc('initialize', { protocolVersion: 1,
      clientCapabilities: { elicitation: { form: {} }, _meta: airClientMeta(['asyncTasks']) }, clientInfo: { name: 'cinna-desktop', version: '1' } })
    const created = await connection.rpc('session/new', { cwd: scratch.cwd, mcpServers: [] })
    const sessionId = String(created.result?.sessionId ?? '')
    if (!sessionId) return
    await connection.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Spawn a helper, wait for it, then answer OK.' }] }, 45_000)
    // The subagent's completion is its own item, and may follow the turn. V1 has no such item: its wait ends with the prompt.
    if (version === 'v2') {
      await until(() => connection!.updates.some((update) => update.sessionUpdate === 'tool_call'
        && (update.rawInput as Json | undefined)?.activityKind === 'completed'), 15_000)
    }
    await sleep(300)
    into.updates = [...connection.updates]
  } finally {
    await connection?.close()
    await provider?.close()
    scratch.dispose()
  }
}

/* -------------------------------------------------------------- scenario D */

/** Cinna's Deny on Codex's two approval kinds, in `workspace-write`. */
async function denyScenario(binary: string): Promise<void> {
  const scratch = makeScratch('cinna-contract-deny-')
  let provider: FakeProvider | undefined
  let connection: AdapterConnection | undefined
  try {
    let script: ProviderReply[] = []
    provider = await startFakeProvider((turn): ProviderReply =>
      turn.kind !== 'conversation' ? ownRequestReply(turn) : (script.shift() ?? { kind: 'text', text: 'AFTER_DENY' }))
    writeProviderConfig(scratch.codexHome, provider.port, MODEL)
    let asks: AdapterMessage[] = [], sent: (string | null)[] = []
    connection = spawnAdapter({
      adapterPath: adapter, cwd: scratch.cwd,
      answer: (request) => {
        if (request.method !== 'session/request_permission') return undefined
        asks.push(request)
        const optionId = pickPermissionOption((request.params?.options ?? []) as PermissionOption[], 'reject')
        sent.push(optionId)
        return optionId ? { outcome: { outcome: 'selected', optionId } } : undefined
      },
      env: { ...scratch.env, CODEX_PATH: binary, INITIAL_AGENT_MODE: 'workspace-write', MODEL_PROVIDER: 'probe',
        CODEX_CONFIG: JSON.stringify({ model: MODEL, model_provider: 'probe' }) }
    })
    await connection.rpc('initialize', { protocolVersion: 1,
      clientCapabilities: { elicitation: { form: {} }, _meta: airClientMeta(['asyncTasks']) }, clientInfo: { name: 'cinna-desktop', version: '1' } })
    const sibling = join(scratch.home, 'sibling')
    mkdirSync(sibling)
    const cases: { name: string; target: string; reply: ProviderReply }[] = [
      { name: 'exec_command', target: join(sibling, 'exec.txt'), reply: { kind: 'tool', name: 'exec_command', args: JSON.stringify({
        cmd: `printf X > '${join(sibling, 'exec.txt')}'`, yield_time_ms: 1000, max_output_tokens: 1000,
        sandbox_permissions: 'require_escalated', justification: 'Write the sibling file.' }) } },
      { name: 'apply_patch', target: join(sibling, 'patch.txt'), reply: { kind: 'custom', name: 'apply_patch',
        input: `*** Begin Patch\n*** Add File: ${join(sibling, 'patch.txt')}\n+X\n*** End Patch\n` } }
    ]
    for (const testCase of cases) {
      const created = await connection.rpc('session/new', { cwd: scratch.cwd, mcpServers: [] }, 60_000)
      const sessionId = String(created.result?.sessionId ?? '')
      if (!sessionId) continue
      await connection.rpc('session/set_mode', { sessionId, modeId: 'workspace-write' })
      asks = []
      sent = []
      script = [testCase.reply]
      const from = provider.turns.length
      const answer = await connection.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: `Write the sibling file with ${testCase.name}.` }] }, 90_000)
      await sleep(1000)
      seen.deny.push({ name: testCase.name, asks, sent, answer: (answer.result ?? answer.error ?? null) as Json | null,
        requests: provider.turns.slice(from).filter((turn) => turn.kind === 'conversation').length, written: existsSync(testCase.target) })
    }
  } finally {
    await connection?.close()
    await provider?.close()
    scratch.dispose()
  }
}

/* ---------------------------------------------------------------- snapshot */

/** Shapes only: no paths, ids, ports, tokens or timestamps, keys sorted, so two versions diff cleanly. */
function snapshot(): Json {
  const init = (seen.initialize?.result ?? {}) as Json
  const created = (seen.sessionNew?.result ?? {}) as Json
  const permission = (seen.permission?.params ?? {}) as Json
  const toolCall = (permission.toolCall ?? {}) as Json
  const rate = (seen.rateLimit?.error ?? {}) as Json
  const catalogModels = seen.catalog?.models ?? []
  const listed = (seen.appServer[2]?.result?.data as Json[] | undefined) ?? []
  return {
    folderHandovers: handoverProbeSnapshot(seen.handover),
    tool: 'codex', version: seen.versionOutput, adapter: RUNTIME_PINS.codex.adapter,
    cli: {
      loginStatusLoggedOut: { exitCode: seen.login.status, verdict: parseCodexAuthStatus(seen.login.output).state },
      featureFlags: [...seen.features].sort(),
      catalogModelFields: [...new Set(catalogModels.flatMap((model) => keys(model)))].sort(),
      catalogSlugs: catalogModels.map((model) => String(model.slug)).sort()
    },
    appServer: {
      initializeResultKeys: keys(seen.appServer[0]?.result),
      configReadKeys: keys((seen.appServer[1]?.result as Json | undefined)?.config),
      modelListFields: [...new Set(listed.flatMap((model) => keys(model)))].sort(),
      defaultModels: listed.filter((model) => model.isDefault === true).map((model) => String(model.id)).sort()
    },
    acp: {
      initialize: { protocolVersion: init.protocolVersion ?? null, agentCapabilities: init.agentCapabilities ?? null,
        authMethodIds: ((init.authMethods as Json[] | undefined) ?? []).map((method) => String(method.id)).sort(), resultKeys: keys(init), metaKeys: keys(init._meta) },
      promptAnswer: { resultKeys: keys(seen.answers[0]), usageKeys: keys(seen.answers[0]?.usage), metaKeys: keys(seen.answers[0]?._meta),
        quotaKeys: keys((seen.answers[0]?._meta as Json | undefined)?.quota),
        tokenCountKeys: keys(((seen.answers[0]?._meta as Json | undefined)?.quota as Json | undefined)?.token_count) },
      command: commandSnapshot(),
      modelChangeUpdateKinds: [...new Set(seen.modelChangeUpdates.map((update) => String(update.sessionUpdate)))].sort(),
      sessionNew: { resultKeys: keys(created),
        modeIds: (((created.modes as Json | undefined)?.availableModes as Json[] | undefined) ?? []).map((mode) => String(mode.id)).sort(),
        currentModeId: (created.modes as Json | undefined)?.currentModeId ?? null,
        configOptionIds: ((created.configOptions as Json[] | undefined) ?? []).map((option) => String(option.id)).sort() },
      folderSessionOfferedTools: [...(seen.firstTurn?.tools ?? [])].sort(),
      sessionInfoTitles: seen.infoTitles.map((title) => title === FIRST_PROMPT ? '<first prompt>' : title === CONTRACT_TITLE ? '<provider title>' : '<other>'),
      toolCall: seen.toolCall ? { title: seen.toolCall.title ?? null, kind: seen.toolCall.kind ?? null,
        rawInput: { ...(seen.toolCall.rawInput as Json | undefined) }, metaKeys: keys(seen.toolCall._meta), updateKeys: keys(seen.toolCall) } : null,
      permissionRequest: { paramKeys: keys(permission), toolCallKeys: keys(toolCall), toolCallKind: toolCall.kind ?? null, toolCallTitle: toolCall.title ?? null,
        rawInputKeys: keys(toolCall.rawInput), optionKinds: ((permission.options as Json[] | undefined) ?? []).map((option) => String(option.kind)).sort(),
        perMcpCall: seen.mcpCalls > 0 && seen.permissionCount >= seen.mcpCalls },
      listChangedAdopted: seen.toolsAfterListChanged.some((name) => name.endsWith('.probe_added')),
      cancel: { stopReason: typeof seen.cancel.stopReason === 'string' ? seen.cancel.stopReason : 'error' },
      loadKeepsCollaborationMode: { before: seen.load.modeBefore, after: seen.load.modeAfter },
      rateLimit: { errorCode: rate.code ?? null, dataKeys: keys(rate.data), errorKind: (rate.data as Json | undefined)?.errorKind ?? null,
        stopReason: seen.rateLimit?.result?.stopReason ?? null,
        updateKinds: [...new Set(seen.rateLimitUpdates.map((update) => String(update.sessionUpdate)))].sort(),
        sessionFailureKinds: [...new Set(failureKinds(seen.rateLimitUpdates))].sort(),
        threadStatusTypes: [...new Set(threadStatusTypes(seen.rateLimitUpdates))].sort(),
        assistantTextNamesStatus: /429/.test(assistantText(seen.rateLimitUpdates)) }
    },
    providerTraffic: {
      paths: [...new Set([...seen.folderTurns, ...seen.policy.turns, ...seen.utilityTurns].map((turn) => turn.path))].sort(),
      title: ownRequests('title'),
      compaction: ownRequests('compaction')
    },
    deny: seen.deny.map((observed) => ({ name: observed.name, asks: observed.asks.length,
      toolCallKind: ((observed.asks[0]?.params?.toolCall ?? {}) as Json).kind ?? null,
      options: ((observed.asks[0]?.params?.options as Json[] | undefined) ?? []).map((option) => `${String(option.kind)}:${String(option.optionId)}`),
      stopReason: observed.answer?.stopReason ?? null, conversationRequests: observed.requests, written: observed.written })),
    restrictedPolicy: {
      marker: seen.policy.marker,
      offeredTools: [...new Set(seen.policy.turns.flatMap((turn) => turn.tools))].sort(),
      collaborationModeValues: (((seen.policy.collaborationOption?.options as Json[] | undefined) ?? []).map((option) => String(option.value ?? option.id))).sort(),
      questionInDefaultMode: seen.policy.questionOutputs.filter((output) => /Default mode/i.test(output)).map((output) => output.slice(0, 120)),
      questionClientRequests: seen.policy.questionClientRequests
    }
  }
}

/** The backgrounded command's updates, reduced to their shapes. */
function commandSnapshot(): Json {
  const updates = seen.command.updates
  const calls = updates.filter((update) => update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
  const opened = calls.find((update) => update.sessionUpdate === 'tool_call')
  const union = (pick: (update: Json) => unknown): string[] => [...new Set(calls.flatMap((update) => keys(pick(update))))].sort()
  const spawned = updates.find((update) => update.sessionUpdate === 'async_task_spawned')
  return {
    updateKinds: [...new Set(updates.map((update) => String(update.sessionUpdate)))].sort(),
    toolCallKeys: keys(opened), toolCallName: opened?.name ?? null, toolCallKind: opened?.kind ?? null,
    updateKeys: union((update) => update), metaKeys: union((update) => update._meta), rawOutputKeys: union((update) => update.rawOutput),
    asyncTaskSpawnedKeys: keys(spawned), asyncTaskType: spawned?.taskType ?? null
  }
}

/** The CLI's own requests of one kind, per kind of session: how many, on which model, offered what. */
function ownRequests(kind: ProviderTurn['kind']): Json {
  const of = (turns: ProviderTurn[]): Json => {
    const found = turns.filter((turn) => turn.kind === kind)
    return { count: found.length, models: [...new Set(found.map((turn) => turn.model))].sort(), tools: [...new Set(found.flatMap((turn) => turn.tools))].sort() }
  }
  return { folderSession: of(seen.folderTurns), restrictedChat: of(seen.policy.turns), utilitySession: of(seen.utilityTurns) }
}

/** Every `kind` of an AIR session-failure object found anywhere in these updates. */
function failureKinds(updates: Json[]): string[] {
  const found: string[] = []
  const walk = (value: unknown, underFailure: boolean): void => {
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value as Json)) {
      const failure = underFailure || /failure/i.test(key)
      if (failure && key === 'kind' && typeof child === 'string') found.push(child)
      walk(child, failure)
    }
  }
  for (const update of updates) walk(update, false)
  return found
}

/** The transcript parts these updates fold into, the way the driver folds them: the last state of each message. */
function foldParts(updates: Json[], sessionId = 's'): PartLike[] {
  const stream = new AcpMessageStream({ launcher: 'codex' })
  const messages = new Map<string, PartLike[]>()
  for (const update of updates) {
    const message = stream.apply({ sessionId, update } as unknown as SessionNotification).message
    if (message) messages.set(message.messageId, message.parts)
  }
  return [...messages.values()].flat()
}

const toolCalls = (updates: Json[]): Json[] => updates.filter((update) => update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
const outputDeltas = (updates: Json[]): string => toolCalls(updates)
  .map((update) => String(((update._meta as Json | undefined)?.terminal_output_delta as Json | undefined)?.data ?? '')).join('')

const threadStatusTypes = (updates: Json[]): string[] => updates
  .map((update) => (((update._meta as Json | undefined)?.codex as Json | undefined)?.threadStatus as Json | undefined)?.type)
  .filter((type): type is string => typeof type === 'string')
const assistantText = (updates: Json[]): string => updates
  .filter((update) => update.sessionUpdate === 'agent_message_chunk')
  .map((update) => String((update.content as Json | undefined)?.text ?? '')).join('')

/* ------------------------------------------------------------------- tests */

const entry = (id: string): string => {
  const found = CODEX_CONTRACT.find((candidateEntry) => candidateEntry.id === id)
  if (!found) throw new Error(`${id} is not in the registry`)
  return `${id} — ${found.expectation}`
}

// Registered only when it applies: a `describe.runIf` guard is still collected
// when the binary IS there, and shows up as an unexplained skip in every run.
if (!binaryRef && !allowSkip) {
  describe('Codex interface contract — no binary', () => {
    it('has a managed Codex to check', () => { throw new Error(NO_BINARY) })
  })
}

describe.skipIf(!binaryRef)('Codex interface contract', () => {
  const binary = binaryRef?.path ?? ''

  beforeAll(async () => {
    const scratch = makeScratch('cinna-contract-cli-')
    try {
      const version = runCli(binary, ['--version'], scratch.env, scratch.cwd)
      seen.versionOutput = version.stdout.trim()
      seen.versionStatus = version.status
      const login = runCli(binary, ['login', 'status'], scratch.env, scratch.cwd)
      seen.login = { status: login.status, output: `${login.stdout}\n${login.stderr}` }
      seen.features = runCli(binary, ['features', 'list'], scratch.env, scratch.cwd).stdout.split('\n')
        .map((line) => line.trim().split(/\s+/)[0]).filter((name) => /^[a-z][a-z0-9_]*$/.test(name ?? ''))
      try { seen.catalog = JSON.parse(runCli(binary, ['debug', 'models', '--bundled'], scratch.env, scratch.cwd).stdout) } catch { seen.catalog = null }
      seen.appServer = await askAppServer(binary, scratch.env, scratch.cwd, [
        { method: 'initialize', params: { clientInfo: { name: 'cinna-contract', version: '1' }, capabilities: { experimentalApi: true } } },
        { method: 'config/read', params: { includeLayers: false, cwd: scratch.cwd } },
        { method: 'model/list', params: { includeHidden: true } }
      ])
    } finally { scratch.dispose() }
    await folderScenario(binary)
    await policyScenario(binary, seen.versionOutput)
    await subagentScenario(binary)
    await subagentScenario(binary, 'v1')
    await denyScenario(binary)
    seen.handover = await probeFolderHandovers('codex', binary, adapter)
  }, 300_000)


  it(entry('codex.launch.version-output'), () => {
    expect(seen.versionStatus).toBe(0)
    expect(seen.versionOutput).toMatch(/^codex-cli \d+\.\d+\.\d+\S*$/)
    // A candidate run is *for* another version; the pinned run must be the pin.
    if (!candidate) expect(seen.versionOutput).toBe(RUNTIME_PINS.codex.versionOutput)
  })

  it(entry('codex.launch.codex-path'), () => {
    expect(seen.sessionNew?.error).toBeUndefined()
    expect(seen.wrapperRan).toBe(true)
  })

  it(entry('codex.launch.codex-config'), () => {
    expect(seen.firstTurn).toMatchObject({ model: MODEL, reasoningEffort: 'high' })
    expect(seen.firstTurn?.systemText).toContain(FOLDER_MARKER)
    expect(seen.firstTurn?.userText).not.toContain(FOLDER_MARKER)
  })

  it(entry('codex.launch.initial-agent-mode'), () => {
    expect((seen.sessionNew?.result?.modes as Json | undefined)?.currentModeId).toBe('workspace-write')
  })

  it(entry('codex.auth.login-status'), () => {
    expect(seen.login.status).not.toBe(0)
    expect(seen.login.output).toMatch(/^Not logged in\s*$/m)
    // The owner's own parser must reach the verdict readiness refuses on.
    expect(parseCodexAuthStatus(seen.login.output)).toEqual({ state: 'logged_out' })
  })

  it(entry('codex.session.initialize'), () => {
    expect(seen.initialize?.error).toBeUndefined()
    expect(seen.initialize?.result?.protocolVersion).toBe(1)
    expect((seen.initialize?.result?.agentCapabilities as Json | undefined)?.loadSession).toBe(true)
  })

  it(entry('codex.session.modes'), () => {
    const ids = (((seen.sessionNew?.result?.modes as Json | undefined)?.availableModes as Json[] | undefined) ?? []).map((mode) => mode.id)
    expect(ids).toEqual(expect.arrayContaining(['read-only', 'workspace-write', 'agent', 'agent-full-access']))
    expect(seen.setModes).toEqual({ agent: true, 'workspace-write': true })
  })

  it(entry('codex.session.load'), () => {
    expect(seen.load.ok).toBe(true)
    expect(seen.load.modeAfter).toBe('plan')
  })

  it(entry('codex.session.system-prompt-meta'), () => {
    const conversation = seen.policy.turns.filter((turn) => turn.kind === 'conversation')
    expect(conversation.length).toBeGreaterThan(0)
    expect(conversation.every((turn) => turn.systemText.includes(POLICY_MARKER))).toBe(true)
    expect(conversation.some((turn) => turn.userText.includes(POLICY_MARKER))).toBe(false)
  })

  it(entry('codex.session.prompt-usage'), () => {
    // The fake provider answers every request with 1 input and 1 output token.
    const expectUsage = (answer: Json | null, requests: number, label: string): void => {
      expect(requests, label).toBeGreaterThan(0)
      const meta = (answer?._meta ?? {}) as Json
      const quota = (meta.quota ?? {}) as Json
      expect(answer?.usage, label).toMatchObject({ inputTokens: requests, outputTokens: requests, totalTokens: 2 * requests })
      expect(quota.token_count, label).toMatchObject({ inputTokens: requests, outputTokens: requests, totalTokens: 2 * requests, cacheWriteInputTokens: 0 })
      expect(quota.model_usage, label).toEqual([{ model: expect.any(String), token_count: quota.token_count }])
      // No running total beside it any more.
      expect(keys(quota), label).toEqual(['model_usage', 'token_count'])
      // Our reader: the turn's own tokens, scope turn.
      expect(parsePromptTelemetry(answer, 'codex'), label).toMatchObject({ tokens: { input: requests, output: requests }, tokenScope: 'turn' })
    }
    expectUsage(seen.answers[0], seen.answerRequests[0], 'first prompt')
    // A turn that called a tool: both of its requests, not the last one alone.
    expect(seen.command.requests).toBeGreaterThanOrEqual(2)
    expectUsage(seen.command.answer, seen.command.requests, 'command prompt')
    // The model change compacts on the way: that request is the turn's too.
    expectUsage(seen.answers[1], seen.answerRequests[1], 'model-change prompt')
    // Resumed on a fresh process: this prompt alone, not the thread's history.
    expect(seen.resumed.loaded).toBe(true)
    expectUsage(seen.resumed.after, seen.resumed.requests, 'resumed prompt')
  })

  it(entry('codex.session.air-async-tasks'), () => {
    expect((seen.initialize?.result?._meta as Json | undefined)?.jetbrains).toBeUndefined()
    const updates = seen.command.updates
    const opened = updates.find((update) => update.sessionUpdate === 'tool_call')
    const spawned = updates.find((update) => update.sessionUpdate === 'async_task_spawned')
    expect(spawned, JSON.stringify(updates.map((update) => update.sessionUpdate))).toMatchObject({ taskType: 'shell', toolCallId: opened?.toolCallId })
    // Before the prompt answered; the command ended after it.
    expect(updates.indexOf(spawned!)).toBeLessThan(seen.command.beforeAnswer)
    const end = updates.findIndex((update) => update.sessionUpdate === 'tool_call_update' && update.status === 'completed')
    expect(end).toBeGreaterThanOrEqual(seen.command.beforeAnswer)
  })

  it(entry('codex.activity.subagent-shape'), () => {
    const updates = seen.subagent.updates
    expect(seen.subagent.offered).toContain('collaboration.spawn_agent')
    expect(seen.subagent.spawnOutputs.join('\n')).toContain(`/root/${SUBAGENT_NAME}`)
    const kinds = updates.map((update) => String(update.sessionUpdate))
    expect(kinds).not.toContain('subagent_spawned')
    expect(kinds).not.toContain('subagent_state_update')
    const calls = toolCalls(updates)
    const activity = (kind: string): Json | undefined => calls.find((update) => update.sessionUpdate === 'tool_call'
      && (update.rawInput as Json | undefined)?.activityKind === kind)
    const started = activity('started')
    expect(started, JSON.stringify(calls)).toMatchObject({ title: `Start subagent ${SUBAGENT_NAME}`,
      rawInput: { agentPath: `/root/${SUBAGENT_NAME}`, activityKind: 'started' } })
    const thread = String((started?.rawInput as Json | undefined)?.agentThreadId ?? '')
    expect(thread).not.toBe('')
    expect(activity('completed')).toMatchObject({ rawInput: { agentThreadId: thread, agentPath: `/root/${SUBAGENT_NAME}` } })
    const collaboration = calls.find((update) => update.sessionUpdate === 'tool_call' && update.title === 'wait')
    expect(keys(collaboration?.rawInput)).toEqual(expect.arrayContaining(['agentsStates', 'receiverThreadIds', 'senderThreadId']))
    expect(calls.filter((update) => update._meta !== undefined)).toEqual([])
    // Read by the owner: one subagent, running, then completed.
    const state = createAcpActivityState()
    const changes = updates.flatMap((update) => translateActivity({ sessionId: 'root', update } as unknown as SessionNotification, state, 'root'))
    expect(changes).toEqual([
      { type: 'upsert', id: `root:${thread}`, kind: 'subagent', title: SUBAGENT_NAME },
      { type: 'end', id: `root:${thread}`, state: 'completed' }
    ])
  })

  it(entry('codex.activity.collab-v1-shape'), () => {
    const updates = seen.subagentV1.updates
    expect(seen.subagentV1.offered.some((name) => name.endsWith('spawn_agent')), JSON.stringify(seen.subagentV1.offered)).toBe(true)
    const kinds = updates.map((update) => String(update.sessionUpdate))
    expect(kinds).not.toContain('subagent_spawned')
    expect(kinds).not.toContain('subagent_state_update')
    const calls = toolCalls(updates)
    expect(calls.filter((update) => String(update.title ?? '').startsWith('Start subagent')), JSON.stringify(calls)).toEqual([])
    const opened = (title: string): Json | undefined => calls.find((update) => update.sessionUpdate === 'tool_call' && update.title === title)
    const spawn = opened('spawnAgent')
    expect(spawn, JSON.stringify(calls)).toMatchObject({ rawInput: { receiverThreadIds: [] } })
    const spawnEnd = calls.find((update) => update.sessionUpdate === 'tool_call_update' && update.toolCallId === spawn?.toolCallId && update.status === 'completed')
    expect(spawnEnd?.title).toBeUndefined()
    const child = String(((spawnEnd?.rawInput as Json | undefined)?.receiverThreadIds as unknown[] | undefined)?.[0] ?? '')
    expect(child).not.toBe('')
    expect(spawnEnd).toMatchObject({ rawInput: { agentsStates: { [child]: { status: 'pendingInit' } } } })
    const wait = opened('wait')
    const waitEnd = calls.find((update) => update.sessionUpdate === 'tool_call_update' && update.toolCallId === wait?.toolCallId && update.status === 'completed')
    expect(waitEnd?.title).toBeUndefined()
    expect(waitEnd, JSON.stringify(calls)).toMatchObject({ rawInput: { agentsStates: { [child]: { status: 'completed', message: SUBAGENT_REPORT } } } })
    expect(waitEnd?.content ?? []).toEqual([])
    expect(waitEnd?.rawOutput).toBeUndefined()
    expect(calls.filter((update) => update._meta !== undefined)).toEqual([])
    // Read by the owners: one subagent, ended with its report, and the report as the wait call's output.
    const state = createAcpActivityState()
    const changes = updates.flatMap((update) => translateActivity({ sessionId: 'root', update } as unknown as SessionNotification, state, 'root'))
    expect(changes).toEqual([
      { type: 'upsert', id: `root:${child}`, kind: 'subagent', title: 'Answer done.', detail: null },
      { type: 'end', id: `root:${child}`, state: 'completed', summary: SUBAGENT_REPORT }
    ])
    expect(foldParts(updates).filter((part) => part.metadata?.[KIND_METADATA_KEY] === 'tool_result').map((part) => part.text)).toContain(SUBAGENT_REPORT)
  })

  it(entry('codex.session.silent-updates'), () => {
    const updates = seen.modelChangeUpdates
    const kinds = updates.map((update) => String(update.sessionUpdate))
    expect(seen.folderTurns.filter((turn) => turn.kind === 'compaction')).toHaveLength(1)
    expect(kinds).not.toContain('notice')
    expect(kinds).not.toContain('compaction_update')
    const compaction = updates.find((update) => update.sessionUpdate === 'tool_call' && update.kind === 'think')
    expect(compaction).toMatchObject({ title: 'Compact conversation', status: 'in_progress' })
    expect(updates.some((update) => update.sessionUpdate === 'tool_call_update' && update.toolCallId === compaction?.toolCallId && update.status === 'completed')).toBe(true)
    // Folded the way the driver folds them: the step, then the warning and the answer as text.
    const parts = foldParts(updates)
    expect(parts.filter((part) => part.metadata?.[KIND_METADATA_KEY] === 'tool').map((part) => part.text)).toEqual(['Compact conversation'])
    const text = parts.filter((part) => !['tool', 'tool_result', 'thinking'].includes(String(part.metadata?.[KIND_METADATA_KEY]))).map((part) => part.text).join('')
    expect(text).toMatch(/^Warning: /)
    expect(text.endsWith('OK')).toBe(true)
  })

  it(entry('codex.session.info-title'), () => {
    expect(seen.infoTitles).toEqual([FIRST_PROMPT, CONTRACT_TITLE])
    // The owner's own rule tells the two apart.
    expect(isPromptPlaceholder(seen.infoTitles[0], [FIRST_PROMPT])).toBe(true)
    expect(isPromptPlaceholder(seen.infoTitles[1], [FIRST_PROMPT])).toBe(false)
  })

  it(entry('codex.mcp.session-injection'), () => {
    expect(seen.policy.firstTools).toContain('mcp__cinna.probe')
    // Offered *and* reachable: the call went through the descriptor's URL and headers.
    expect(seen.mcpCalls).toBeGreaterThan(0)
  })

  it(entry('codex.mcp.tool-call-naming'), () => {
    expect(seen.toolCall).toMatchObject({ title: 'mcp.cinna.probe', rawInput: { server: 'cinna', tool: 'probe' } })
    // Both spellings must resolve through the owner, on their own.
    expect(cinnaToolName('mcp.cinna.probe')).toBe('probe')
    expect(cinnaToolName(null, seen.toolCall?.rawInput)).toBe('probe')
  })

  it(entry('codex.mcp.list-changed-not-adopted'), () => {
    expect(seen.toolsAfterListChanged).toContain('mcp__cinna.probe')
    // Red here is *good news*: drop `sessionToolsFixed` and its new-session workaround.
    expect(seen.toolsAfterListChanged).not.toContain('mcp__cinna.probe_added')
  })

  it(entry('codex.mcp.inherited-disable-preserved'), () => {
    const offered = seen.policy.turns.flatMap((turn) => turn.tools)
    expect(offered).toContain('mcp__cinna.probe')
    expect(offered.filter((name) => name.includes('unwanted'))).toEqual([])
  })

  it(entry('codex.permission.deny-ends-prompt'), () => {
    expect(seen.deny.map((observed) => observed.name)).toEqual(['exec_command', 'apply_patch'])
    for (const observed of seen.deny) {
      expect(observed.asks.length, `${observed.name}: no approval was asked`).toBe(1)
      const options = (observed.asks[0].params?.options as Json[] | undefined) ?? []
      // The only reject_once Codex offers on a command or file approval is `cancel`.
      expect(options.filter((option) => option.kind === 'reject_once').map((option) => option.optionId), observed.name).toEqual(['cancel'])
      expect(options.map((option) => option.optionId), observed.name).not.toContain('decline')
      expect(observed.sent, observed.name).toEqual(['cancel'])
      expect(observed.answer?.stopReason, observed.name).toBe('cancelled')
      // The refusal ends the prompt: no request after the one that made the call.
      expect(observed.requests, observed.name).toBe(1)
      expect(observed.written, `${observed.name}: the refused write happened`).toBe(false)
    }
  })

  it(entry('codex.permission.mcp-call-asks'), () => {
    expect(seen.mcpCalls).toBeGreaterThan(0)
    expect(seen.permissionCount).toBeGreaterThanOrEqual(seen.mcpCalls)
    // The ask itself does not name the tool: it carries a kind and the id of
    // the `tool_call` update that did. That id is the whole correlation.
    const toolCall = (seen.permission?.params?.toolCall ?? {}) as Json
    expect(toolCall.kind).toBe('execute')
    expect(toolCall.toolCallId).toBeTruthy()
    expect(toolCall.toolCallId).toBe(seen.toolCall?.toolCallId)
    expect(((seen.permission?.params?.options as Json[] | undefined) ?? []).map((option) => option.kind)).toContain('allow_once')
  })

  it(entry('codex.question.unavailable-in-default-mode'), () => {
    expect(seen.policy.questionOutputs.some((output) => /unavailable in Default mode/i.test(output))).toBe(true)
    expect(seen.policy.questionClientRequests.filter((method) => /elicitation/i.test(method))).toEqual([])
  })

  it(entry('codex.cancel.session-cancel'), () => {
    expect(seen.cancel.stopReason).toBe('cancelled')
    expect(seen.cancel.ms).toBeLessThan(10_000)
  })

  it(entry('codex.config.app-server-read'), () => {
    const config = (seen.appServer[1]?.result as Json | undefined)?.config as Json | undefined
    expect(seen.appServer[0]?.error).toBeUndefined()
    expect(config).toBeTruthy()
    expect(keys(config)).toEqual(expect.arrayContaining(['model', 'mcp_servers']))
  })

  it(entry('codex.config.model-list-default'), () => {
    const data = (seen.appServer[2]?.result?.data as Json[] | undefined) ?? []
    expect(data.length).toBeGreaterThan(0)
    expect(data.every((model) => typeof model.id === 'string' && model.id !== '')).toBe(true)
    expect(data.filter((model) => model.isDefault === true)).toHaveLength(1)
  })

  it(entry('codex.config.model-option'), () => {
    // Every *conversation* request from the change on, and there is one. "Some
    // request used the new model" would also pass with the conversation still
    // on the old one; the CLI's own requests are excluded by what they are
    // (`codex.provider.auxiliary-request`), never by which model they are on —
    // the compaction it sends here is on the OLD model by design.
    const conversation = seen.afterModelChange.filter((turn) => turn.kind === 'conversation')
    expect(conversation.length).toBeGreaterThan(0)
    expect(conversation.map((turn) => turn.model)).toEqual(conversation.map(() => NEXT_MODEL))
    expect(conversation.some((turn) => turn.userText.includes(NEXT_MODEL_PROMPT))).toBe(true)
  })

  it(entry('codex.policy.feature-flags'), async () => {
    const source = readFileSync(join(here, '../codexConductorPolicy.ts'), 'utf8')
    const block = /const FEATURES_DISABLED = \[([\s\S]*?)\]/.exec(source)?.[1] ?? ''
    const disabled = [...block.matchAll(/'([a-z0-9_]+)'/g)].map((match) => match[1])
    expect(disabled.length).toBeGreaterThanOrEqual(20)
    expect(disabled.filter((name) => !seen.features.includes(name))).toEqual([])
  })

  it(entry('codex.policy.catalog-fields'), () => {
    const source = readFileSync(join(here, '../codexConductorPolicy.ts'), 'utf8')
    const block = /const CATALOG_POLICY = \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? ''
    const fields = [...block.matchAll(/([a-z_]+):/g)].map((match) => match[1])
    expect(fields.length).toBeGreaterThanOrEqual(8)
    const models = seen.catalog?.models ?? []
    expect(models.length).toBeGreaterThan(0)
    for (const model of models) {
      expect(typeof model.slug === 'string' && typeof model.display_name === 'string' && typeof model.shell_type === 'string', String(model.slug)).toBe(true)
    }
    // Known to the catalog, not present on every model: the policy *adds* a
    // field a model lacks (0.155.0's gpt-5.6-sol has no
    // multi_agent_reasoning_effort), so what would hurt is a field the catalog
    // no longer has anywhere — a rename the override would silently miss.
    const known = new Set(models.flatMap((model) => Object.keys(model)))
    expect(fields.filter((field) => !known.has(field))).toEqual([])
  })

  it(entry('codex.policy.no-native-tools'), () => {
    expect(seen.policy.marker).toBe('no-native-tools')
    expect(seen.policy.turns.length).toBeGreaterThan(0)
    // Every request, the CLI's own auxiliary ones included.
    const native = seen.policy.turns.flatMap((turn) => turn.tools).filter((name) => !ALLOWED_TOOLS.has(name) && !name.startsWith('mcp__cinna.'))
    expect(native).toEqual([])
  })

  it(entry('codex.policy.collaboration-mode'), () => {
    expect(seen.policy.configOptionSet).toBe(true)
    expect(seen.policy.collaborationOption).toBeTruthy()
    expect(seen.policy.defaultAccepted).toBe(true)
  })

  it(entry('codex.provider.auxiliary-request'), () => {
    // Pinned to what 0.155.0 was observed doing (2026-09-18), and 0.162.1 still does, in all three kinds of session.
    const titles = (turns: ProviderTurn[]): ProviderTurn[] => turns.filter((turn) => turn.kind === 'title')
    const chatTurns = seen.policy.turns
    for (const [turns, firstPrompt, instructions] of [
      [seen.folderTurns, FIRST_PROMPT, FOLDER_MARKER],
      [chatTurns, CHAT_FIRST_PROMPT, POLICY_MARKER],
      [seen.utilityTurns, UTILITY_PROMPT, UTILITY_MARKER]
    ] as const) {
      // Once per session, however many turns followed.
      expect(titles(turns), firstPrompt).toHaveLength(1)
      const title = titles(turns)[0]
      expect(title).toMatchObject({ path: '/v1/responses', model: TITLE_MODEL })
      expect(title.userText).toContain(firstPrompt)
      expect(`${title.systemText}\n${title.userText}`).not.toContain(instructions)
    }
    // Beside the first turn: nothing but that turn's conversation came before it.
    const folderTitleAt = seen.folderTurns.findIndex((turn) => turn.kind === 'title')
    expect(seen.folderTurns.slice(0, folderTitleAt).every((turn) => turn.userText.includes(FIRST_PROMPT))).toBe(true)
    expect(titles(seen.folderTurns)[0].tools).toEqual([])
    for (const title of [...titles(chatTurns), ...titles(seen.utilityTurns)]) {
      expect(title.tools.filter((name) => !ALLOWED_TOOLS.has(name) && !name.startsWith('mcp__cinna.'))).toEqual([])
    }

    // Compaction: only on the model change, on the model being left.
    const compactions = seen.folderTurns.filter((turn) => turn.kind === 'compaction')
    expect(compactions).toHaveLength(1)
    expect(seen.afterModelChange).toContain(compactions[0])
    expect(compactions[0]).toMatchObject({ path: '/v1/responses', model: MODEL, tools: [] })
    expect(compactions[0].userText).toContain(FIRST_PROMPT)
    expect(compactions[0].userText).not.toContain(NEXT_MODEL_PROMPT)
    expect([...chatTurns, ...seen.utilityTurns].filter((turn) => turn.kind === 'compaction')).toEqual([])

    // And nothing else: every other request is on a model Cinna chose, at the one endpoint.
    const all = [...seen.folderTurns, ...chatTurns, ...seen.utilityTurns]
    expect([...new Set(all.map((turn) => turn.path))]).toEqual(['/v1/responses'])
    expect([...new Set(all.filter((turn) => turn.kind === 'conversation').map((turn) => turn.model))].sort()).toEqual([MODEL, NEXT_MODEL].sort())
  })

  it(entry('codex.limits.rate-limit-kind'), () => {
    // What this adapter does — which is NOT what `acpDriver` reads. The driver
    // pauses a chat on `error.data.errorKind === 'rate_limit'`, the Claude
    // adapter's shape; Codex ends the prompt normally and reports the failure
    // as an AIR session-failure update instead. Both halves are asserted, so
    // this turns red if either side of that gap moves.
    expect(seen.rateLimit?.error).toBeUndefined()
    expect(seen.rateLimit?.result?.stopReason).toBe('end_turn')
    expect(threadStatusTypes(seen.rateLimitUpdates)).toContain('systemError')
    expect(assistantText(seen.rateLimitUpdates)).toMatch(/429/)
    // No structured failure at all, with the launcher's exact capabilities.
    expect(failureKinds(seen.rateLimitUpdates)).toEqual([])
  })

  it(entry('codex.sandbox.read-outside-workspace'), () => {
    expect(seen.handover?.reads.map(({ outputs: _outputs, updates: _updates, sessionId: _sessionId, ...read }) => read)).toEqual([
      { mode: 'workspace-write', permissionCount: 0, kinds: [], read: true, promptError: null },
      { mode: 'agent', permissionCount: 0, kinds: [], read: true, promptError: null }
    ])
  })
  it(entry('codex.sandbox.write-outside-workspace'), () => {
    expect(seen.handover?.writes.map((write) => write.mode)).toEqual([
      'workspace-write:inside', 'workspace-write', 'workspace-write:escalated', 'agent:inside', 'agent', 'agent:escalated'
    ])
    for (const index of [0, 3]) {
      expect(seen.handover?.writes[index]).toMatchObject({ accepted: true, permissionCount: 0, wrote: true, promptError: null })
    }
    for (const index of [1, 4]) {
      expect(seen.handover?.writes[index]).toMatchObject({ accepted: true, permissionCount: 0, wrote: false, promptError: null })
      expect(seen.handover?.writes[index].outputs.join(' ')).toMatch(/operation not permitted|permission denied/i)
    }
    expect(seen.handover?.writes[2]).toMatchObject({ mode: 'workspace-write:escalated', permissionCount: 1, kinds: ['execute'], wrote: true })
    expect(seen.handover?.writes[5]).toMatchObject({ mode: 'agent:escalated', permissionCount: 0, wrote: false })
    expect(seen.handover?.writes[5].outputs.join(' ')).toContain('Automatic approval review failed')
  })

  it(entry('codex.tool.command-output'), () => {
    const stored = (updates: Json[], sessionId: string): string => foldParts(updates, sessionId)
      .filter((part) => part.metadata?.[KIND_METADATA_KEY] === 'tool_result').map((part) => part.text).join('\n')
    const noTextElsewhere = (updates: Json[], label: string): void => {
      for (const update of toolCalls(updates)) expect(JSON.stringify(update.content ?? []), label).not.toMatch(/CINNA_/)
    }

    // A terminal command, with the launcher's capabilities: the output streams while it runs.
    const command = seen.command.updates
    const opened = toolCalls(command).find((update) => update.sessionUpdate === 'tool_call')
    expect(opened).toMatchObject({ name: 'exec_command', kind: 'execute', content: [{ type: 'terminal' }] })
    const running = toolCalls(command).filter((update) => update.status !== 'completed' && update.status !== 'failed')
    expect(outputDeltas(running)).toContain(STREAM_MARKERS[1])
    const done = toolCalls(command).find((update) => update.status === 'completed')
    expect((done?._meta as Json | undefined)?.terminal_exit).toMatchObject({ exit_code: 0 })
    expect(done?.rawOutput).toMatchObject({ exit_code: 0, formatted_output: expect.stringContaining(STREAM_MARKERS[1]) })
    noTextElsewhere(command, 'terminal command')
    expect(stored(command, 'folder')).toContain(STREAM_MARKERS[1])
    // Named by its title, not by `exec_command`.
    const part = foldParts(command, 'folder').find((candidate) => candidate.metadata?.[KIND_METADATA_KEY] === 'tool')
    expect(part?.metadata?.[TOOL_NAME_METADATA_KEY]).toBe(opened?.title)

    // A read command: no terminal, its whole output on the completing update.
    expect(seen.handover?.reads.length).toBeGreaterThan(0)
    for (const read of seen.handover?.reads ?? []) {
      const end = toolCalls(read.updates).find((update) => update.status === 'completed')
      expect(end?.rawOutput, read.mode).toEqual({ exit_code: 0, formatted_output: expect.stringContaining('CINNA_SKILL_OUTSIDE_READ_OK') })
      expect(outputDeltas(read.updates), read.mode).toContain('CINNA_SKILL_OUTSIDE_READ_OK')
      noTextElsewhere(read.updates, read.mode)
      expect(stored(read.updates, read.sessionId), read.mode).toContain('CINNA_SKILL_OUTSIDE_READ_OK')
    }
  })

  it(entry('codex.tool.command-output-whole'), () => {
    const command = seen.command.updates
    // Why the patch is needed: the first line never streams.
    expect(outputDeltas(command)).toContain(STREAM_MARKERS[1])
    expect(outputDeltas(command)).not.toContain(STREAM_MARKERS[0])
    const done = toolCalls(command).find((update) => update.status === 'completed')
    const whole = String((done?.rawOutput as Json | undefined)?.formatted_output ?? '')
    expect(whole).toBe(`${STREAM_MARKERS[0]}\n${STREAM_MARKERS[1]}\n`)
    // Stored whole, and once: not the fragments beside it.
    const stored = foldParts(command, 'folder').filter((part) => part.metadata?.[KIND_METADATA_KEY] === 'tool_result').map((part) => part.text)
    expect(stored).toEqual([whole])
  })

  it(entry('codex.tool.update-merge'), () => {
    const calls = toolCalls(seen.command.updates)
    expect(calls[0]).toMatchObject({ sessionUpdate: 'tool_call', name: 'exec_command', kind: 'execute', status: 'in_progress',
      content: [{ type: 'terminal' }], rawInput: { command: expect.any(String), cwd: expect.any(String) } })
    expect(typeof calls[0].title).toBe('string')
    const later = calls.slice(1)
    expect(later.length).toBeGreaterThan(1)
    for (const update of later) {
      expect(update.sessionUpdate).toBe('tool_call_update')
      expect(update.title).toBeUndefined()
      expect(update.kind).toBeUndefined()
      expect(update.rawInput).toBeUndefined()
    }
    const done = later.find((update) => update.status === 'completed')
    expect(done).toBeDefined()
    expect(done?.content).toBeUndefined()
  })

  it(entry('codex.tool.mcp-output'), () => {
    const updates = seen.handover?.mcpUpdates ?? []
    const ends = updates.filter((update) => update.sessionUpdate === 'tool_call_update' && (update.status === 'completed' || update.status === 'failed'))
    const failed = ends.filter((update) => update.status === 'failed')
    // The wire: an isError answer is a failed call whose message is in result.content, with no error.
    expect(failed).toHaveLength(1)
    expect(failed[0].content).toBeUndefined()
    expect(failed[0].rawOutput).toMatchObject({ result: { content: [{ type: 'text', text: 'HANDOVER_TOOL_FAILED' }] }, error: null })
    expect(ends.some((update) => JSON.stringify(update.rawOutput).includes('HANDOVER_SESSION_first'))).toBe(true)
    // Our reader stores both as tool_results.
    const stream = new AcpMessageStream({ launcher: 'codex' })
    const texts = updates.flatMap((update) => stream.apply({ sessionId: 'mcp', update } as unknown as SessionNotification).message?.parts ?? [])
      .filter((part) => part.metadata?.[KIND_METADATA_KEY] === 'tool_result').map((part) => part.text).join('\n')
    expect(texts).toContain('HANDOVER_SESSION_first')
    expect(texts).toContain('HANDOVER_TOOL_FAILED')
  })

  it(entry('codex.mcp.folder-session-load'), () => {
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
    const pinnedPath = join(here, 'snapshots', `codex-${RUNTIME_PINS.codex.cli}.json`)
    const pinned = existsSync(pinnedPath) ? readFileSync(pinnedPath, 'utf8') : null

    if (candidate) {
      // A candidate is expected to differ: report, never fail, and never land in the tree.
      const version = seen.versionOutput.replace(/^codex-cli\s+/, '')
      const directory = join(tmpdir(), 'cinna-contract-snapshots')
      mkdirSync(directory, { recursive: true })
      const path = join(directory, `codex-${version}.json`)
      writeFileSync(path, observed)
      const diff = pinned === null ? '(no pinned snapshot to compare with)' : lineDiff(pinned, observed)
      // Beside the snapshot, for whoever reads the run as files rather than as a log. Empty when nothing changed.
      writeFileSync(path.replace(/\.json$/, '.diff'), diff ? `${diff}\n` : '')
      console.log(`\n--- snapshot diff: codex ${RUNTIME_PINS.codex.cli} -> ${version} (candidate snapshot: ${path})\n${diff || '(no observed change)'}\n`)
      return
    }
    if (writeSnapshot) {
      mkdirSync(dirname(pinnedPath), { recursive: true })
      writeFileSync(pinnedPath, observed)
      return
    }
    expect(pinned, `no committed snapshot at ${pinnedPath} — write it with \`make contract-snapshot ENGINE=codex\``).not.toBeNull()
    const diff = lineDiff(pinned ?? '', observed)
    expect(diff === '', `the pinned CLI no longer matches its committed snapshot (- committed, + observed):\n${diff}\n` +
      'If the change is intended: make contract-snapshot ENGINE=codex').toBe(true)
  })
})
