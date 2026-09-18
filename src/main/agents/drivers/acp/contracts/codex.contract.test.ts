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
import { airClientMeta } from '../acpActivity'
import type { AcpLaunchPlan } from '../acpLaunchers'
import { CODEX_CONTRACT } from './codex.contract'
import { lineDiff, sorted } from './snapshotTools'
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
/** The model 0.155.0 names threads on. Not configured by Cinna, and not the conversation's. */
const TITLE_MODEL = 'gpt-5.6-luna'
const FIRST_PROMPT = 'Answer OK.'
const NEXT_MODEL_PROMPT = 'Answer OK on the new model.'
const CHAT_FIRST_PROMPT = 'Call the Cinna probe, then answer OK.'
const UTILITY_MARKER = 'CONTRACT_UTILITY_PROMPT_b09'
const UTILITY_PROMPT = 'CONTRACT_UTILITY_INPUT_4d7'
const FOLDER_MARKER = 'CONTRACT_FOLDER_INSTRUCTIONS_7c1'
const POLICY_MARKER = 'CONTRACT_SESSION_PROMPT_e52'
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
    provider = await startFakeProvider((turn): ProviderReply => {
      // The CLI's own requests (thread title, compaction) are told apart by
      // content, never by model; only the conversation is scripted, so they
      // cannot consume a scripted step.
      if (turn.kind !== 'conversation') return ownRequestReply(turn)
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
      env: { ...scratch.env, CODEX_PATH: wrapper, INITIAL_AGENT_MODE: 'read-only', MODEL_PROVIDER: 'probe',
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
    for (const modeId of ['agent', 'read-only']) {
      seen.setModes[modeId] = !(await connection.rpc('session/set_mode', { sessionId, modeId })).error
    }
    const prompt = (text: string, timeoutMs?: number): Promise<AdapterMessage> =>
      connection!.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, timeoutMs)

    await prompt(FIRST_PROMPT)
    // The title request runs beside the turn, not inside it: give it a moment to land.
    await until(() => provider!.turns.some((turn) => turn.kind === 'title'), 5_000)
    // And the title it produced is reported after that, often after the turn.
    const infoTitles = (): string[] => connection!.updates
      .filter((update) => update.sessionUpdate === 'session_info_update' && typeof update.title === 'string')
      .map((update) => String(update.title))
    await until(() => infoTitles().some((title) => title !== FIRST_PROMPT), 5_000)
    seen.infoTitles = infoTitles()
    seen.firstTurn = provider.turns.find((turn) => turn.kind === 'conversation') ?? null

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
    await prompt(NEXT_MODEL_PROMPT)
    await sleep(1500)
    seen.afterModelChange = provider.turns.slice(changedAt)
    seen.folderTurns = [...provider.turns]

    // Last: a refused request may leave the session in an error state.
    mode = 'rate-limit'
    const updatesBefore = connection.updates.length
    seen.rateLimit = await prompt('This request is rate limited.')
    await sleep(300)
    seen.rateLimitUpdates = connection.updates.slice(updatesBefore)
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
        env: { ...scratch.env, CODEX_PATH: binary, INITIAL_AGENT_MODE: 'read-only', MODEL_PROVIDER: 'probe',
          CODEX_CONFIG: JSON.stringify({ model: MODEL, model_provider: 'probe', developer_instructions: POLICY_MARKER }) } },
      init: { protocolVersion: 1 }, session: { mcpServers: [] }, setup: { modeId: 'read-only' }
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
        authMethodIds: ((init.authMethods as Json[] | undefined) ?? []).map((method) => String(method.id)).sort(), resultKeys: keys(init) },
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
    restrictedPolicy: {
      marker: seen.policy.marker,
      offeredTools: [...new Set(seen.policy.turns.flatMap((turn) => turn.tools))].sort(),
      collaborationModeValues: (((seen.policy.collaborationOption?.options as Json[] | undefined) ?? []).map((option) => String(option.value ?? option.id))).sort(),
      questionInDefaultMode: seen.policy.questionOutputs.filter((output) => /Default mode/i.test(output)).map((output) => output.slice(0, 120)),
      questionClientRequests: seen.policy.questionClientRequests
    }
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
    expect((seen.sessionNew?.result?.modes as Json | undefined)?.currentModeId).toBe('read-only')
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
    expect(ids).toEqual(expect.arrayContaining(['read-only', 'agent']))
    expect(seen.setModes).toEqual({ agent: true, 'read-only': true })
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
    // Pinned to what 0.155.0 was observed doing (2026-09-18), in all three kinds of session.
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
