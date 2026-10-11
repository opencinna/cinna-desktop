import { beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUNTIME_PINS } from '../../../../../shared/runtimePins'
import { ConductorMcpServer } from '../../../../services/conductorMcpServer'
import { ANTIGRAVITY_BUILTIN_TOOLS, ANTIGRAVITY_FILTER_TOOLS, ANTIGRAVITY_ISOLATED_DISABLED_TOOLS, createAntigravityLauncher, isAntigravityAuthError } from '../antigravityLauncher'
import { ANTIGRAVITY_CONDUCTOR_TOOLS, applyConductorToolPolicy, cinnaToolName } from '../conductorToolPolicy'
import { AcpMessageStream } from '../acpMessages'
import { permissionAsQuestion, permissionQuestionAnswer } from '../acpQuestions'
import { pickPermissionOption } from '../acpPermissions'
import { parsePromptTelemetry } from '../acpTelemetry'
import { KIND_METADATA_KEY } from '../../../streamPartsAccumulator'
import type { PermissionOption, SessionNotification } from '@agentclientprotocol/sdk'
import type { AcpLaunchPlan } from '../acpLaunchers'
import { ANTIGRAVITY_CONTRACT } from './antigravity.contract'
import { lineDiff, sorted } from './snapshotTools'
import type { AdapterConnection, AdapterMessage } from './codexHarness'
import {
  findContractAntigravity, gatewayEnv, makeAntigravityScratch, runServer, spawnAntigravity, startFakeGateway, writeGatewayHome,
  type FakeGateway, type GatewayReply, type GatewayTurn
} from './antigravityHarness'

/**
 * The Antigravity interface contract, checked against the **real** server.
 *
 * `npm run test:contract` (its own vitest config — never part of `npm test`):
 * the managed pinned `agy_acp_server.par` over real stdio, against a loopback
 * fake Gemini endpoint reached through the server's own `gateway` auth mode —
 * no Google login is read, written or asked for. One `it` per entry of
 * `antigravity.contract.ts`, its title starting with the entry's id —
 * `contractRegistry.test.ts` holds that mapping.
 *
 * Three scenarios are driven once in `beforeAll` and every `it` asserts on
 * what was observed:
 *
 * - **folder** — a sealed (kit) folder planned by the production launcher
 *   (its home nested in the folder, its tool filter, its setup and its
 *   first-prompt instructions), with Cinna's MCP server attached: a command,
 *   an edit, a question and an MCP call under asks, an MCP call in `yolo`,
 *   both cancels, then `session/load` in a fresh process.
 * - **native** — a native folder on the user home (`GEMINI_HOME` unset), the
 *   tool-filter probes, and a home with no `auth.type`.
 * - **chat** — a chat runtime planned by the launcher and narrowed by
 *   `applyConductorToolPolicy`, in its process folder.
 *
 * The same observations, reduced to shapes, are compared with the committed
 * `snapshots/antigravity-<version>.json` (the last test), written only by
 * `make contract-snapshot ENGINE=antigravity`.
 *
 * `CINNA_CONTRACT_ANTIGRAVITY=/abs/agy_acp_server.par` runs all of it against a
 * candidate without touching the pin (`make contract-next ENGINE=antigravity`).
 */

const here = dirname(fileURLToPath(import.meta.url))
const binaryRef = findContractAntigravity(RUNTIME_PINS.antigravity.cli)
const candidate = binaryRef?.source === 'override'

/** No binary is a failure, not a skip — see `codex.contract.test.ts`. */
const allowSkip = process.env['CINNA_CONTRACT_ALLOW_SKIP'] === '1'
const NO_BINARY =
  `The Antigravity contract needs the managed Antigravity server ${RUNTIME_PINS.antigravity.cli} and found none — nothing was checked.\n` +
  '  Install it with:  make contract ENGINE=antigravity   (or: node --experimental-strip-types scripts/install-runtime.mjs antigravity)\n' +
  '  Or point CINNA_CONTRACT_ANTIGRAVITY at an agy_acp_server.par with localharness_external beside it.\n' +
  '  To skip knowingly: CINNA_CONTRACT_ALLOW_SKIP=1'
if (!binaryRef && allowSkip) console.warn(`\nSKIPPED: ${NO_BINARY}\n`)

const writeSnapshot = process.env['CINNA_CONTRACT_WRITE_SNAPSHOT'] === '1'

/** The gateway's allowlist: the first is the server's default, the second is the one Cinna chooses. */
const MODELS = ['gemini-3.6-flash-low', 'gemini-3.7-flash-low'] as const
const MODEL = MODELS[1]
/** What the server puts in the request path: the thinking level stripped. */
const MODEL_PATH = 'gemini-3.7-flash'
const FOLDER_MARKER = 'CONTRACT_FOLDER_INSTRUCTIONS_a41'
const FIRST_PROMPT = 'Answer OK.'
const AFTER_LOAD_PROMPT = 'Answer OK after the restart.'
const COMMAND_MARKER = 'CONTRACT_COMMAND_OK'
const MCP_RESULT = 'CONTRACT_MCP_RESULT_'
const MCP_SUMMARY = 'Probe summary'
const UNEXECUTED = 'Tool call was approved but never executed.'
const MCP_META_TOOLS = ['call_mcp_tool', 'list_resources', 'read_resource']

type Json = Record<string, unknown>
const keys = (value: unknown): string[] => (value && typeof value === 'object' ? Object.keys(value as Json).sort() : [])
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check: () => boolean, ms = 20_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (check()) return true; await sleep(50) }
  return check()
}
const toolCallOf = (request: AdapterMessage | undefined): Json => (request?.params?.toolCall ?? {}) as Json
const optionsOf = (request: AdapterMessage | undefined): Json[] => (request?.params?.options as Json[] | undefined) ?? []
const commandCwd = (systemText: string | undefined): string | null => /Command Working Directory: (\S+)/.exec(systemText ?? '')?.[1] ?? null
const schemaDir = (systemText: string): string | null => /Each MCP server has a directory `([^`]+?)\/<serverName>`/.exec(systemText)?.[1] ?? null

/** One prompt and everything it caused. */
interface Step {
  name: string
  result: AdapterMessage
  updates: Json[]
  turns: GatewayTurn[]
  permissions: AdapterMessage[]
  calls: string[]
}

/** Everything the scenarios observed. Filled by `beforeAll`. */
const seen = {
  version: { status: null as number | null, output: '' },
  uid: { status: null as number | null, output: '' },
  folder: {
    cwd: '', home: '',
    plan: null as AcpLaunchPlan | null,
    initialize: null as AdapterMessage | null,
    sessionNew: null as AdapterMessage | null,
    setup: [] as AdapterMessage[],
    steps: [] as Step[],
    fileWritten: false,
    yolo: null as AdapterMessage | null,
    cancelModel: { result: null as AdapterMessage | null, ms: 0, updates: [] as Json[] },
    cancelCommand: { result: null as AdapterMessage | null, ms: 0, updates: [] as Json[], ranLater: true },
    load: { result: null as AdapterMessage | null, updates: [] as Json[] },
    afterLoad: { result: null as AdapterMessage | null, turns: [] as GatewayTurn[] },
    list: null as AdapterMessage | null,
    turns: [] as GatewayTurn[]
  },
  native: {
    cwd: '', home: '', envHasHome: true,
    sessionNew: null as AdapterMessage | null,
    firstTurn: null as GatewayTurn | null,
    filters: {} as Record<string, string[] | null>,
    unauthenticated: null as AdapterMessage | null
  },
  chat: {
    meta: null as Json | null,
    steps: [] as Step[],
    schemaDir: null as string | null,
    addedSchemaWritten: false,
    turns: [] as GatewayTurn[]
  }
}

function mcpProvider(tools: () => string[], onCall: (name: string) => void): never {
  return { getProviders: () => [{ providerType: 'mcp', displayName: 'contract',
    getTools: () => tools().map((name) => ({ name, description: 'Return a marker.', inputSchema: { type: 'object', properties: {} }, providerType: 'mcp', mcpProviderId: name })),
    callTool: async (name: string) => { onCall(name); return { content: `${MCP_RESULT}${name}` } } }] } as never
}

const callMcp = (tool: string): GatewayReply => ({ kind: 'call', name: 'call_mcp_tool',
  args: { ServerName: 'cinna', ToolName: tool, Arguments: {}, toolAction: 'Probing', toolSummary: MCP_SUMMARY } })

/**
 * The production launcher's plan for a folder, on the contract's gateway: the
 * launcher writes the personal-login settings into a sealed folder's home,
 * which the harness overwrites with `gateway` before anything is spawned (and
 * `spawnAntigravity` refuses any other home).
 */
async function plannedFolder(binary: string, folderPath: string, env: Record<string, string>, mode: 'isolated' | 'native'): Promise<AcpLaunchPlan> {
  const launcher = createAntigravityLauncher({
    binary: async () => ({ path: binary }),
    binaryKnown: async () => ({ state: 'ready' }),
    auth: async () => ({ state: 'logged_in' }),
    env: async () => env,
    systemPrompt: () => FOLDER_MARKER,
    settings: () => ({ model: MODEL, approval: 'ask' })
  })
  const plan = await launcher.plan({ userId: 'contract', agentId: 'contract',
    folder: { name: 'Contract', slug: 'contract', description: '', path: folderPath, kind: 'kit', runtimeMode: mode } })
  if ('error' in plan) throw new Error(plan.error)
  if (plan.spec.env.GEMINI_HOME) writeGatewayHome(plan.spec.env.GEMINI_HOME)
  return plan
}

/** Answers an ask the way a user would: a question with "Yes", anything else with the once-allow. */
function answerAsk(permissions: AdapterMessage[]) {
  return (request: AdapterMessage): Json | undefined => {
    if (request.method !== 'session/request_permission') return undefined
    permissions.push(request)
    const params = request.params as never
    const question = permissionAsQuestion('antigravity', params)
    const optionId = question
      ? permissionQuestionAnswer(question, [['Yes']])
      : pickPermissionOption(optionsOf(request) as unknown as PermissionOption[], 'allow')
    return optionId ? { outcome: { outcome: 'selected', optionId } } : undefined
  }
}

/* -------------------------------------------------------------- scenario A */

async function folderScenario(binary: string): Promise<void> {
  const scratch = makeAntigravityScratch('cinna-contract-agy-folder-')
  const mcp = new ConductorMcpServer()
  let gateway: FakeGateway | undefined
  let connection: AdapterConnection | undefined
  const log = seen.folder
  try {
    const calls: string[] = []
    const cinna = await mcp.ensureSession('cinna', mcpProvider(() => ['probe'], (name) => calls.push(name)))
    let next: GatewayReply | null = null
    gateway = await startFakeGateway((turn): GatewayReply => {
      // Scripted only on a fresh user request; a tool's result is answered with text.
      if (turn.responses.length === 0 && next) { const reply = next; next = null; return reply }
      return { kind: 'text', text: 'OK' }
    })
    const cwd = join(scratch.root, 'work')
    mkdirSync(cwd)
    const plan = await plannedFolder(binary, cwd, { ...scratch.env, ...gatewayEnv(gateway.port, MODELS) }, 'isolated')
    log.cwd = cwd
    log.home = plan.spec.env.GEMINI_HOME ?? ''
    log.plan = plan
    const permissions: AdapterMessage[] = []
    const start = (): AdapterConnection => spawnAntigravity({ binary: plan.spec.command, args: plan.spec.args, cwd: plan.spec.cwd ?? cwd,
      env: plan.spec.env, geminiHome: plan.spec.env.GEMINI_HOME ?? null, answer: answerAsk(permissions) })
    connection = start()
    log.initialize = await connection.rpc('initialize', plan.init as unknown as Json)
    log.sessionNew = await connection.rpc('session/new', { cwd, mcpServers: [cinna.descriptor], _meta: plan.session.meta })
    const sessionId = String(log.sessionNew.result?.sessionId ?? '')
    if (!sessionId) return
    // The driver's order: config options, then the mode.
    for (const option of plan.setup.configOptions ?? []) log.setup.push(await connection.rpc('session/set_config_option', { sessionId, configId: option.configId, value: option.value }))
    if (plan.setup.modeId) log.setup.push(await connection.rpc('session/set_mode', { sessionId, modeId: plan.setup.modeId }))
    const prompt = (texts: string[], timeoutMs?: number): Promise<AdapterMessage> =>
      connection!.rpc('session/prompt', { sessionId, prompt: texts.map((text) => ({ type: 'text', text })) }, timeoutMs)
    const step = async (name: string, reply: GatewayReply | null, texts: string[]): Promise<void> => {
      const at = connection!.updates.length, turnAt = gateway!.turns.length, permAt = permissions.length, callAt = calls.length
      next = reply
      const result = await prompt(texts)
      // A trailing update (the ask's own id closing) can land just after the answer.
      await sleep(500)
      log.steps.push({ name, result, updates: connection!.updates.slice(at), turns: gateway!.turns.slice(turnAt), permissions: permissions.slice(permAt), calls: calls.slice(callAt) })
    }

    // The driver's first prompt of a new session: the preamble block, then the user's.
    await step('first', null, [plan.firstPromptPreamble ?? '', FIRST_PROMPT])
    await step('command', { kind: 'call', name: 'run_command', args: { CommandLine: `echo ${COMMAND_MARKER}`, Cwd: cwd, WaitMsBeforeAsync: 5000, toolAction: 'Echoing', toolSummary: 'Echo' } }, ['Run the command.'])
    await step('edit', { kind: 'call', name: 'write_to_file', args: { TargetFile: join(cwd, 'probe.txt'), CodeContent: 'x\n', Overwrite: false, Description: 'probe', toolAction: 'Writing', toolSummary: 'Probe file' } }, ['Write the file.'])
    log.fileWritten = existsSync(join(cwd, 'probe.txt'))
    await step('question', { kind: 'call', name: 'ask_question', args: { questions: [{ question: 'Deterministic?', options: ['Yes', 'No'], is_multi_select: false }], toolAction: 'Asking', toolSummary: 'Question' } }, ['Ask a question.'])
    await step('mcp', callMcp('probe'), ['Call the probe.'])

    // Cancel during a model request.
    {
      const at = connection.updates.length
      next = { kind: 'stall' }
      const before = gateway.turns.length
      const running = prompt(['Wait until cancelled.'], 30_000)
      await until(() => gateway!.turns.length > before)
      const cancelledAt = Date.now()
      connection.notify('session/cancel', { sessionId })
      const result = await running
      log.cancelModel = { result, ms: Date.now() - cancelledAt, updates: connection.updates.slice(at) }
    }

    log.yolo = await connection.rpc('session/set_mode', { sessionId, modeId: 'yolo' })
    await step('mcp-yolo', callMcp('probe'), ['Call the probe again.'])

    // Cancel while a command runs: does the command's effect still happen?
    {
      const marker = join(cwd, 'slept.txt')
      const at = connection.updates.length
      next = { kind: 'call', name: 'run_command', args: { CommandLine: `sleep 3 && echo done > ${marker}`, Cwd: cwd, WaitMsBeforeAsync: 10000, toolAction: 'Sleeping', toolSummary: 'Sleep' } }
      const running = prompt(['Sleep.'], 60_000)
      await until(() => connection!.updates.slice(at).some((update) => update.sessionUpdate === 'tool_call' && update.kind === 'execute'))
      await sleep(300)
      const cancelledAt = Date.now()
      connection.notify('session/cancel', { sessionId })
      const result = await running
      const ms = Date.now() - cancelledAt
      await sleep(4500)
      log.cancelCommand = { result, ms, updates: connection.updates.slice(at), ranLater: existsSync(marker) }
    }
    await connection.close()

    // A fresh process, the way the driver resumes a chat after a restart.
    connection = start()
    await connection.rpc('initialize', plan.init as unknown as Json)
    const loaded = await connection.rpc('session/load', { sessionId, cwd, mcpServers: [cinna.descriptor], _meta: plan.session.meta })
    await sleep(500)
    log.load = { result: loaded, updates: [...connection.updates] }
    for (const option of plan.setup.configOptions ?? []) await connection.rpc('session/set_config_option', { sessionId, configId: option.configId, value: option.value })
    const turnAt = gateway.turns.length
    log.afterLoad = { result: await prompt([AFTER_LOAD_PROMPT]), turns: gateway.turns.slice(turnAt) }
    log.list = await connection.rpc('session/list', { cwd })
  } finally {
    await connection?.close()
    await mcp.dispose()
    await gateway?.close()
    log.turns = [...(gateway?.turns ?? [])]
    scratch.dispose()
  }
}

/* -------------------------------------------------------------- scenario B */

async function nativeScenario(binary: string): Promise<void> {
  const scratch = makeAntigravityScratch('cinna-contract-agy-native-')
  let gateway: FakeGateway | undefined
  let connection: AdapterConnection | undefined
  const log = seen.native
  try {
    gateway = await startFakeGateway(() => ({ kind: 'text', text: 'OK' }))
    const cwd = join(scratch.root, 'work')
    mkdirSync(cwd)
    // The user's own home, as `GEMINI_HOME` unset reads it.
    const userHome = join(scratch.home, '.gemini')
    writeGatewayHome(userHome)
    const plan = await plannedFolder(binary, cwd, { ...scratch.env, ...gatewayEnv(gateway.port, MODELS) }, 'native')
    log.cwd = cwd
    log.home = userHome
    log.envHasHome = 'GEMINI_HOME' in plan.spec.env
    connection = spawnAntigravity({ binary: plan.spec.command, args: plan.spec.args, cwd, env: plan.spec.env, geminiHome: userHome })
    await connection.rpc('initialize', plan.init as unknown as Json)
    log.sessionNew = await connection.rpc('session/new', { cwd, mcpServers: [], _meta: plan.session.meta })
    const sessionId = String(log.sessionNew.result?.sessionId ?? '')
    if (sessionId) await connection.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: FIRST_PROMPT }] })
    log.firstTurn = gateway.turns[0] ?? null
    // The tool filter, one session per name set.
    for (const names of [['start_subagent'], ['create_file', 'edit_file'], ['send_message', 'define_subagent'], [...ANTIGRAVITY_FILTER_TOOLS]]) {
      const before = gateway.turns.length
      const probe = await connection.rpc('session/new', { cwd, mcpServers: [], _meta: { agy: { disabledTools: names } } })
      const id = String(probe.result?.sessionId ?? '')
      if (id) await connection.rpc('session/prompt', { sessionId: id, prompt: [{ type: 'text', text: FIRST_PROMPT }] })
      log.filters[names.join(',')] = gateway.turns[before]?.tools ?? null
    }
  } finally {
    await connection?.close()
    await gateway?.close()
    scratch.dispose()
  }

  // No settings at all. Never a personal-login home: that opens a browser.
  const empty = makeAntigravityScratch('cinna-contract-agy-empty-')
  connection = undefined
  try {
    const home = join(empty.root, 'gemini')
    mkdirSync(home)
    connection = spawnAntigravity({ binary, cwd: empty.root, env: { ...empty.env, GEMINI_HOME: home }, geminiHome: home })
    await connection.rpc('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'cinna-contract', version: '1' } })
    log.unauthenticated = await connection.rpc('session/new', { cwd: empty.root, mcpServers: [] })
  } finally {
    await connection?.close()
    empty.dispose()
  }
}

/* -------------------------------------------------------------- scenario C */

/** A chat runtime: the launcher's plan for its process folder, narrowed by the production chat policy. */
async function chatScenario(binary: string): Promise<void> {
  const scratch = makeAntigravityScratch('cinna-contract-agy-chat-')
  const mcp = new ConductorMcpServer()
  let gateway: FakeGateway | undefined
  let connection: AdapterConnection | undefined
  const log = seen.chat
  try {
    const calls: string[] = []
    let tools = ['probe']
    const cinna = await mcp.ensureSession('cinna', mcpProvider(() => tools, (name) => calls.push(name)))
    let decideFirst: ((turn: GatewayTurn) => GatewayReply) | null = null
    gateway = await startFakeGateway((turn): GatewayReply => {
      if (turn.responses.length === 0 && decideFirst) { const decide = decideFirst; decideFirst = null; return decide(turn) }
      return { kind: 'text', text: 'OK' }
    })
    const cwd = join(scratch.root, 'processes', 'chat-runtime')
    mkdirSync(cwd, { recursive: true })
    // A chat folder beside the process folder: outside the session's workspace.
    mkdirSync(join(scratch.root, 'chat-1'))
    writeFileSync(join(scratch.root, 'chat-1', 'AGENTS.md'), 'PRIVATE_CHAT_INSTRUCTIONS\n')
    const plan = applyConductorToolPolicy(await plannedFolder(binary, cwd, { ...scratch.env, ...gatewayEnv(gateway.port, MODELS) }, 'isolated'), 'antigravity')
    log.meta = plan.session.meta ?? null
    const permissions: AdapterMessage[] = []
    connection = spawnAntigravity({ binary: plan.spec.command, args: plan.spec.args, cwd, env: plan.spec.env,
      geminiHome: plan.spec.env.GEMINI_HOME ?? null, answer: answerAsk(permissions) })
    await connection.rpc('initialize', plan.init as unknown as Json)
    const created = await connection.rpc('session/new', { cwd, mcpServers: [cinna.descriptor], _meta: plan.session.meta })
    const sessionId = String(created.result?.sessionId ?? '')
    if (!sessionId) return
    if (plan.setup.modeId) await connection.rpc('session/set_mode', { sessionId, modeId: plan.setup.modeId })
    const step = async (name: string, decide: (turn: GatewayTurn) => GatewayReply): Promise<void> => {
      const at = connection!.updates.length, turnAt = gateway!.turns.length, permAt = permissions.length, callAt = calls.length
      decideFirst = (turn) => { log.schemaDir ??= schemaDir(turn.systemText); return decide(turn) }
      const result = await connection!.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: `Do ${name}.` }] })
      await sleep(300)
      log.steps.push({ name, result, updates: connection!.updates.slice(at), turns: gateway!.turns.slice(turnAt), permissions: permissions.slice(permAt), calls: calls.slice(callAt) })
    }
    await step('mcp', () => callMcp('probe'))
    await step('schema', (turn) => ({ kind: 'call', name: 'view_file',
      args: { AbsolutePath: join(schemaDir(turn.systemText) ?? '/nonexistent', 'cinna', 'probe.json'), toolAction: 'Reading', toolSummary: 'Schema' } }))
    await step('outside', () => ({ kind: 'call', name: 'view_file',
      args: { AbsolutePath: join(scratch.root, 'chat-1', 'AGENTS.md'), toolAction: 'Reading', toolSummary: 'Chat file' } }))
    // A tool added mid-session, announced the way the app announces it.
    tools = ['probe', 'probe_added']
    await cinna.refreshTools()
    await sleep(1500)
    await step('added', () => callMcp('probe_added'))
    log.addedSchemaWritten = !!log.schemaDir && existsSync(join(log.schemaDir, 'cinna', 'probe_added.json'))
  } finally {
    await connection?.close()
    await mcp.dispose()
    await gateway?.close()
    log.turns = [...(gateway?.turns ?? [])]
    scratch.dispose()
  }
}

/* ---------------------------------------------------------------- snapshot */

const folderStep = (name: string): Step | undefined => seen.folder.steps.find((step) => step.name === name)
const chatStep = (name: string): Step | undefined => seen.chat.steps.find((step) => step.name === name)
const firstToolCall = (updates: Json[], kind?: string): Json | undefined =>
  updates.find((update) => update.sessionUpdate === 'tool_call' && (kind === undefined || update.kind === kind))
const buildLabel = (output: string): string | null => /^Build label: (\S+)$/m.exec(output)?.[1] ?? null
const declared = (turn: GatewayTurn | null | undefined): string[] => [...(turn?.tools ?? [])].sort()
const configOption = (message: AdapterMessage | null, id: string): Json | null =>
  ((message?.result?.configOptions as Json[] | undefined) ?? []).find((option) => option.id === id) ?? null

/** One update's shape: its keys, the shape of `rawOutput` and `rawInput`, and the `_meta` keys. */
const updateShape = (update: Json | undefined): Json | null => update ? {
  keys: keys(update), kind: update.kind ?? null, status: update.status ?? null,
  rawInputKeys: typeof update.rawInput === 'string' ? '<json string>' : keys(update.rawInput),
  rawOutputKeys: typeof update.rawOutput === 'string' ? '<string>' : keys(update.rawOutput),
  metaKeys: keys(update._meta)
} : null
const askShape = (request: AdapterMessage | undefined): Json | null => request ? {
  paramKeys: keys(request.params), toolCallKeys: keys(toolCallOf(request)), kind: toolCallOf(request).kind ?? null,
  options: optionsOf(request).map((option) => `${String(option.optionId)}:${String(option.kind)}`),
  optionMetaKeys: [...new Set(optionsOf(request).flatMap((option) => keys(option._meta)))].sort()
} : null

/** Shapes only: no paths, ids, ports, tokens or timestamps, keys sorted, so two versions diff cleanly. */
function snapshot(): Json {
  const init = (seen.folder.initialize?.result ?? {}) as Json
  const created = (seen.folder.sessionNew?.result ?? {}) as Json
  const loaded = (seen.folder.load.result?.result ?? {}) as Json
  const edit = folderStep('edit')
  const all = [...seen.folder.turns, ...seen.chat.turns]
  return {
    tool: 'antigravity', version: buildLabel(seen.version.output), adapter: null,
    cli: { versionExit: seen.version.status, uidExit: seen.uid.status },
    acp: {
      initialize: { protocolVersion: init.protocolVersion ?? null, agentCapabilities: init.agentCapabilities ?? null,
        agentInfoName: (init.agentInfo as Json | undefined)?.name ?? null,
        authMethodIds: ((init.authMethods as Json[] | undefined) ?? []).map((method) => String(method.id)).sort(), resultKeys: keys(init) },
      sessionNew: { resultKeys: keys(created),
        modeIds: (((created.modes as Json | undefined)?.availableModes as Json[] | undefined) ?? []).map((mode) => String(mode.id)).sort(),
        currentModeId: (created.modes as Json | undefined)?.currentModeId ?? null,
        configOptionIds: ((created.configOptions as Json[] | undefined) ?? []).map((option) => String(option.id)).sort() },
      unauthenticated: { code: seen.native.unauthenticated?.error?.code ?? null, message: seen.native.unauthenticated?.error?.message ?? null },
      commandAsk: askShape(folderStep('command')?.permissions[0]),
      commandDone: updateShape(folderStep('command')?.updates.find((update) => update.sessionUpdate === 'tool_call_update' && update.status === 'completed')),
      editAsk: askShape(edit?.permissions[0]),
      // A set: the ask's own id may close before or after the write's.
      editToolUpdates: [...new Set((edit?.updates ?? []).filter((update) => String(update.sessionUpdate).startsWith('tool_call'))
        .map((update) => `${String(update.sessionUpdate)}:${String(update.status ?? '')}:${String(update.title ?? '')}`))].sort(),
      questionAsk: askShape(folderStep('question')?.permissions[0]),
      mcpAskedCall: updateShape(firstToolCall(folderStep('mcp')?.updates ?? [])),
      mcpAsk: askShape(folderStep('mcp')?.permissions[0]),
      mcpYoloCall: updateShape(firstToolCall(folderStep('mcp-yolo')?.updates ?? [])),
      mcpYoloAsks: folderStep('mcp-yolo')?.permissions.length ?? null,
      cancelModel: { stopReason: seen.folder.cancelModel.result?.result?.stopReason ?? null },
      cancelCommand: { stopReason: seen.folder.cancelCommand.result?.result?.stopReason ?? null, ranLater: seen.folder.cancelCommand.ranLater,
        callEnd: seen.folder.cancelCommand.updates.filter((update) => update.sessionUpdate === 'tool_call_update').map((update) => String(update.status)) },
      load: { resultKeys: keys(loaded), mode: (loaded.modes as Json | undefined)?.currentModeId ?? null,
        modelIsDefault: configOption(seen.folder.load.result, 'model')?.currentValue === MODELS[0],
        replayKinds: [...new Set(seen.folder.load.updates.map((update) => String(update.sessionUpdate)))].sort() },
      sessionListTitle: String(((seen.folder.list?.result?.sessions as Json[] | undefined) ?? [])[0]?.title ?? '').replace(/[0-9a-f]{8}$/, '<hex>'),
      usageUpdateKeys: [...new Set(seen.folder.steps.flatMap((step) => step.updates).filter((update) => update.sessionUpdate === 'usage_update').flatMap((update) => keys(update)))].sort(),
      promptResultKeys: keys(folderStep('first')?.result.result)
    },
    tools: {
      builtins: declared(seen.native.firstTurn),
      sealedFolder: declared(folderStep('first')?.turns[0]),
      chatPolicy: [...new Set(seen.chat.turns.flatMap((turn) => turn.tools))].sort(),
      filters: Object.fromEntries(Object.entries(seen.native.filters).map(([names, tools]) =>
        [names, seen.native.firstTurn ? (seen.native.firstTurn.tools.filter((tool) => !(tools ?? []).includes(tool))).sort() : null])),
      addedMidSessionCallable: (chatStep('added')?.calls ?? []).includes('probe_added'),
      addedSchemaWritten: seen.chat.addedSchemaWritten
    },
    providerTraffic: {
      paths: [...new Set(all.map((turn) => turn.path.replace(/\/models\/[^:]+:/, '/models/<model>:')))].sort(),
      methods: [...new Set(all.map((turn) => turn.method))].sort()
    }
  }
}

/* ------------------------------------------------------------------- tests */

const entry = (id: string): string => {
  const found = ANTIGRAVITY_CONTRACT.find((candidateEntry) => candidateEntry.id === id)
  if (!found) throw new Error(`${id} is not in the registry`)
  return `${id} — ${found.expectation}`
}

// Registered only when it applies — see `codex.contract.test.ts`.
if (!binaryRef && !allowSkip) {
  describe('Antigravity interface contract — no binary', () => {
    it('has a managed Antigravity server to check', () => { throw new Error(NO_BINARY) })
  })
}

describe.skipIf(!binaryRef)('Antigravity interface contract', () => {
  const binary = binaryRef?.path ?? ''

  beforeAll(async () => {
    const scratch = makeAntigravityScratch('cinna-contract-agy-cli-')
    try {
      const version = runServer(binary, ['--version'], scratch.env, scratch.root)
      seen.version = { status: version.status, output: `${version.stdout}\n${version.stderr}` }
      const uid = runServer(binary, ['--uid='], scratch.env, scratch.root)
      seen.uid = { status: uid.status, output: `${uid.stdout}\n${uid.stderr}` }
    } finally { scratch.dispose() }
    await folderScenario(binary)
    await nativeScenario(binary)
    await chatScenario(binary)
  }, 300_000)

  it(entry('antigravity.launch.version-flag'), () => {
    expect(seen.version.status).toBe(0)
    expect(buildLabel(seen.version.output)).toMatch(/^\d+\.\d+\.\d+/)
    if (!candidate) expect(buildLabel(seen.version.output)).toBe(RUNTIME_PINS.antigravity.cli)
  })

  it(entry('antigravity.launch.server-args'), () => {
    if (process.platform === 'darwin') {
      expect(seen.folder.plan?.spec.args).toEqual([])
      expect(seen.uid.status).not.toBe(0)
      expect(seen.uid.output).toMatch(/Unknown command line flag 'uid'/)
    } else {
      // The plan's own arguments started every session above.
      expect(seen.folder.plan?.spec.args).toEqual(['--uid='])
    }
    expect(seen.folder.sessionNew?.error).toBeUndefined()
  })

  it(entry('antigravity.launch.gemini-home'), () => {
    // The gateway settings were read from the home the variable names, or from `$HOME/.gemini`.
    expect(seen.folder.sessionNew?.error).toBeUndefined()
    expect(seen.native.envHasHome).toBe(false)
    expect(seen.native.sessionNew?.error).toBeUndefined()
    // And the session's own files live under it.
    const folderSystem = folderStep('first')?.turns[0]?.systemText ?? ''
    expect(schemaDir(folderSystem)?.startsWith(`${seen.folder.home}/`)).toBe(true)
    expect(seen.folder.load.result?.error).toBeUndefined()
  })

  it(entry('antigravity.launch.command-cwd'), () => {
    expect(seen.folder.home.startsWith(`${seen.folder.cwd}/`)).toBe(true)
    expect(commandCwd(folderStep('first')?.turns[0]?.systemText)).toBe(seen.folder.cwd)
    expect(commandCwd(seen.native.firstTurn?.systemText)).toBe(join(seen.native.home, 'antigravity-cli', 'skills'))
  })

  it(entry('antigravity.auth.methods'), () => {
    const init = (seen.folder.initialize?.result ?? {}) as Json
    expect(((init.authMethods as Json[] | undefined) ?? []).map((method) => method.id)).toContain('oauth-personal')
    expect(((init.agentCapabilities as Json | undefined)?.auth as Json | undefined)?.logout).toBeTruthy()
  })

  it(entry('antigravity.auth.required-error'), () => {
    const error = seen.native.unauthenticated?.error as Json | undefined
    expect(error).toMatchObject({ code: -32000, message: 'Authentication required' })
    // The owner's own reading of it.
    expect(isAntigravityAuthError(error)).toBe(true)
  })

  it(entry('antigravity.session.initialize'), () => {
    expect(seen.folder.initialize?.error).toBeUndefined()
    expect(seen.folder.initialize?.result).toMatchObject({ protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: 'antigravity-acp' } })
  })

  it(entry('antigravity.session.modes'), () => {
    const modes = (seen.folder.sessionNew?.result?.modes ?? {}) as Json
    expect(((modes.availableModes as Json[] | undefined) ?? []).map((mode) => mode.id)).toEqual(expect.arrayContaining(['default', 'auto_edit', 'yolo']))
    expect(modes.currentModeId).toBe('default')
    expect(seen.folder.plan?.setup.modeId).toBe('default')
    expect(seen.folder.setup.map((answer) => answer.error)).toEqual(seen.folder.setup.map(() => undefined))
    expect(seen.folder.yolo?.error).toBeUndefined()
  })

  it(entry('antigravity.session.load'), () => {
    expect(seen.folder.load.result?.error).toBeUndefined()
    const replayed = seen.folder.load.updates
    expect(replayed.some((update) => update.sessionUpdate === 'user_message_chunk')).toBe(true)
    expect(replayed.some((update) => update.sessionUpdate === 'tool_call')).toBe(true)
    // The mode it was left in…
    expect((seen.folder.load.result?.result?.modes as Json | undefined)?.currentModeId).toBe('yolo')
    // …but not the model: the first offered, until setup says otherwise.
    expect(configOption(seen.folder.load.result, 'model')?.currentValue).toBe(MODELS[0])
    expect(seen.folder.afterLoad.turns.length).toBeGreaterThan(0)
    expect(seen.folder.afterLoad.turns.map((turn) => turn.model)).toEqual(seen.folder.afterLoad.turns.map(() => MODEL_PATH))
    expect(seen.folder.afterLoad.result?.result?.stopReason).toBe('end_turn')
  })

  it(entry('antigravity.session.replay-raw-input'), () => {
    const replayed = seen.folder.load.updates.filter((update) => update.sessionUpdate === 'tool_call')
    const command = replayed.find((update) => update.kind === 'execute')
    expect(typeof command?.rawInput).toBe('string')
    expect(JSON.parse(String(command?.rawInput))).toMatchObject({ CommandLine: `echo ${COMMAND_MARKER}` })
    const mcpCall = replayed.find((update) => (update._meta as Json | undefined)?.mcp !== undefined)
    expect(mcpCall?.rawInput).toEqual({ arguments: {} })
    // The owner reads the string as the object it encodes: the call's input part carries the command.
    const stream = new AcpMessageStream({ launcher: 'antigravity' })
    const parts = stream.apply({ sessionId: 'replay', update: command } as unknown as SessionNotification).message?.parts ?? []
    expect(JSON.stringify(parts)).toContain(`echo ${COMMAND_MARKER}`)
  })

  it(entry('antigravity.session.first-prompt-instructions'), () => {
    const first = folderStep('first')?.turns[0]
    expect(seen.folder.plan?.firstPromptPreamble).toContain(FOLDER_MARKER)
    expect(first?.lastUserText).toMatch(/<USER_REQUEST>/)
    expect(first?.lastUserText).toContain(FOLDER_MARKER)
    expect(first?.lastUserText).toContain(FIRST_PROMPT)
    expect(first?.systemText).not.toContain(FOLDER_MARKER)
    // Kept server-side across a restart: the next request still carries it, in the history.
    const resumed = seen.folder.afterLoad.turns[0]
    expect(resumed?.userText).toContain(FOLDER_MARKER)
    expect(resumed?.lastUserText).toContain(AFTER_LOAD_PROMPT)
    expect(resumed?.lastUserText).not.toContain(FOLDER_MARKER)
  })

  it(entry('antigravity.tool.command-output'), () => {
    const updates = folderStep('command')?.updates ?? []
    const done = updates.find((update) => update.sessionUpdate === 'tool_call_update' && update.status === 'completed')
    expect(keys(done?.rawOutput)).toEqual(expect.arrayContaining(['commandLine', 'workingDir', 'exitCode', 'exit_code', 'combinedOutput', 'formatted_output']))
    expect(String((done?.rawOutput as Json | undefined)?.formatted_output)).toContain(COMMAND_MARKER)
    // Our reader stores it.
    const stream = new AcpMessageStream({ launcher: 'antigravity' })
    const results = updates.flatMap((update) => stream.apply({ sessionId: 'command', update } as unknown as SessionNotification).message?.parts ?? [])
      .filter((part) => part.metadata?.[KIND_METADATA_KEY] === 'tool_result')
    expect(results.map((part) => part.text).join('\n')).toContain(COMMAND_MARKER)
  })

  it(entry('antigravity.mcp.session-injection'), () => {
    const first = folderStep('first')?.turns[0]
    expect(first?.tools).toEqual(expect.arrayContaining(MCP_META_TOOLS))
    expect(first?.tools.some((name) => name.includes('probe'))).toBe(false)
    expect(seen.native.firstTurn?.tools.filter((name) => MCP_META_TOOLS.includes(name))).toEqual([])
    // Reached through the descriptor's URL and headers.
    expect(folderStep('mcp')?.calls).toEqual(['probe'])
  })

  it(entry('antigravity.mcp.tool-call-naming'), () => {
    const asked = firstToolCall(folderStep('mcp')?.updates ?? [])
    expect(asked).toMatchObject({ title: 'cinna_probe', kind: 'other', rawInput: { arguments: {} }, _meta: { mcp: { server: 'cinna', tool: 'probe' }, is_mcp_tool_call: true } })
    const ask = folderStep('mcp')?.permissions[0]
    expect(toolCallOf(ask)).toMatchObject({ toolCallId: asked?.toolCallId, title: 'cinna_probe', kind: 'other', _meta: { mcp: { server: 'cinna', tool: 'probe' } } })
    const bare = firstToolCall(folderStep('mcp-yolo')?.updates ?? [])
    expect(folderStep('mcp-yolo')?.permissions).toEqual([])
    expect(bare).toMatchObject({ title: 'Running probe', kind: 'other', rawInput: {} })
    expect(bare?._meta).toBeUndefined()
    // The owners: the shared name reader (`_meta.mcp` first) and the stream, on both shapes, and the ask itself.
    const offers = { offers: (name: string) => name === 'probe', kind: 'other' }
    expect(cinnaToolName(String(asked?.title), asked?.rawInput, undefined, asked?._meta)).toBe('probe')
    expect(cinnaToolName(String(bare?.title), bare?.rawInput, offers)).toBe('probe')
    const askCall = toolCallOf(ask)
    expect(cinnaToolName(String(askCall.title), askCall.rawInput, offers, askCall._meta)).toBe('probe')
    const stream = new AcpMessageStream({ launcher: 'antigravity' })
    stream.apply({ sessionId: 'mcp', update: asked } as unknown as SessionNotification)
    stream.apply({ sessionId: 'mcp', update: bare } as unknown as SessionNotification)
    expect(stream.cinnaTool(String(asked?.toolCallId))).toBe('probe')
    expect(stream.cinnaTool(String(bare?.toolCallId))).toBe('probe')
  })

  it(entry('antigravity.mcp.result-not-delivered'), () => {
    for (const name of ['mcp', 'mcp-yolo']) {
      const step = folderStep(name)
      // The model got the result…
      expect(step?.turns.flatMap((turn) => turn.responses).map((response) => response.output).join(' '), name).toContain(`${MCP_RESULT}probe`)
      // …the client never did: its completing update carries the model's summary.
      expect(JSON.stringify(step?.updates), name).not.toContain(MCP_RESULT)
      const done = step?.updates.find((update) => update.sessionUpdate === 'tool_call_update' && update.status === 'completed')
      expect(done?.rawOutput, name).toBe(MCP_SUMMARY)
      // The owner shows the call with no output rather than the summary as its result.
      const stream = new AcpMessageStream({ launcher: 'antigravity' })
      const parts = (step?.updates ?? []).flatMap((update) =>
        stream.apply({ sessionId: name, update } as unknown as SessionNotification).message?.parts ?? [])
      expect(parts.some((part) => part.metadata?.[KIND_METADATA_KEY] === 'tool'), name).toBe(true)
      expect(parts.filter((part) => part.metadata?.[KIND_METADATA_KEY] === 'tool_result'), name).toEqual([])
    }
  })

  it(entry('antigravity.mcp.list-changed'), () => {
    expect(chatStep('added')?.calls).toEqual(['probe_added'])
    expect(JSON.stringify(chatStep('added')?.turns.flatMap((turn) => turn.responses))).toContain(`${MCP_RESULT}probe_added`)
  })

  it(entry('antigravity.permission.execute-ask'), () => {
    const step = folderStep('command')
    const ask = step?.permissions[0]
    expect(step?.permissions).toHaveLength(1)
    expect(toolCallOf(ask)).toMatchObject({ kind: 'execute', title: `echo ${COMMAND_MARKER}`, rawInput: { CommandLine: `echo ${COMMAND_MARKER}`, Cwd: seen.folder.cwd, WaitMsBeforeAsync: 5000 } })
    expect(optionsOf(ask).map((option) => [option.optionId, option.kind])).toEqual([['allow_always', 'allow_always'], ['allow', 'allow_once'], ['deny', 'reject_once']])
    expect(keys(optionsOf(ask)[0]?._meta)).toEqual(['agy.security.warning'])
    // Ran under the ask's own id.
    const done = step?.updates.find((update) => update.sessionUpdate === 'tool_call_update' && update.status === 'completed')
    expect(done?.toolCallId).toBe(toolCallOf(ask).toolCallId)
  })

  it(entry('antigravity.permission.edit-ask'), () => {
    const step = folderStep('edit')
    const ask = step?.permissions[0]
    const askId = String(toolCallOf(ask).toolCallId)
    expect(toolCallOf(ask)).toMatchObject({ kind: 'edit', title: 'Run create_file?' })
    expect(((toolCallOf(ask).content as Json[] | undefined) ?? [])[0]).toMatchObject({ type: 'diff', newText: 'x\n' })
    expect(((toolCallOf(ask).locations as Json[] | undefined) ?? []).length).toBeGreaterThan(0)
    expect(optionsOf(ask).map((option) => [option.optionId, option.kind])).toEqual([['allow', 'allow_once'], ['deny', 'reject_once']])
    expect(seen.folder.fileWritten).toBe(true)
    const updates = step?.updates ?? []
    const ran = updates.find((update) => update.title === 'Running edit_file')
    expect(ran?.toolCallId).toBeTruthy()
    expect(ran?.toolCallId).not.toBe(askId)
    expect(updates.some((update) => update.toolCallId === ran?.toolCallId && update.status === 'completed')).toBe(true)
    expect(updates.find((update) => update.toolCallId === askId && update.status === 'failed')?.rawOutput).toBe(UNEXECUTED)
    // Our reader draws no failed card for it.
    const stream = new AcpMessageStream({ launcher: 'antigravity' })
    const parts = updates.flatMap((update) => stream.apply({ sessionId: 'edit', update } as unknown as SessionNotification).message?.parts ?? [])
    expect(JSON.stringify(parts)).not.toContain(UNEXECUTED)
  })

  it(entry('antigravity.question.permission-shaped'), () => {
    const step = folderStep('question')
    const ask = step?.permissions[0]
    expect(step?.permissions).toHaveLength(1)
    expect(toolCallOf(ask)).toMatchObject({ title: 'Deterministic?' })
    expect(String(toolCallOf(ask).toolCallId)).toMatch(/^interaction_[0-9a-f]+$/)
    expect(optionsOf(ask).map((option) => [option.optionId, option.name, option.kind])).toEqual([['1', 'Yes', 'allow_once'], ['2', 'No', 'allow_once']])
    expect(step?.updates.some((update) => update.sessionUpdate === 'tool_call' && update.toolCallId === toolCallOf(ask).toolCallId)).toBe(true)
    // The owner reads it as a question, and the chosen answer reached the model.
    const question = permissionAsQuestion('antigravity', ask?.params as never)
    expect(question?.questions[0]).toMatchObject({ question: 'Deterministic?', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] })
    expect(step?.turns.flatMap((turn) => turn.responses).find((response) => response.name === 'ask_question')?.output).toMatch(/A1: Yes/)
  })

  it(entry('antigravity.cancel.model-request'), () => {
    expect(seen.folder.cancelModel.result?.result?.stopReason).toBe('cancelled')
    expect(seen.folder.cancelModel.ms).toBeLessThan(10_000)
    expect(seen.folder.cancelModel.updates.some((update) => update.sessionUpdate === 'agent_message_chunk' &&
      (update.content as Json | undefined)?.text === 'The request was cancelled by the client.')).toBe(true)
  })

  it(entry('antigravity.cancel.running-command'), () => {
    const { result, ms, updates, ranLater } = seen.folder.cancelCommand
    expect(updates.some((update) => update.sessionUpdate === 'tool_call' && update.kind === 'execute')).toBe(true)
    expect(result?.result?.stopReason).toBe('cancelled')
    // Well before the three-second command could have finished on its own.
    expect(ms).toBeLessThan(2_500)
    expect(updates.some((update) => update.sessionUpdate === 'tool_call_update' && update.status === 'failed')).toBe(true)
    expect(ranLater).toBe(false)
  })

  it(entry('antigravity.config.model-option'), () => {
    const offered = configOption(seen.folder.sessionNew, 'model')
    expect(((offered?.options as Json[] | undefined) ?? []).map((option) => option.value)).toEqual([...MODELS])
    expect(offered?.currentValue).toBe(MODELS[0])
    expect(configOption(seen.folder.setup[0] ?? null, 'model')?.currentValue).toBe(MODEL)
    const conversation = seen.folder.steps.flatMap((step) => step.turns)
    expect(conversation.length).toBeGreaterThan(0)
    expect([...new Set(conversation.map((turn) => turn.model))]).toEqual([MODEL_PATH])
  })

  it(entry('antigravity.telemetry.usage-update'), () => {
    const usage = seen.folder.steps.flatMap((step) => step.updates).filter((update) => update.sessionUpdate === 'usage_update')
    expect(usage.length).toBeGreaterThan(0)
    for (const update of usage) {
      expect(keys(update)).toEqual(['sessionUpdate', 'size', 'used'])
      expect(update.used as number).toBeGreaterThan(0)
      expect(update.size as number).toBeGreaterThan(update.used as number)
    }
    const answer = folderStep('first')?.result.result
    expect(answer).toEqual({ stopReason: 'end_turn' })
    // The owner turns such an answer into no turn telemetry.
    expect(parsePromptTelemetry(answer, 'antigravity')).toBeNull()
  })

  it(entry('antigravity.policy.builtin-tools'), () => {
    expect(declared(seen.native.firstTurn)).toEqual([...ANTIGRAVITY_BUILTIN_TOOLS].sort())
  })

  it(entry('antigravity.policy.filter-names'), () => {
    const builtins = seen.native.firstTurn?.tools ?? []
    expect(builtins.length).toBeGreaterThan(0)
    const removed = (names: string): string[] => builtins.filter((tool) => !(seen.native.filters[names] ?? builtins).includes(tool)).sort()
    expect(removed('start_subagent')).toEqual(['define_subagent', 'invoke_subagent', 'manage_subagents', 'send_message'])
    expect(removed('create_file,edit_file')).toEqual(['replace_file_content', 'write_to_file'])
    expect(removed('send_message,define_subagent')).toEqual([])
    // Every filter name Cinna sends is one the server accepts: all of them
    // together leave no built-in declared.
    expect(seen.native.filters[ANTIGRAVITY_FILTER_TOOLS.join(',')]).toEqual([])
    // The launcher's sealed-folder denylist removes scheduling, subagents and messaging, and nothing else.
    expect(seen.folder.plan?.session.meta).toEqual({ agy: { disabledTools: [...ANTIGRAVITY_ISOLATED_DISABLED_TOOLS] } })
    const sealed = folderStep('first')?.turns[0]?.tools ?? []
    expect(builtins.filter((tool) => !sealed.includes(tool)).sort())
      .toEqual(['define_subagent', 'invoke_subagent', 'manage_subagents', 'schedule', 'send_message'])
  })

  it(entry('antigravity.policy.conductor-tools'), () => {
    expect(seen.chat.meta).toMatchObject({ agy: { enabledTools: [...ANTIGRAVITY_CONDUCTOR_TOOLS] } })
    expect(seen.chat.turns.length).toBeGreaterThan(0)
    for (const turn of seen.chat.turns) expect(declared(turn)).toEqual(['call_mcp_tool', 'list_resources', 'read_resource', 'view_file'])
    expect(chatStep('mcp')?.calls).toEqual(['probe'])
    const schema = chatStep('schema')?.turns.flatMap((turn) => turn.responses).find((response) => response.name === 'view_file')?.output ?? ''
    expect(schema).toContain('probe')
    expect(schema).not.toMatch(/failed with error/)
    const outside = chatStep('outside')?.turns.flatMap((turn) => turn.responses).find((response) => response.name === 'view_file')?.output ?? ''
    expect(outside).toMatch(/outside the allowed workspace/)
    expect(outside).not.toContain('PRIVATE_CHAT_INSTRUCTIONS')
  })

  it(entry('antigravity.provider.requests'), () => {
    const all = [...seen.folder.turns, ...seen.chat.turns]
    expect(all.length).toBeGreaterThan(0)
    for (const turn of all) {
      expect(turn.path).toMatch(/^\/v1beta\/models\/[^/:]+:streamGenerateContent\?alt=sse$/)
      expect(turn.authorization).toBe('Bearer contract-fake-key')
    }
    // Nothing of the server's own: every request without a tool result opens a prompt Cinna sent.
    const prompts = seen.folder.steps.length + 2 /* both cancels */ + 1 /* after load */ + seen.chat.steps.length
    expect(all.filter((turn) => turn.responses.length === 0)).toHaveLength(prompts)
  })

  // Last on purpose: it reads what every scenario above observed. Not a registry entry.
  it('the observed shapes match the committed snapshot', () => {
    expect(buildLabel(seen.version.output), 'the server never reported a build label, so there is nothing to snapshot').toBeTruthy()
    const observed = JSON.stringify(sorted(snapshot()), null, 2) + '\n'
    const pinnedPath = join(here, 'snapshots', `antigravity-${RUNTIME_PINS.antigravity.cli}.json`)
    const pinned = existsSync(pinnedPath) ? readFileSync(pinnedPath, 'utf8') : null

    if (candidate) {
      // A candidate is expected to differ: report, never fail, and never land in the tree.
      const version = buildLabel(seen.version.output) ?? 'candidate'
      const directory = join(tmpdir(), 'cinna-contract-snapshots')
      mkdirSync(directory, { recursive: true })
      const path = join(directory, `antigravity-${version}.json`)
      writeFileSync(path, observed)
      const diff = pinned === null ? '(no pinned snapshot to compare with)' : lineDiff(pinned, observed)
      writeFileSync(path.replace(/\.json$/, '.diff'), diff ? `${diff}\n` : '')
      console.log(`\n--- snapshot diff: antigravity ${RUNTIME_PINS.antigravity.cli} -> ${version} (candidate snapshot: ${path})\n${diff || '(no observed change)'}\n`)
      return
    }
    if (writeSnapshot) {
      mkdirSync(dirname(pinnedPath), { recursive: true })
      writeFileSync(pinnedPath, observed)
      return
    }
    expect(pinned, `no committed snapshot at ${pinnedPath} — write it with \`make contract-snapshot ENGINE=antigravity\``).not.toBeNull()
    const diff = lineDiff(pinned ?? '', observed)
    expect(diff === '', `the pinned server no longer matches its committed snapshot (- committed, + observed):\n${diff}\n` +
      'If the change is intended: make contract-snapshot ENGINE=antigravity').toBe(true)
  })
})
