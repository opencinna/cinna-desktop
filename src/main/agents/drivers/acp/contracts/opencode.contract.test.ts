import { beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import type { CreateElicitationRequest, PermissionOption } from '@agentclientprotocol/sdk'
import { RUNTIME_PINS } from '../../../../../shared/runtimePins'
import { opencodeMajorVersion } from '../../../../../shared/engine'
import { ConductorMcpServer, type ConductorMcpSession } from '../../../../services/conductorMcpServer'
import { createOpencodeLauncher, isRefusal, OPENCODE_NO_COMPATIBILITY_PLUGIN, type AcpLaunchPlan } from '../acpLaunchers'
import { startAcpConnection } from '../acpConnection'
import { pickPermissionOption } from '../acpPermissions'
import { toElicitationContent, toInputQuestions } from '../acpQuestions'
import { codeModeCinnaTools, isCodeModeCall } from '../conductorToolPolicy'
import { OPENCODE_CONTRACT } from './opencode.contract'
import { lineDiff, sorted } from './snapshotTools'
import { startEgressTrap, type EgressTrap } from './claudeHarness'
import {
  KIT_ARTIFACTS_SKILL_MARKER, KIT_SKILL_MARKER, PERSONAL_MARKERS, descendantsOf, findContractOpencode, isAlive, makeOpencodeScratch, reap, spawnAcp, startFakeOpenAi,
  type AcpConnection, type AcpMessage, type FakeOpenAi, type OpenAiReply, type OpenAiTurn, type OpencodeScratch
} from './opencodeHarness'

/**
 * The OpenCode interface contract, checked against the **real** binary.
 *
 * `npm run test:contract` (its own vitest config — never part of `npm test`):
 * the managed pinned `opencode acp` over real stdio — OpenCode speaks ACP
 * itself, there is no adapter — against a loopback fake OpenAI-compatible
 * provider, in a scratch HOME behind the egress trap. One `it` per entry of
 * `opencode.contract.ts`, its title starting with the entry's id —
 * `contractRegistry.test.ts` holds that mapping.
 *
 * One scenario is driven once in `beforeAll`, planned by the **production**
 * `createOpencodeLauncher` (so the config is `buildEngineConfig`'s and the
 * environment the launcher's): a folder agent with Cinna's MCP server
 * attached runs a shell prompt (Cinna refuses the secret read), a Cinna-tool
 * prompt, a question prompt and a thinking prompt; the process is then
 * SIGTERMed, the session loaded in a fresh one and prompted again, and that
 * one SIGKILLed; a process on another database is then asked to load the same
 * session. Every `it` asserts on what was observed.
 *
 * The pinned binary is compared with the committed
 * `snapshots/opencode-<version>.json` (the last test), written only by
 * `make contract-snapshot ENGINE=opencode`.
 *
 * `CINNA_CONTRACT_OPENCODE=/abs/opencode` runs all of it against a candidate
 * without touching the pin; `make contract-next ENGINE=opencode VERSION=…`
 * installs one from npm and does exactly that.
 */

const here = dirname(fileURLToPath(import.meta.url))
const binaryRef = findContractOpencode(RUNTIME_PINS.opencode.cli)
const candidate = binaryRef?.source === 'override'

/** No binary is a failure, not a skip — see `codex.contract.test.ts`. */
const allowSkip = process.env['CINNA_CONTRACT_ALLOW_SKIP'] === '1'
const NO_BINARY =
  `The OpenCode contract needs the managed OpenCode ${RUNTIME_PINS.opencode.cli} and found none — nothing was checked.\n` +
  '  Install it with:  make contract ENGINE=opencode   (or: node --experimental-strip-types scripts/install-runtime.mjs opencode)\n' +
  '  Or point CINNA_CONTRACT_OPENCODE at an opencode executable.\n' +
  '  To skip knowingly: CINNA_CONTRACT_ALLOW_SKIP=1'
if (!binaryRef && allowSkip) console.warn(`\nSKIPPED: ${NO_BINARY}\n`)

const writeSnapshot = process.env['CINNA_CONTRACT_WRITE_SNAPSHOT'] === '1'

const AGENT_ID = 'folder:contract'
const PROVIDER_ID = 'prov-contract'
const MODEL_ID = 'contract-model'
const SYSTEM_MARKER = 'CONTRACT_AGENT_PROMPT_5d2'
const SHELL_PROMPT = 'CONTRACT_SHELL_PROMPT: list the folder, then read .env.'
const CINNA_PROMPT = 'CONTRACT_CINNA_PROMPT: call the Cinna probe tool.'
const QUESTION_PROMPT = 'CONTRACT_QUESTION_PROMPT: ask me which one.'
const THINK_PROMPT = 'CONTRACT_THINK_PROMPT: think, then answer.'
const SUBAGENT_PROMPT = 'CONTRACT_SUBAGENT_PROMPT: hand it to a subagent.'
/** The child session's own prompt, the `subagent` call's description (the child's title), and its report. */
const CHILD_PROMPT = 'CONTRACT_CHILD_PROMPT: report back.'
const CHILD_DESCRIPTION = 'Contract child'
const CHILD_REPORT = 'CONTRACT_CHILD_REPORT'
const READ_PROMPT = 'CONTRACT_READ_PROMPT: read .env with the read tool.'
/** The control for {@link READ_PROMPT}: the same `read`, of a file no pattern names. */
const PLAIN_READ_PROMPT = 'CONTRACT_PLAIN_READ_PROMPT: read readme.txt with the read tool.'
const CONTROL_PROMPT = 'CONTRACT_CONTROL_PROMPT: just answer.'
const RESUME_PROMPT = 'CONTRACT_RESUME_PROMPT: answer after the restart.'
const AFTER_DENY_TEXT = 'CONTRACT_AFTER_DENY'
const PROBE_RESULT = 'CONTRACT_PROBE_RESULT_c3'
const REASONING_TEXT = 'CONTRACT_REASONING_e8'
const SECRET = 'CONTRACT_SECRET_VALUE_f1'
/** `opencode.launch.database-first-start`: rounds, each a fresh database and this many concurrent launcher starts. */
const FIRST_START_ROUNDS = 4
const FIRST_START_PROCESSES = 3
/** The option the question offers that the client answers with. */
const ANSWER_LABEL = 'Beta'

type Json = Record<string, unknown>
const keys = (value: unknown): string[] => (value && typeof value === 'object' ? Object.keys(value as Json).sort() : [])
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check: () => boolean, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (check()) return true; await sleep(50) }
  return check()
}

interface PromptObservation {
  answer: AcpMessage | null
  /** Client requests (asks, elicitations) the prompt raised. */
  requests: AcpMessage[]
  /** Its `session/update`s. */
  updates: Json[]
  /** Its other notifications (extensions). */
  ext: AcpMessage[]
  /** Its conversation requests to the provider. */
  turns: OpenAiTurn[]
}
const emptyPrompt = (): PromptObservation => ({ answer: null, requests: [], updates: [], ext: [], turns: [] })

/** Everything the scenario observed. Filled by `beforeAll`. */
const seen = {
  versionOutput: '', versionStatus: null as number | null,
  plan: null as AcpLaunchPlan | null,
  initialize: null as AcpMessage | null,
  sessionNew: null as AcpMessage | null,
  /** Whether Cinna's server answered the session's `tools/list` within 10 s of `session/new`, and the probe calls of the eager prompt. */
  mcp: { listedAfter: false, eagerCalls: 0, calls: [] as string[] },
  setConfig: [] as { configId: string; message: AcpMessage }[],
  shell: emptyPrompt(), cinna: emptyPrompt(), question: emptyPrompt(), think: emptyPrompt(), subagent: emptyPrompt(), eager: emptyPrompt(), read: emptyPrompt(), plainRead: emptyPrompt(),
  /** A session on the generated config with `plugins: []`: the personal-skills control. */
  control: emptyPrompt(),
  /** Per round of concurrent first starts on a fresh database, each process's outcome (`ok` once `session/new` answered). */
  firstStarts: [] as string[][],
  /** The first SIGTERM and the later SIGKILL of the `acp` process alone. */
  kills: {} as Record<'SIGTERM' | 'SIGKILL', { descendants: number; sameGroup: boolean; exited: boolean; orphans: number }>,
  load: { message: null as AcpMessage | null, replay: [] as Json[] },
  /** `session/load` of that session in a process on another database: the answer, its replay, and how long it took. */
  loadUnknown: { message: null as AcpMessage | null, replay: [] as Json[], ms: 0 },
  /** The `opencode.db*` files at `OPENCODE_DB`'s directory and under XDG data, after every process has gone. */
  database: { atOpencodeDb: [] as string[], underXdgData: [] as string[] },
  /** The `plugins` the launcher wrote into the generated `opencode.json`. */
  configPlugins: null as unknown,
  resume: emptyPrompt(),
  egress: [] as string[],
  otherProviderRequests: [] as string[],
  auxiliaryRequests: 0
}

const shellTool = (turn: OpenAiTurn): string | undefined => turn.tools.find((name) => name === 'bash' || name === 'shell')

/** The scripted model: which prompt a request is about decides the reply, and how far the model got in it. */
function decide(turn: OpenAiTurn): OpenAiReply {
  if (turn.kind === 'auxiliary') return { kind: 'text', text: 'Contract title' }
  const step = turn.pendingToolResults.length
  const about = turn.lastUserText
  if (about.includes('CONTRACT_SHELL_PROMPT')) {
    const shell = shellTool(turn)
    if (!shell || step >= 2) return { kind: 'text', text: AFTER_DENY_TEXT }
    const args: Json = { command: step === 0 ? 'ls' : 'cat .env' }
    if ((turn.toolParams[shell] ?? []).includes('description')) args.description = 'contract'
    return { kind: 'tool', name: shell, args }
  }
  if (about.includes('CONTRACT_CINNA_PROMPT')) {
    if (step > 0) return { kind: 'text', text: 'CINNA_DONE' }
    if (turn.tools.includes('cinna_probe')) return { kind: 'tool', name: 'cinna_probe', args: {} }
    if (turn.tools.includes('execute')) return { kind: 'tool', name: 'execute', args: { code: 'return await tools["cinna"].probe({})' } }
    return { kind: 'text', text: 'NO_CINNA_TOOL' }
  }
  if (about.includes('CONTRACT_QUESTION_PROMPT')) {
    if (step > 0 || !turn.tools.includes('question')) return { kind: 'text', text: 'QUESTION_DONE' }
    return { kind: 'tool', name: 'question', args: { questions: [{ question: 'Which one?', header: 'Pick',
      options: [{ label: 'Alpha', description: 'the first' }, { label: ANSWER_LABEL, description: 'the second' }] }] } }
  }
  // The child's request carries its own prompt, so it is told apart before its parent's.
  if (about.includes('CONTRACT_CHILD_PROMPT')) return { kind: 'text', text: CHILD_REPORT }
  if (about.includes('CONTRACT_SUBAGENT_PROMPT')) {
    if (step > 0 || !turn.tools.includes('subagent')) return { kind: 'text', text: 'SUBAGENT_DONE' }
    return { kind: 'tool', name: 'subagent', args: { agent: 'general', description: CHILD_DESCRIPTION, prompt: CHILD_PROMPT } }
  }
  if (about.includes('CONTRACT_THINK_PROMPT')) return { kind: 'text', text: 'THOUGHT_DONE', reasoning: REASONING_TEXT }
  const readOf = about.includes('CONTRACT_READ_PROMPT') ? '.env' : about.includes('CONTRACT_PLAIN_READ_PROMPT') ? 'readme.txt' : null
  if (readOf) {
    if (step > 0 || !turn.tools.includes('read')) return { kind: 'text', text: 'READ_DONE' }
    // 2.x's `read` takes `path`; 1.x took `filePath`.
    const params = turn.toolParams['read'] ?? []
    return { kind: 'tool', name: 'read', args: { [params.includes('path') ? 'path' : 'filePath']: readOf } }
  }
  return { kind: 'text', text: 'OK' }
}

/** Which prompt is running: the shell prompt's asks are refused the way Cinna's Deny answers them, everything else allowed once. */
let phase: 'shell' | 'other' = 'other'
function answer(request: AcpMessage): Json | undefined {
  if (request.method === 'session/request_permission') {
    const options = (request.params?.options ?? []) as PermissionOption[]
    const optionId = pickPermissionOption(options, phase === 'shell' ? 'reject' : 'allow')
    return optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } }
  }
  if (request.method === 'elicitation/create') {
    const form = toInputQuestions(request.params as unknown as CreateElicitationRequest)
    if (!form) return { action: 'decline' }
    return { action: 'accept', content: toElicitationContent(form, form.questions.map(() => [ANSWER_LABEL])) }
  }
  return undefined
}

/** Signal the `acp` process alone and report what is left of its tree. */
async function killAlone(connection: AcpConnection, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  const descendants = descendantsOf(connection.pid)
  const group = (pid: number): string => spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()
  const leader = group(connection.pid)
  const sameGroup = descendants.every((pid) => group(pid) === leader)
  connection.kill(signal)
  await until(() => connection.exited() && descendants.every((pid) => !isAlive(pid)), 5_000)
  const orphans = descendants.filter(isAlive)
  seen.kills[signal] = { descendants: descendants.length, sameGroup, exited: connection.exited(), orphans: orphans.length }
  reap(orphans)
}

async function scenario(binary: string): Promise<void> {
  let trap: EgressTrap | undefined
  let provider: FakeOpenAi | undefined
  let scratch: OpencodeScratch | undefined
  let connection: AcpConnection | undefined
  const mcp = new ConductorMcpServer()
  try {
    trap = await startEgressTrap()
    provider = await startFakeOpenAi(decide)
    scratch = makeOpencodeScratch('cinna-contract-opencode-', { trapPort: trap.port })
    writeFileSync(join(scratch.cwd, '.env'), `SECRET=${SECRET}\n`)
    writeFileSync(join(scratch.cwd, 'readme.txt'), 'hello\n')
    const version = spawnSync(binary, ['--version'], { cwd: scratch.cwd, env: scratch.env, encoding: 'utf8', timeout: 20_000 })
    seen.versionOutput = (version.stdout ?? '').trim()
    seen.versionStatus = version.status
    const port = provider.port
    const env = scratch.env
    const launcher = createOpencodeLauncher({
      binary: async () => ({ path: binary, version: seen.versionOutput || null }),
      configInput: async () => ({
        providers: [{ id: PROVIDER_ID, type: 'openai_compatible', name: 'Contract fake', apiKey: 'sk-contract-dummy-not-a-real-key',
          baseUrl: `http://127.0.0.1:${port}/v1`, models: [{ id: MODEL_ID, name: 'Contract model' }] }],
        agents: [{ agentId: AGENT_ID, slug: 'contract', description: 'contract', prompt: `${SYSTEM_MARKER} You are the contract agent.`,
          providerId: PROVIDER_ID, modelId: MODEL_ID }],
        skillPaths: scratch!.kitSkillDirs
      }),
      configRoot: () => scratch!.configRoot,
      childEnv: async () => ({ ...env })
    })
    const planned = await launcher.plan({ userId: 'contract', agentId: AGENT_ID,
      folder: { name: 'Contract', slug: 'contract', description: '', path: scratch.cwd, kind: 'kit', runtimeMode: 'isolated' } })
    if (isRefusal(planned)) throw new Error(`the launcher refused: ${planned.error}`)
    const plan = planned
    seen.plan = plan
    const configPath = plan.spec.env['OPENCODE_CONFIG']
    seen.configPlugins = configPath ? (JSON.parse(readFileSync(configPath, 'utf8')) as Json).plugins ?? null : null
    const lease: ConductorMcpSession = await mcp.ensureSession('opencode-contract', { getProviders: () => [{
      providerType: 'mcp', displayName: 'Contract',
      getTools: () => [{ name: 'probe', description: 'Return the contract result.', inputSchema: { type: 'object', properties: {} }, mcpProviderId: 'probe', providerType: 'mcp' }],
      callTool: async (name: string) => { seen.mcp.calls.push(name); return { content: PROBE_RESULT } }
    }] } as never)

    const start = (): AcpConnection => spawnAcp({ command: plan.spec.command, args: plan.spec.args, cwd: plan.spec.cwd, env: plan.spec.env, answer })
    connection = start()
    seen.initialize = await connection.rpc('initialize', plan.init as unknown as Json, 60_000)
    const mark = lease.toolsListings()
    seen.sessionNew = await connection.rpc('session/new', { cwd: scratch.cwd, mcpServers: [lease.descriptor] }, 60_000)
    const listedAt = await lease.toolsListed(mark, 10_000)
    seen.mcp.listedAfter = listedAt !== null
    // What the driver's `awaitCinnaTools` waits on top, where the plan says so.
    if (listedAt !== null && plan.awaitMcpTools) await sleep(Math.max(0, listedAt + plan.awaitMcpTools.settleMs - Date.now()))
    const sessionId = String(seen.sessionNew.result?.sessionId ?? '')
    if (!sessionId) return
    const setup = async (conn: AcpConnection, session: string): Promise<{ configId: string; message: AcpMessage }[]> => {
      const out: { configId: string; message: AcpMessage }[] = []
      for (const option of plan.setup.configOptions ?? []) {
        out.push({ configId: option.configId, message: await conn.rpc('session/set_config_option', { sessionId: session, configId: option.configId, value: option.value }) })
      }
      return out
    }
    seen.setConfig = await setup(connection, sessionId)

    const prompt = async (conn: AcpConnection, text: string, into: PromptObservation, settleMs = 300, session = sessionId): Promise<void> => {
      const requestsAt = conn.clientRequests.length, updatesAt = conn.updates.length, extAt = conn.notifications.length, turnsAt = provider!.turns.length
      into.answer = await conn.rpc('session/prompt', { sessionId: session, prompt: [{ type: 'text', text }] }, 90_000)
      await sleep(settleMs)
      into.requests = conn.clientRequests.slice(requestsAt)
      into.updates = conn.updates.slice(updatesAt)
      into.ext = conn.notifications.slice(extAt)
      into.turns = provider!.turns.slice(turnsAt).filter((turn) => turn.kind === 'conversation')
    }
    phase = 'shell'
    await prompt(connection, SHELL_PROMPT, seen.shell, 1000)
    phase = 'other'
    await prompt(connection, CINNA_PROMPT, seen.cinna)
    await prompt(connection, QUESTION_PROMPT, seen.question)
    await prompt(connection, THINK_PROMPT, seen.think)
    await prompt(connection, SUBAGENT_PROMPT, seen.subagent, 1000)
    // The secret read again, through `read` rather than the shell; any ask is
    // refused the way Cinna's Deny answers it.
    // First its control: the same call of a file no pattern names, under the
    // same refusal, completes — so the denial below is the `read` map's.
    phase = 'shell'
    await prompt(connection, PLAIN_READ_PROMPT, seen.plainRead, 1000)
    await prompt(connection, READ_PROMPT, seen.read, 1000)
    phase = 'other'

    // The process goes, and the session is resumed on a fresh one the way the
    // driver resumes a chat after a restart.
    await killAlone(connection, 'SIGTERM')
    await connection.close()
    connection = start()
    await connection.rpc('initialize', plan.init as unknown as Json, 60_000)
    const loadUpdatesAt = connection.updates.length
    seen.load.message = await connection.rpc('session/load', { sessionId, cwd: scratch.cwd, mcpServers: [lease.descriptor] }, 60_000)
    await sleep(300)
    seen.load.replay = connection.updates.slice(loadUpdatesAt)
    if (!seen.load.message.error) {
      await setup(connection, sessionId)
      await prompt(connection, RESUME_PROMPT, seen.resume)
    }
    await killAlone(connection, 'SIGKILL')
    await connection.close()

    // A fresh process whose first session is prompted the moment its setup is
    // done, with no wait for Cinna's tools: what a turn did before
    // `awaitMcpTools`.
    connection = start()
    await connection.rpc('initialize', plan.init as unknown as Json, 60_000)
    const eager = await connection.rpc('session/new', { cwd: scratch.cwd, mcpServers: [lease.descriptor] }, 60_000)
    const eagerId = String(eager.result?.sessionId ?? '')
    if (eagerId) {
      await setup(connection, eagerId)
      const callsAt = seen.mcp.calls.length
      await prompt(connection, CINNA_PROMPT, seen.eager, 300, eagerId)
      seen.mcp.eagerCalls = seen.mcp.calls.length - callsAt
    }
    await connection.close()

    // The same session asked of a process on another database: what an old
    // chat, whose session lives in the user's shared database, meets now.
    const otherDb = join(scratch.root, 'other-db', 'opencode.db')
    mkdirSync(dirname(otherDb), { recursive: true })
    connection = spawnAcp({ command: plan.spec.command, args: plan.spec.args, cwd: plan.spec.cwd, env: { ...plan.spec.env, OPENCODE_DB: otherDb }, answer })
    await connection.rpc('initialize', plan.init as unknown as Json, 60_000)
    const unknownAt = connection.updates.length
    const startedAt = Date.now()
    seen.loadUnknown.message = await connection.rpc('session/load', { sessionId, cwd: scratch.cwd, mcpServers: [lease.descriptor] }, 30_000)
    seen.loadUnknown.ms = Date.now() - startedAt
    await sleep(300)
    seen.loadUnknown.replay = connection.updates.slice(unknownAt)
    await connection.close()

    // The personal-skills control: the generated config with its `plugins`
    // entry emptied, in a config directory of its own, so the markers'
    // absence above is the plugin entry's doing and not a HOME never read.
    const controlDir = join(scratch.root, 'control-config')
    mkdirSync(controlDir, { recursive: true })
    const controlConfig = join(controlDir, 'opencode.json')
    writeFileSync(controlConfig, JSON.stringify({ ...(JSON.parse(readFileSync(configPath ?? '', 'utf8')) as Json), plugins: [] }, null, 2))
    connection = spawnAcp({ command: plan.spec.command, args: plan.spec.args, cwd: plan.spec.cwd,
      env: { ...plan.spec.env, OPENCODE_CONFIG: controlConfig, OPENCODE_CONFIG_DIR: controlDir }, answer })
    await connection.rpc('initialize', plan.init as unknown as Json, 60_000)
    const control = await connection.rpc('session/new', { cwd: scratch.cwd, mcpServers: [] }, 60_000)
    const controlId = String(control.result?.sessionId ?? '')
    if (controlId) {
      await setup(connection, controlId)
      await prompt(connection, CONTROL_PROMPT, seen.control, 300, controlId)
    }
    await connection.close()

    seen.firstStarts = await firstStarts(binary, scratch, port)

    const database = plan.spec.env['OPENCODE_DB'] ?? ''
    const dbFiles = (dir: string): string[] => {
      try { return readdirSync(dir).filter((name) => name.startsWith('opencode.db')).sort() } catch { return [] }
    }
    seen.database = {
      atOpencodeDb: database ? dbFiles(dirname(database)) : [],
      underXdgData: dbFiles(join(scratch.env['XDG_DATA_HOME'] ?? '', 'opencode'))
    }
  } finally {
    await connection?.close()
    await mcp.dispose()
    seen.egress = [...new Set(trap?.attempts ?? [])].sort()
    seen.otherProviderRequests = [...new Set(provider?.otherRequests ?? [])].sort()
    seen.auxiliaryRequests = provider?.turns.filter((turn) => turn.kind === 'auxiliary').length ?? 0
    await provider?.close()
    await trap?.close()
    scratch?.dispose()
  }
}

/** The causes of the engine log's newest errors (the stderr tail is only a stack): why a start died. */
function engineErrors(scratch: OpencodeScratch): string {
  try {
    const log = readFileSync(join(scratch.env['XDG_DATA_HOME'] ?? '', 'opencode', 'log', 'opencode.log'), 'utf8')
    return log.split('\n').filter((line) => line.includes('level=ERROR')).slice(-3)
      .map((line) => /cause="([^"]*)"/.exec(line)?.[1] ?? line.slice(0, 160)).join(' | ')
  } catch {
    return 'no engine log'
  }
}

/**
 * `opencode.launch.database-first-start`: per round, a fresh config root (so a
 * database that does not exist yet) and {@link FIRST_START_PROCESSES} agents
 * planned together by one production launcher, then all started at once
 * through the production `startAcpConnection` — which honours the spec's
 * `earlyExitRetry` — and taken to `session/new`. Several rounds, because the
 * races the bootstrap and the retry absorb do not lose every time.
 */
async function firstStarts(binary: string, scratch: OpencodeScratch, port: number): Promise<string[][]> {
  const rounds: string[][] = []
  const agents = Array.from({ length: FIRST_START_PROCESSES }, (_, index) => ({ agentId: `folder:first-${index}`, slug: `first-${index}`,
    description: 'first start', prompt: 'You are a first-start agent.', providerId: PROVIDER_ID, modelId: MODEL_ID }))
  for (let round = 0; round < FIRST_START_ROUNDS; round++) {
    const configRoot = join(scratch.root, `first-start-${round}`)
    const launcher = createOpencodeLauncher({
      binary: async () => ({ path: binary, version: seen.versionOutput || null }),
      configInput: async () => ({
        providers: [{ id: PROVIDER_ID, type: 'openai_compatible', name: 'Contract fake', apiKey: 'sk-contract-dummy-not-a-real-key',
          baseUrl: `http://127.0.0.1:${port}/v1`, models: [{ id: MODEL_ID, name: 'Contract model' }] }],
        agents
      }),
      configRoot: () => configRoot,
      childEnv: async () => ({ ...scratch.env })
    })
    const plans = await Promise.all(agents.map((agent) => launcher.plan({ userId: 'contract', agentId: agent.agentId,
      folder: { name: agent.slug, slug: agent.slug, description: '', path: scratch.cwd, kind: 'kit', runtimeMode: 'isolated' } })))
    rounds.push(await Promise.all(plans.map(async (planned) => {
      if (isRefusal(planned)) return `refused: ${planned.error}`
      let connection: Awaited<ReturnType<typeof startAcpConnection>> | undefined
      try {
        connection = await startAcpConnection(planned.spec, planned.init)
        const created = await connection.newSession({ cwd: scratch.cwd, mcpServers: [] })
        return typeof created.sessionId === 'string' ? 'ok' : 'session/new: no session'
      } catch (err) {
        const step = connection ? 'session/new' : 'start'
        return `${step}: ${(err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 120)} | ${engineErrors(scratch)}`
      } finally {
        await connection?.dispose()
      }
    })))
  }
  return rounds
}

/* ---------------------------------------------------------------- snapshot */

const asks = (observation: PromptObservation): AcpMessage[] => observation.requests.filter((request) => request.method === 'session/request_permission')
const elicitations = (observation: PromptObservation): AcpMessage[] => observation.requests.filter((request) => request.method === 'elicitation/create')
const updateKinds = (updates: Json[]): string[] => [...new Set(updates.map((update) => String(update.sessionUpdate)))].sort()
const firstConversation = (): OpenAiTurn | undefined => seen.shell.turns[0]
const configOptions = (message: AcpMessage | null): Json[] => (message?.result?.configOptions as Json[] | undefined) ?? []
const askCommand = (request: AcpMessage): string => {
  const toolCall = (request.params?.toolCall ?? {}) as Json
  return String(((toolCall.rawInput ?? {}) as Json).command ?? toolCall.title ?? '')
}
const messageIdShape = (id: unknown): string => typeof id !== 'string' ? 'none' : (/^([a-z]+)_/.exec(id)?.[1] ?? 'other')
/** The prompt's `opencode/session/child_update` params, in order. */
const childUpdates = (observation: PromptObservation): Json[] =>
  observation.ext.filter((message) => message.method === 'opencode/session/child_update').map((message) => (message.params ?? {}) as Json)
/** The root's `subagent` call: its first frame, its last (the completion carries no input), and its input. */
const subagentCall = (observation: PromptObservation): { start?: Json; last?: Json; input?: Json } => {
  const start = observation.updates.find((update) => update.sessionUpdate === 'tool_call' && update.name === 'subagent')
  const frames = start ? observation.updates.filter((update) => update.toolCallId === start.toolCallId) : []
  const input = frames.map((update) => update.rawInput as Json | undefined).filter((raw) => raw && Object.keys(raw).length > 0).at(-1)
  return { start, last: frames.at(-1), input }
}
const childMetaOnRoot = (observation: PromptObservation): number =>
  observation.updates.filter((update) => ((update._meta ?? {}) as Json)['opencode/child-session'] !== undefined).length

/** Shapes only: no paths, ids, ports or timestamps, keys sorted, so two versions diff cleanly. */
function snapshot(): Json {
  const init = (seen.initialize?.result ?? {}) as Json
  const created = (seen.sessionNew?.result ?? {}) as Json
  const ask = asks(seen.shell)[0]
  const first = firstConversation()
  const thoughts = seen.think.updates.filter((update) => update.sessionUpdate === 'agent_thought_chunk')
  const replies = seen.think.updates.filter((update) => update.sessionUpdate === 'agent_message_chunk')
  const elicitation = elicitations(seen.question)[0]
  return {
    tool: 'opencode', version: seen.versionOutput, adapter: null,
    acp: {
      initialize: { protocolVersion: init.protocolVersion ?? null, agentCapabilities: init.agentCapabilities ?? null,
        authMethodIds: ((init.authMethods as Json[] | undefined) ?? []).map((method) => String(method.id)).sort(), resultKeys: keys(init) },
      sessionNew: { resultKeys: keys(created), configOptions: configOptions(seen.sessionNew).map((option) => ({ id: option.id, category: option.category ?? null, type: option.type ?? null })) },
      setConfigOption: seen.setConfig.map(({ configId, message }) => ({ configId, ok: !message.error, resultKeys: keys(message.result) })),
      shellPrompt: {
        stopReason: seen.shell.answer?.result?.stopReason ?? null,
        askedCommands: asks(seen.shell).map(askCommand),
        askParamKeys: keys(ask?.params), askToolCallKeys: keys(ask?.params?.toolCall),
        askOptions: ((ask?.params?.options as Json[] | undefined) ?? []).map((option) => ({ optionId: option.optionId, kind: option.kind })),
        conversationRequests: seen.shell.turns.length,
        refusalInNextPrompt: seen.cinna.turns[0]?.mentions('rejected permission') ?? false,
        updateKinds: updateKinds(seen.shell.updates)
      },
      cinnaPrompt: {
        stopReason: seen.cinna.answer?.result?.stopReason ?? null,
        mcpCalls: seen.mcp.calls.length,
        asks: asks(seen.cinna).length,
        toolCalls: seen.cinna.updates.filter((update) => update.sessionUpdate === 'tool_call')
          .map((update) => ({ title: update.title ?? null, kind: update.kind ?? null, codeMode: isCodeModeCall(update) })),
        codeModeCinnaTools: seen.cinna.updates.filter((update) => update.sessionUpdate === 'tool_call_update' && update.status === 'completed')
          .map((update) => codeModeCinnaTools(update.rawOutput)).filter((tools) => tools !== null)
      },
      mcpTiming: { listedAfter: seen.mcp.listedAfter, eagerPromptReachedProbe: seen.mcp.eagerCalls > 0,
        eagerToolResult: (seen.eager.turns[1]?.pendingToolResults[0] ?? null)?.replace(/\s+/g, ' ').slice(0, 120) ?? null },
      subagentPrompt: {
        stopReason: seen.subagent.answer?.result?.stopReason ?? null,
        offered: (seen.subagent.turns[0]?.tools ?? []).includes('subagent'),
        childUpdateKeys: [...new Set(childUpdates(seen.subagent).flatMap((params) => keys(params)))].sort(),
        statuses: childUpdates(seen.subagent).filter((params) => params.type === 'status').map((params) => params.status),
        updateKinds: updateKinds(childUpdates(seen.subagent).filter((params) => params.type === 'update').map((params) => (params.update ?? {}) as Json)),
        childFramesOnRoot: childMetaOnRoot(seen.subagent),
        callInputKeys: keys(subagentCall(seen.subagent).input),
        completionStatus: subagentCall(seen.subagent).last?.status ?? null,
        completionMetadataKeys: keys(((subagentCall(seen.subagent).last?.rawOutput ?? {}) as Json).metadata)
      },
      question: {
        offered: (seen.question.turns[0]?.tools ?? []).includes('question'),
        elicitationFields: keys(((elicitation?.params?.requestedSchema ?? {}) as Json).properties),
        elicitationParamKeys: keys(elicitation?.params),
        answerReachedModel: seen.question.turns.some((turn) => turn.pendingToolResults.some((result) => result.includes(ANSWER_LABEL))),
        stopReason: seen.question.answer?.result?.stopReason ?? null
      },
      thought: { chunks: thoughts.length, messageIdShapes: [...new Set(thoughts.map((update) => messageIdShape(update.messageId)))].sort(),
        replyMessageIdShapes: [...new Set(replies.map((update) => messageIdShape(update.messageId)))].sort() },
      load: { ok: seen.load.message !== null && !seen.load.message.error, replayKinds: updateKinds(seen.load.replay),
        resumedStopReason: seen.resume.answer?.result?.stopReason ?? null,
        historyCarried: seen.resume.turns[0]?.userText.includes('CONTRACT_SHELL_PROMPT') ?? false,
        unknownSessionErrors: seen.loadUnknown.message?.error !== undefined && seen.loadUnknown.message.error.code !== 'timeout',
        unknownSessionReplayKinds: updateKinds(seen.loadUnknown.replay) },
      database: { atOpencodeDb: seen.database.atOpencodeDb.includes('opencode.db'), underXdgData: seen.database.underXdgData },
      configPlugins: seen.configPlugins,
      readPrompt: { stopReason: seen.read.answer?.result?.stopReason ?? null, readOffered: (seen.read.turns[0]?.tools ?? []).includes('read'),
        readParams: [...(seen.read.turns[0]?.toolParams['read'] ?? [])].sort(), asks: asks(seen.read).length,
        toolStatuses: seen.read.updates.filter((update) => update.sessionUpdate === 'tool_call_update').map((update) => update.status ?? null) },
      firstStart: { rounds: seen.firstStarts.length, processes: seen.firstStarts[0]?.length ?? 0 },
      kills: seen.kills
    },
    model: {
      offeredTools: [...(first?.tools ?? [])].sort(),
      systemPromptArrives: first?.systemText.includes(SYSTEM_MARKER) ?? false,
      // Both per-skill folders from `skills.paths` (cinna-tasks, cinna-artifacts).
      kitSkill: (first?.mentions(KIT_SKILL_MARKER) && first?.mentions(KIT_ARTIFACTS_SKILL_MARKER)) ?? false,
      personal: Object.fromEntries(Object.entries(PERSONAL_MARKERS).map(([name, marker]) => [name, first?.mentions(marker) ?? false])),
      personalWithoutPluginEntry: Object.fromEntries(Object.entries(PERSONAL_MARKERS).map(([name, marker]) => [name, seen.control.turns[0]?.mentions(marker) ?? false]))
    },
    providerTraffic: { egress: seen.egress, otherRequests: seen.otherProviderRequests, auxiliaryRequests: seen.auxiliaryRequests > 0 }
  }
}

/* ------------------------------------------------------------------- tests */

const entry = (id: string): string => {
  const found = OPENCODE_CONTRACT.find((candidateEntry) => candidateEntry.id === id)
  if (!found) throw new Error(`${id} is not in the registry`)
  return `${id} — ${found.expectation}`
}

if (!binaryRef && !allowSkip) {
  describe('OpenCode interface contract — no binary', () => {
    it('has a managed OpenCode to check', () => { throw new Error(NO_BINARY) })
  })
}

describe.skipIf(!binaryRef)('OpenCode interface contract', () => {
  beforeAll(async () => {
    await scenario(binaryRef?.path ?? '')
  }, 300_000)

  it(entry('opencode.launch.version-output'), () => {
    expect(seen.versionStatus).toBe(0)
    expect(seen.versionOutput).toMatch(/^opencode v\d+\.\d+\.\d+\S*$/)
    // A candidate run is *for* another version; the pinned run must be the pin.
    if (!candidate) expect(seen.versionOutput).toBe(RUNTIME_PINS.opencode.versionOutput)
    expect(opencodeMajorVersion(seen.versionOutput)).toBeGreaterThanOrEqual(2)
  })

  it(entry('opencode.launch.personal-skills'), () => {
    const first = firstConversation()
    expect(first, 'no tool-bearing request reached the provider').toBeDefined()
    expect(seen.configPlugins).toEqual([OPENCODE_NO_COMPATIBILITY_PLUGIN])
    // The positive control: the kit's skill is read the way the personal ones would be.
    // Each skill is passed by its own folder (`skills.paths`), its SKILL.md at that folder's root.
    expect(first!.mentions(KIT_SKILL_MARKER), 'cinna-tasks from its skills.paths folder was not listed').toBe(true)
    expect(first!.mentions(KIT_ARTIFACTS_SKILL_MARKER), 'cinna-artifacts from its skills.paths folder was not listed').toBe(true)
    const leaked = Object.entries(PERSONAL_MARKERS).filter(([, marker]) => first!.mentions(marker)).map(([name]) => name).sort()
    expect(leaked).toEqual([])
    // The control: without the plugin entry the same HOME's skills do reach
    // the model, so their absence above is not a HOME the engine never read.
    // `claudeMd` reaches it in neither session on 2.0.27; the snapshot records
    // the control's whole answer, so a version that starts reading it shows.
    const control = seen.control.turns[0]
    expect(control, 'the plugins: [] control session reached no provider request').toBeDefined()
    const reached = Object.entries(PERSONAL_MARKERS).filter(([, marker]) => control!.mentions(marker)).map(([name]) => name)
    expect(reached, 'the personal skills are absent even without the plugin entry: the check above proves nothing').toEqual(expect.arrayContaining(['claudeSkill', 'agentsSkill']))
  })

  it(entry('opencode.launch.database'), () => {
    expect(seen.plan?.spec.env['OPENCODE_DB'], 'the launcher set no OPENCODE_DB').toMatch(/opencode\.db$/)
    expect(seen.database.atOpencodeDb, 'no database at OPENCODE_DB').toContain('opencode.db')
    expect(seen.database.underXdgData, 'a database was created under XDG data').toEqual([])
  })

  it(entry('opencode.launch.database-first-start'), () => {
    expect(seen.firstStarts.length, 'the first-start rounds never ran').toBe(FIRST_START_ROUNDS)
    for (const outcomes of seen.firstStarts) expect(outcomes.length).toBe(FIRST_START_PROCESSES)
    // Without the bootstrap a round of three loses one or two in most trials;
    // without the launcher's `earlyExitRetry` about one start in twenty still
    // dies on `database is locked`. Both are in the path, so none is lost.
    const lost = seen.firstStarts.flatMap((outcomes, round) => outcomes.filter((outcome) => outcome !== 'ok').map((outcome) => `round ${round}: ${outcome}`))
    expect(lost, 'concurrent first starts on a fresh database were lost').toEqual([])
  })

  it(entry('opencode.launch.process-tree'), () => {
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      const kill = seen.kills[signal]
      expect(kill, `the ${signal} step never ran`).toBeDefined()
      expect(kill.exited, `${signal}: acp did not exit`).toBe(true)
      expect(kill.orphans, `${signal}: descendants outlived acp`).toBe(0)
      expect(kill.descendants).toBe(1)
      expect(kill.sameGroup).toBe(false)
    }
  })

  it(entry('opencode.session.initialize'), () => {
    const result = (seen.initialize?.result ?? {}) as Json
    const capabilities = (result.agentCapabilities ?? {}) as Json
    expect(seen.initialize?.error).toBeUndefined()
    expect(result.protocolVersion).toBe(1)
    expect(capabilities.loadSession).toBe(true)
    expect(capabilities.mcpCapabilities).toMatchObject({ http: true, sse: false })
  })

  it(entry('opencode.session.config-options'), () => {
    expect(seen.sessionNew?.error).toBeUndefined()
    expect(typeof seen.sessionNew?.result?.sessionId).toBe('string')
    const options = configOptions(seen.sessionNew)
    expect(options.map((option) => option.id).sort()).toEqual(['effort', 'mode', 'model'])
    for (const option of options) expect(option.type).toBe('select')
    expect(options.find((option) => option.id === 'effort')?.category).toBe('thought_level')
  })

  it(entry('opencode.session.set-config-option'), () => {
    expect(seen.setConfig.map(({ configId }) => configId)).toEqual(['mode', 'model'])
    for (const { configId, message } of seen.setConfig) {
      expect(message.error, `set_config_option ${configId}`).toBeUndefined()
      expect(Array.isArray(message.result?.configOptions), `${configId} answered no configOptions`).toBe(true)
    }
    const after = (seen.setConfig[1]?.message.result?.configOptions ?? []) as Json[]
    const mode = seen.plan?.setup.configOptions?.find((option) => option.configId === 'mode')?.value
    expect(after.find((option) => option.id === 'mode')?.currentValue).toBe(mode)
  })

  it(entry('opencode.session.system-prompt'), () => {
    expect(firstConversation()?.systemText.includes(SYSTEM_MARKER)).toBe(true)
  })

  it(entry('opencode.session.load-replay'), () => {
    expect(seen.load.message?.error).toBeUndefined()
    const replayed = updateKinds(seen.load.replay)
    for (const kind of ['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update']) expect(replayed).toContain(kind)
    expect(seen.load.replay.some((update) => update.sessionUpdate === 'user_message_chunk' &&
      String(((update.content ?? {}) as Json).text ?? '').includes('CONTRACT_SHELL_PROMPT'))).toBe(true)
    expect(seen.resume.answer?.result?.stopReason).toBe('end_turn')
    expect(seen.resume.turns[0]?.userText.includes('CONTRACT_SHELL_PROMPT')).toBe(true)
  })

  it(entry('opencode.session.load-unknown'), () => {
    const message = seen.loadUnknown.message
    expect(message, 'the load was never asked').not.toBeNull()
    expect(message!.error, 'session/load of an unknown session did not fail').toBeDefined()
    expect(message!.error!.code, 'session/load of an unknown session hung').not.toBe('timeout')
    expect(seen.loadUnknown.ms).toBeLessThan(10_000)
    expect(seen.loadUnknown.replay.filter((update) => update.sessionUpdate !== 'available_commands_update')).toEqual([])
  })

  it(entry('opencode.session.thought-message-id'), () => {
    const thoughts = seen.think.updates.filter((update) => update.sessionUpdate === 'agent_thought_chunk')
    const replies = seen.think.updates.filter((update) => update.sessionUpdate === 'agent_message_chunk')
    expect(thoughts.length, 'the reasoning stream produced no thought chunk').toBeGreaterThan(0)
    expect(thoughts.map((update) => String(((update.content ?? {}) as Json).text ?? '')).join('')).toContain(REASONING_TEXT)
    expect(replies.length).toBeGreaterThan(0)
    expect([...new Set(replies.map((update) => messageIdShape(update.messageId)))]).toEqual(['msg'])
    expect([...new Set(thoughts.map((update) => messageIdShape(update.messageId)))]).toEqual(['msg'])
  })

  it(entry('opencode.mcp.session-tool'), () => {
    expect(seen.mcp.calls[0], 'Cinna’s probe tool was never called').toBe('probe')
    expect(seen.cinna.answer?.result?.stopReason).toBe('end_turn')
    const offered = seen.cinna.turns[0]?.tools ?? []
    const calls = seen.cinna.updates.filter((update) => update.sessionUpdate === 'tool_call')
    expect(offered).toContain('execute')
    expect(offered.filter((name) => name.startsWith('cinna'))).toEqual([])
    expect(calls.map((update) => isCodeModeCall(update))).toEqual([true])
    expect(asks(seen.cinna)).toEqual([])
    const completed = seen.cinna.updates.filter((update) => update.sessionUpdate === 'tool_call_update' && update.status === 'completed')
    expect(completed.map((update) => codeModeCinnaTools(update.rawOutput)).filter((tools) => tools !== null)).toEqual([['probe']])
    expect(seen.cinna.turns.some((turn) => turn.pendingToolResults.some((result) => result.includes(PROBE_RESULT)))).toBe(true)
  })

  it(entry('opencode.mcp.connect-timing'), () => {
    expect(seen.mcp.listedAfter, 'Cinna’s server never answered the session’s tools/list').toBe(true)
    expect(seen.mcp.eagerCalls).toBe(0)
    expect(seen.eager.turns[1]?.pendingToolResults[0]).toMatch(/Unknown tool 'cinna\.probe'/)
  })

  it(entry('opencode.permission.profile-patterns'), () => {
    const first = firstConversation()
    const shell = first ? shellTool(first) : undefined
    expect(shell).toBe('shell')
    // Both commands were made; only the secret read asked.
    expect(seen.shell.turns[1]?.pendingToolResults[0], '`ls` did not run unasked').toContain('readme.txt')
    expect(asks(seen.shell).map(askCommand)).toEqual(['cat .env'])
    // `read` of `.env`, by the 2.x argument: denied by the `read` map outright —
    // no ask, a failed tool call, and the value never reaches the model.
    expect(seen.read.turns[0]?.toolParams['read'], '2.x read no longer takes `path`').toContain('path')
    expect(asks(seen.read), 'the secret read asked instead of being denied').toEqual([])
    const statuses = seen.read.updates.filter((update) => update.sessionUpdate === 'tool_call_update').map((update) => update.status)
    expect(statuses, 'the read of .env completed').not.toContain('completed')
    expect(statuses).toContain('failed')
    // The control: the same argument shape on `readme.txt` completes unasked
    // and its text reaches the model, so the read above failed on the pattern.
    expect(seen.plainRead.turns[0]?.toolParams['read'], 'the control read was not offered `path`').toContain('path')
    expect(asks(seen.plainRead), 'the control read asked').toEqual([])
    const plainStatuses = seen.plainRead.updates.filter((update) => update.sessionUpdate === 'tool_call_update').map((update) => update.status)
    expect(plainStatuses, 'the control read of readme.txt did not complete').toContain('completed')
    expect(plainStatuses).not.toContain('failed')
    expect(seen.plainRead.turns[1]?.pendingToolResults[0], 'readme.txt did not reach the model').toContain('hello')
    expect(seen.read.turns.some((turn) => turn.mentions(SECRET)), 'the .env value reached the model').toBe(false)
  })

  it(entry('opencode.permission.ask-options'), () => {
    const ask = asks(seen.shell)[0]
    expect(ask, 'no ask was raised').toBeDefined()
    const toolCall = (ask.params?.toolCall ?? {}) as Json
    expect(keys(toolCall)).toEqual(expect.arrayContaining(['toolCallId', 'title', 'kind', 'status', 'locations', 'rawInput']))
    expect(toolCall.kind).toBe('execute')
    expect(((toolCall.rawInput ?? {}) as Json).command).toBe('cat .env')
    expect(toolCall.name).toBe('shell')
    const options = ((ask.params?.options ?? []) as Json[]).map((option) => ({ optionId: option.optionId, kind: option.kind }))
    expect(options).toEqual([
      { optionId: 'once', kind: 'allow_once' }, { optionId: 'always', kind: 'allow_always' }, { optionId: 'reject', kind: 'reject_once' }
    ])
  })

  it(entry('opencode.permission.deny-outcome'), () => {
    expect(seen.shell.answer?.error).toBeUndefined()
    // The SECRET never reached the model either way.
    expect(seen.shell.turns.some((turn) => turn.mentions(SECRET))).toBe(false)
    // `ls`, then `cat .env`: two model requests, and none after the refusal.
    expect(seen.shell.turns.length).toBe(2)
    expect(seen.shell.answer?.result?.stopReason).toBe('cancelled')
  })

  it(entry('opencode.question.elicitation'), () => {
    const offered = (seen.question.turns[0]?.tools ?? []).includes('question')
    expect(offered).toBe(true)
    const asked = elicitations(seen.question)
    expect(asked.length).toBe(1)
    const schema = (asked[0].params?.requestedSchema ?? {}) as Json
    expect(keys(schema.properties)).toEqual(['q0', 'q0_custom'])
    const form = toInputQuestions(asked[0].params as unknown as CreateElicitationRequest)
    expect(form?.fields).toEqual([{ key: 'q0', multiple: false, custom: 'q0_custom' }])
    expect(form?.questions[0]?.options.map((option) => option.label)).toEqual(['Alpha', ANSWER_LABEL])
    expect(seen.question.turns.some((turn) => turn.pendingToolResults.some((result) => result.includes(ANSWER_LABEL)))).toBe(true)
    expect(seen.question.answer?.result?.stopReason).toBe('end_turn')
  })

  it(entry('opencode.session.child-updates'), () => {
    const init = (seen.initialize?.result ?? {}) as Json
    expect(((init.agentCapabilities as Json | undefined)?._meta as Json | undefined)?.['opencode/child-session-updates']).toBe(true)
    expect((seen.plan?.init.clientCapabilities?._meta as Json | undefined)?.['opencode/child-session-updates']).toBe(true)
    expect(seen.subagent.answer?.result?.stopReason).toBe('end_turn')
    const { start, last, input } = subagentCall(seen.subagent)
    expect(start, 'the root made no subagent call').toBeDefined()
    expect(input).toMatchObject({ agent: 'general', description: CHILD_DESCRIPTION, prompt: CHILD_PROMPT })
    const updates = childUpdates(seen.subagent)
    const children = [...new Set(updates.map((params) => params.childSessionId))]
    expect(children).toHaveLength(1)
    const root = String(seen.sessionNew?.result?.sessionId ?? '')
    for (const params of updates) {
      expect(params).toMatchObject({ rootSessionId: root, childSessionId: children[0], parentSessionId: root, depth: 1, title: CHILD_DESCRIPTION })
    }
    expect(children[0]).not.toBe(root)
    expect(updates.filter((params) => params.type === 'status').map((params) => params.status)).toEqual(['created', 'running', 'completed'])
    const report = updates.filter((params) => params.type === 'update').map((params) => (params.update ?? {}) as Json)
      .filter((update) => update.sessionUpdate === 'agent_message_chunk').map((update) => String(((update.content ?? {}) as Json).text ?? '')).join('')
    expect(report).toContain(CHILD_REPORT)
    expect(childMetaOnRoot(seen.subagent), 'child frames flattened onto the root session').toBe(0)
    expect(last?.status).toBe('completed')
    expect(((last?.rawOutput as Json | undefined)?.metadata as Json | undefined)?.sessionID).toBe(children[0])
    expect(JSON.stringify(last?.content ?? [])).toContain(CHILD_REPORT)
  })

  it(entry('opencode.provider.egress'), () => {
    expect(seen.otherProviderRequests, 'requests to the fake that were not chat/completions').toEqual([])
    expect(seen.auxiliaryRequests, 'the engine made no title request of its own').toBeGreaterThan(0)
    expect(seen.egress).toEqual(['models.opencode.ai:443'])
  })

  // Last on purpose: it reads what the scenario observed. Not a registry entry —
  // it is the "what changed" report, not an interface.
  it('the observed shapes match the committed snapshot', () => {
    expect(seen.versionOutput, 'the binary never reported a version, so there is nothing to snapshot').toBeTruthy()
    const observed = JSON.stringify(sorted(snapshot()), null, 2) + '\n'
    const pinnedPath = join(here, 'snapshots', `opencode-${RUNTIME_PINS.opencode.cli}.json`)
    const pinned = existsSync(pinnedPath) ? readFileSync(pinnedPath, 'utf8') : null
    if (candidate) {
      const version = seen.versionOutput.replace(/^opencode\s+v?/, '')
      const directory = join(tmpdir(), 'cinna-contract-snapshots')
      mkdirSync(directory, { recursive: true })
      const path = join(directory, `opencode-${version}.json`)
      writeFileSync(path, observed)
      const diff = pinned === null ? '(no pinned snapshot to compare with)' : lineDiff(pinned, observed)
      writeFileSync(path.replace(/\.json$/, '.diff'), diff ? `${diff}\n` : '')
      console.log(`\n--- snapshot diff: opencode ${RUNTIME_PINS.opencode.cli} -> ${version} (candidate snapshot: ${path})\n${diff || '(no observed change)'}\n`)
      return
    }
    if (writeSnapshot) {
      mkdirSync(dirname(pinnedPath), { recursive: true })
      writeFileSync(pinnedPath, observed)
      return
    }
    expect(pinned, `no committed snapshot at ${pinnedPath} — write it with \`make contract-snapshot ENGINE=opencode\``).not.toBeNull()
    const diff = lineDiff(pinned ?? '', observed)
    expect(diff === '', `the pinned binary no longer matches its committed snapshot (- committed, + observed):\n${diff}\n` +
      'If the change is intended: make contract-snapshot ENGINE=opencode').toBe(true)
  })
})
