import { beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUNTIME_PINS } from '../../../../../shared/runtimePins'
import { ConductorMcpServer } from '../../../../services/conductorMcpServer'
import { applyConductorToolPolicy, cinnaToolName } from '../conductorToolPolicy'
import { parseClaudeAuthStatus } from '../claudeAuth'
import { airClientMeta } from '../acpActivity'
import type { AcpLaunchPlan } from '../acpLaunchers'
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
  question: { request: null as AdapterMessage | null, toolResults: [] as string[] },
  nativeMentionsClaudeMd: false, isolatedMentionsClaudeMd: true,
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
  egress: [] as string[]
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
    const isolated = { systemPrompt: SYSTEM_MARKER, settingSources: [], strictMcpConfig: true, mcpServers: {},
      agents: { [SUBAGENT]: { description: 'A contract subagent.', prompt: 'Answer OK.' } } }
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

    script = [{ kind: 'tool', name: 'AskUserQuestion', input: { questions: [{ question: 'Deterministic?', header: 'Probe', multiSelect: false,
      options: [{ label: 'Yes', description: 'Accept' }, { label: 'No', description: 'Decline' }] }] } }]
    await connection.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Ask a question.' }] }, 90_000)
    seen.question.toolResults = provider.turns.flatMap((turn) => turn.toolResults)
    seen.folderTurns = [...provider.turns]
    seen.isolatedMentionsClaudeMd = conversation(provider.turns).some((turn) => turn.mentions(CLAUDE_MD_MARKER))

    // The native branch, in the same folder: the launcher's other set of options.
    const before = provider.turns.length
    const native = await connection.rpc('session/new', { cwd: scratch.cwd, mcpServers: [], _meta: { claudeCode: { options: {
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'CONTRACT_NATIVE_APPEND' }, settingSources: ['user', 'project', 'local'] } } } }, 60_000)
    const nativeId = String(native.result?.sessionId ?? '')
    if (nativeId) {
      await connection.rpc('session/set_mode', { sessionId: nativeId, modeId: 'default' })
      await connection.rpc('session/prompt', { sessionId: nativeId, prompt: [{ type: 'text', text: 'Answer OK.' }] }, 90_000)
      seen.nativeMentionsClaudeMd = conversation(provider.turns.slice(before)).some((turn) => turn.mentions(CLAUDE_MD_MARKER))
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
    const air = (((result._meta as Json | undefined)?.jetbrains as Json | undefined)?.air as Json | undefined)?.capabilities
    expect(air).toEqual(expect.arrayContaining(['asyncTasks', 'nativeSubagentSessions']))
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

  it(entry('claude.session.set-mode'), () => {
    expect(seen.setModes).toEqual({ auto: true, default: true })
    expect((seen.sessionNew?.result?.modes as Json | undefined)?.currentModeId).toEqual(expect.any(String))
  })

  it(entry('claude.session.permission-mode-meta-inert'), () => {
    expect(seen.policyOptions).toMatchObject({ permissionMode: 'bypassPermissions' })
    expect(seen.bypassInMetaMode).toBe('default')
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

  /* tools & MCP */
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

  it(entry('claude.question.elicitation-form'), () => {
    expect(conversation(seen.folderTurns)[0]?.tools).toContain('AskUserQuestion')
    const params = (seen.question.request?.params ?? {}) as Json
    expect(params).toMatchObject({ mode: 'form', message: 'Deterministic?' })
    const property = ((params.requestedSchema as Json | undefined)?.properties as Json | undefined)?.question_0 as Json | undefined
    expect(((property?.oneOf as Json[] | undefined) ?? []).map((option) => option.const)).toEqual(['Yes', 'No'])
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
