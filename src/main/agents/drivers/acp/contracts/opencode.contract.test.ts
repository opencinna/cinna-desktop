import { beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
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
import { chatRuntimePermissions, engineAgentKey } from '../../../../engine/configGenerator'
import { buildAcpPrompt } from '../../../../services/acpAttachments'
import { placeTurnContext } from '../acpDriver'
import type { AcpConnection as DriverConnection } from '../types'
import { OPENCODE_CONTRACT } from './opencode.contract'
import { lineDiff, sorted } from './snapshotTools'
import { startEgressTrap, type EgressTrap } from './claudeHarness'
import {
  KIT_ARTIFACTS_SKILL_MARKER, KIT_DASHBOARDS_SKILL_MARKER, KIT_SKILL_MARKER, PERSONAL_MARKERS, descendantsOf, findContractOpencode, isAlive, makeOpencodeScratch, reap, spawnAcp, startFakeOpenAi,
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
/** `opencode.telemetry.prompt-usage`: two model requests (a `read`, then the answer), each with its own usage and cache reads. */
const USAGE_PROMPT = 'CONTRACT_USAGE_PROMPT: read readme.txt, then answer.'
const USAGE_STEPS = [{ prompt: 1000, completion: 5, cached: 600 }, { prompt: 2000, completion: 7, cached: 1500 }] as const
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
  usage: emptyPrompt(),
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
  auxiliaryRequests: 0,
  /** The `workspace` chat runtime's session, on its generated replace policy: one observation per prompt. */
  workspace: { error: null as string | null, cwd: '', outside: '', written: null as string | null, otherCwd: '', otherWritten: null as string | null,
    bash: emptyPrompt(), write: emptyPrompt(), readInside: emptyPrompt(), readOutside: emptyPrompt(),
    /** Session A reading session B's folder; session B, on A's process, reading its own folder, A's (the process cwd), and writing. */
    readOther: emptyPrompt(), otherReadInside: emptyPrompt(), otherReadProcess: emptyPrompt(), otherWrite: emptyPrompt() },
  /** A plugin slash command with the turn context after it: as the driver sends it on OpenCode (annotated block), and as a plain second block. */
  command: { error: null as string | null, annotatedBlocks: [] as Json[], annotated: [] as OpenAiTurn[], plain: [] as OpenAiTurn[] },
  /**
   * `opencode.mcp.list-changed`: a session started with Cinna's server offering
   * no tool, prompted (`before`); a tool added and announced with
   * `tools/list_changed`, re-listed, and the session prompted to call it
   * (`after`); then a new session on the same process prompted the same way
   * (`fresh`). `relisted`: the engine re-listed after the announcement;
   * `freshListed`: it listed again on that `session/new`, unannounced.
   * `late`: a new session on the same process, a second tool added and
   * announced after its `session/new` and before its first prompt;
   * `lateRelisted`: re-listed on that announcement.
   */
  listChanged: { error: null as string | null, relisted: false, freshListed: false, lateRelisted: false, before: emptyPrompt(), after: emptyPrompt(),
    fresh: emptyPrompt(), late: emptyPrompt(), afterCalls: 0, freshCalls: 0, lateCalls: 0 }
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
  if (about.includes('CONTRACT_USAGE_PROMPT')) {
    if (step > 0 || !turn.tools.includes('read')) return { kind: 'text', text: 'USAGE_DONE', usage: USAGE_STEPS[1] }
    const params = turn.toolParams['read'] ?? []
    return { kind: 'tool', name: 'read', args: { [params.includes('path') ? 'path' : 'filePath']: 'readme.txt' }, usage: USAGE_STEPS[0] }
  }
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
    await prompt(connection, USAGE_PROMPT, seen.usage, 500)

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

/* -------------------------------------------------------- workspace chat */

const WORKSPACE_AGENT_ID = 'chat-runtime:contract'
const WORKSPACE_MARKER = 'CONTRACT_WORKSPACE_PROMPT_8a4'
const WORKSPACE_WRITE = 'CONTRACT_WORKSPACE_WRITE_8a4'
const WS_BASH = 'CONTRACT_WS_BASH: print the directory.'
const WS_WRITE = 'CONTRACT_WS_WRITE: write made.txt.'
const WS_READ_INSIDE = 'CONTRACT_WS_READ_INSIDE: read readme.txt.'
const WS_READ_OUTSIDE = 'CONTRACT_WS_READ_OUTSIDE: read the outside file.'
const WS_READ_OTHER = 'CONTRACT_WS_READ_OTHER: read the other chat\'s file.'
const WS_READ_PROCESS = 'CONTRACT_WS_READ_PROCESS: read the first chat\'s file.'
const WS_READ_OWN = 'CONTRACT_WS_READ_OWN: read own.txt.'

/** The workspace chat's scripted model: one native call per prompt, then a text answer. */
function decideWorkspace(outside: string, files: { other: string; first: string }): (turn: OpenAiTurn) => OpenAiReply {
  return (turn) => {
    if (turn.kind === 'auxiliary') return { kind: 'text', text: 'Contract title' }
    if (turn.pendingToolResults.length > 0) return { kind: 'text', text: 'WS_DONE' }
    const about = turn.lastUserText
    const params = (name: string): string[] => turn.toolParams[name] ?? []
    const pathKey = (name: string): string => params(name).includes('path') ? 'path' : 'filePath'
    if (about.includes('CONTRACT_WS_BASH')) {
      const shell = shellTool(turn)
      if (!shell) return { kind: 'text', text: 'NO_SHELL' }
      return { kind: 'tool', name: shell, args: { command: 'pwd -P', ...(params(shell).includes('description') ? { description: 'contract' } : {}) } }
    }
    if (about.includes('CONTRACT_WS_WRITE')) {
      if (!turn.tools.includes('write')) return { kind: 'text', text: 'NO_WRITE' }
      return { kind: 'tool', name: 'write', args: { [pathKey('write')]: 'made.txt', content: WORKSPACE_WRITE } }
    }
    const readOf = about.includes('CONTRACT_WS_READ_INSIDE') ? 'readme.txt' : about.includes('CONTRACT_WS_READ_OUTSIDE') ? outside
      : about.includes('CONTRACT_WS_READ_OTHER') ? files.other : about.includes('CONTRACT_WS_READ_PROCESS') ? files.first
        : about.includes('CONTRACT_WS_READ_OWN') ? 'own.txt' : null
    if (readOf) {
      if (!turn.tools.includes('read')) return { kind: 'text', text: 'NO_READ' }
      return { kind: 'tool', name: 'read', args: { [pathKey('read')]: readOf } }
    }
    return { kind: 'text', text: 'OK' }
  }
}

/**
 * A `workspace` chat runtime on the production launcher and config generator:
 * its agent entry is the chat runtime's replace policy
 * (`chatRuntimePermissions('workspace')`), its prompt the entry's alone — the
 * session folder has no `AGENTS.md` — and every ask is answered allow-once.
 * Kept out of the snapshot: what it observes is these entries' alone.
 */
async function workspaceScenario(binary: string): Promise<void> {
  let trap: EgressTrap | undefined
  let provider: FakeOpenAi | undefined
  let scratch: OpencodeScratch | undefined
  let connection: AcpConnection | undefined
  const mcp = new ConductorMcpServer()
  try {
    trap = await startEgressTrap()
    scratch = makeOpencodeScratch('cinna-contract-opencode-ws-', { trapPort: trap.port })
    const outsideDir = join(scratch.root, 'outside')
    mkdirSync(outsideDir, { recursive: true })
    const outside = join(outsideDir, 'secret.txt')
    writeFileSync(outside, 'outside\n')
    writeFileSync(join(scratch.cwd, 'readme.txt'), 'hello\n')
    // A second chat's folder, served by the same process (one pool key per
    // mode: production starts it in whichever chat's folder came first).
    const otherDir = join(scratch.root, 'other-chat')
    mkdirSync(otherDir, { recursive: true })
    writeFileSync(join(otherDir, 'own.txt'), 'other chat\n')
    seen.workspace.cwd = realpathSync(scratch.cwd)
    seen.workspace.otherCwd = realpathSync(otherDir)
    seen.workspace.outside = outside
    provider = await startFakeOpenAi(decideWorkspace(outside, { other: join(otherDir, 'own.txt'), first: join(scratch.cwd, 'readme.txt') }))
    const port = provider.port
    const env = scratch.env
    const launcher = createOpencodeLauncher({
      binary: async () => ({ path: binary, version: null }),
      configInput: async () => ({
        providers: [{ id: PROVIDER_ID, type: 'openai_compatible', name: 'Contract fake', apiKey: 'sk-contract-dummy-not-a-real-key',
          baseUrl: `http://127.0.0.1:${port}/v1`, models: [{ id: MODEL_ID, name: 'Contract model' }] }],
        agents: [{ agentId: WORKSPACE_AGENT_ID, slug: 'chat-runtime', description: 'Chat runtime', prompt: WORKSPACE_MARKER,
          providerId: PROVIDER_ID, modelId: MODEL_ID, permissionMode: 'replace', permissions: chatRuntimePermissions('workspace') }]
      }),
      configRoot: () => scratch!.configRoot,
      childEnv: async () => ({ ...env })
    })
    const planned = await launcher.plan({ userId: 'contract', agentId: WORKSPACE_AGENT_ID,
      folder: { name: 'Chat', slug: 'chat-runtime', description: '', path: scratch.cwd, kind: 'bare', runtimeMode: 'isolated' } })
    if (isRefusal(planned)) throw new Error(`the launcher refused: ${planned.error}`)
    const plan = planned
    const lease: ConductorMcpSession = await mcp.ensureSession('opencode-contract-ws', { getProviders: () => [{
      providerType: 'mcp', displayName: 'Contract',
      getTools: () => [{ name: 'probe', description: 'Return the contract result.', inputSchema: { type: 'object', properties: {} }, mcpProviderId: 'probe', providerType: 'mcp' }],
      callTool: async () => ({ content: PROBE_RESULT })
    }] } as never)
    connection = spawnAcp({ command: plan.spec.command, args: plan.spec.args, cwd: plan.spec.cwd, env: plan.spec.env, answer: (request) => {
      if (request.method !== 'session/request_permission') return undefined
      const optionId = pickPermissionOption((request.params?.options ?? []) as PermissionOption[], 'allow')
      return optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } }
    } })
    await connection.rpc('initialize', plan.init as unknown as Json, 60_000)
    const open = async (cwd: string): Promise<string> => {
      const mark = lease.toolsListings()
      const created = await connection!.rpc('session/new', { cwd, mcpServers: [lease.descriptor] }, 60_000)
      const listedAt = await lease.toolsListed(mark, 10_000)
      if (listedAt !== null && plan.awaitMcpTools) await sleep(Math.max(0, listedAt + plan.awaitMcpTools.settleMs - Date.now()))
      const id = String(created.result?.sessionId ?? '')
      if (!id) return ''
      for (const option of plan.setup.configOptions ?? []) {
        await connection!.rpc('session/set_config_option', { sessionId: id, configId: option.configId, value: option.value })
      }
      return id
    }
    const sessionId = await open(scratch.cwd)
    if (!sessionId) { seen.workspace.error = 'no session'; return }
    const prompt = async (text: string, into: PromptObservation, session = sessionId): Promise<void> => {
      const requestsAt = connection!.clientRequests.length, updatesAt = connection!.updates.length, turnsAt = provider!.turns.length
      into.answer = await connection!.rpc('session/prompt', { sessionId: session, prompt: [{ type: 'text', text }] }, 90_000)
      await sleep(300)
      into.requests = connection!.clientRequests.slice(requestsAt)
      into.updates = connection!.updates.slice(updatesAt)
      into.turns = provider!.turns.slice(turnsAt).filter((turn) => turn.kind === 'conversation')
    }
    await prompt(WS_BASH, seen.workspace.bash)
    await prompt(WS_WRITE, seen.workspace.write)
    const made = join(scratch.cwd, 'made.txt')
    seen.workspace.written = existsSync(made) ? readFileSync(made, 'utf8') : null
    await prompt(WS_READ_INSIDE, seen.workspace.readInside)
    await prompt(WS_READ_OUTSIDE, seen.workspace.readOutside)
    await prompt(WS_READ_OTHER, seen.workspace.readOther)
    // The second chat's session, on the process the first chat's folder started.
    const otherSession = await open(otherDir)
    if (!otherSession) { seen.workspace.error = 'no second session'; return }
    await prompt(WS_READ_OWN, seen.workspace.otherReadInside, otherSession)
    await prompt(WS_READ_PROCESS, seen.workspace.otherReadProcess, otherSession)
    await prompt(WS_WRITE, seen.workspace.otherWrite, otherSession)
    const otherMade = join(otherDir, 'made.txt')
    seen.workspace.otherWritten = existsSync(otherMade) ? readFileSync(otherMade, 'utf8') : null
  } catch (err) {
    seen.workspace.error = err instanceof Error ? err.message : String(err)
  } finally {
    await connection?.close()
    await mcp.dispose()
    await provider?.close()
    await trap?.close()
    scratch?.dispose()
  }
}

const COMMAND_AGENT_ID = 'contract-command-agent'
const COMMAND_MARKER = 'CONTRACT_OC_COMMAND_4a1'
const COMMAND_ARG_MARKER = 'CONTRACT_OC_ARG_7b2'
const COMMAND_CONTEXT_MARKER = 'CONTRACT_OC_CONTEXT_8c3'

/**
 * A plugin's slash command, configured as `configGenerator` writes one
 * (`<agent key>/<plugin>:<command>`), typed with the turn context the driver
 * adds: once as `placeTurnContext` + `buildAcpPrompt` send it on OpenCode —
 * the context in a block for the assistant only — and once with the context
 * as a plain second block, the layout that fails. Kept out of the snapshot.
 */
async function commandScenario(binary: string): Promise<void> {
  let trap: EgressTrap | undefined
  let provider: FakeOpenAi | undefined
  let scratch: OpencodeScratch | undefined
  let connection: AcpConnection | undefined
  try {
    trap = await startEgressTrap()
    scratch = makeOpencodeScratch('cinna-contract-opencode-cmd-', { trapPort: trap.port })
    provider = await startFakeOpenAi((turn) => turn.kind === 'auxiliary' ? { kind: 'text', text: 'Contract title' } : { kind: 'text', text: 'OK' })
    const port = provider.port
    const env = scratch.env
    const launcher = createOpencodeLauncher({
      binary: async () => ({ path: binary, version: null }),
      configInput: async () => ({
        providers: [{ id: PROVIDER_ID, type: 'openai_compatible', name: 'Contract fake', apiKey: 'sk-contract-dummy-not-a-real-key',
          baseUrl: `http://127.0.0.1:${port}/v1`, models: [{ id: MODEL_ID, name: 'Contract model' }] }],
        agents: [{ agentId: COMMAND_AGENT_ID, slug: 'command-agent', description: 'Command agent', prompt: 'Contract command agent.',
          providerId: PROVIDER_ID, modelId: MODEL_ID,
          commands: [{ name: 'contract-market:contract-cmd', template: `${COMMAND_MARKER} Reply OK. $ARGUMENTS`, description: 'A contract command.' }] }]
      }),
      configRoot: () => scratch!.configRoot,
      childEnv: async () => ({ ...env })
    })
    const planned = await launcher.plan({ userId: 'contract', agentId: COMMAND_AGENT_ID,
      folder: { name: 'Command agent', slug: 'command-agent', description: '', path: scratch.cwd, kind: 'bare', runtimeMode: 'isolated' } })
    if (isRefusal(planned)) throw new Error(`the launcher refused: ${planned.error}`)
    connection = spawnAcp({ command: planned.spec.command, args: planned.spec.args, cwd: planned.spec.cwd, env: planned.spec.env, answer })
    await connection.rpc('initialize', planned.init as unknown as Json, 60_000)
    const run = async (prompt: Json[]): Promise<OpenAiTurn[]> => {
      const created = await connection!.rpc('session/new', { cwd: scratch!.cwd, mcpServers: [] }, 60_000)
      const sessionId = String(created.result?.sessionId ?? '')
      if (!sessionId) { seen.command.error ??= JSON.stringify(created.error ?? 'no session'); return [] }
      for (const option of planned.setup.configOptions ?? []) {
        await connection!.rpc('session/set_config_option', { sessionId, configId: option.configId, value: option.value })
      }
      const turnsAt = provider!.turns.length
      const answered = await connection!.rpc('session/prompt', { sessionId, prompt }, 90_000)
      if (answered.error) seen.command.error ??= JSON.stringify(answered.error)
      await sleep(300)
      return provider!.turns.slice(turnsAt).filter((turn) => turn.kind === 'conversation')
    }
    const command = `/${engineAgentKey(COMMAND_AGENT_ID, 'command-agent')}/contract-market:contract-cmd ${COMMAND_ARG_MARKER}`
    const context = `Cinna task context (not part of the conversation):\n- here: ${COMMAND_CONTEXT_MARKER}`
    const placed = placeTurnContext('opencode', { chatId: 'contract', wireContent: command, turnContext: context, signal: new AbortController().signal })
    seen.command.annotatedBlocks = await buildAcpPrompt('contract', placed, null as unknown as DriverConnection, null) as unknown as Json[]
    seen.command.annotated = await run(seen.command.annotatedBlocks)
    seen.command.plain = await run([{ type: 'text', text: command }, { type: 'text', text: context }])
  } catch (err) {
    seen.command.error = err instanceof Error ? err.message : String(err)
  } finally {
    await connection?.close()
    await provider?.close()
    await trap?.close()
    scratch?.dispose()
  }
}

const LIST_CHANGED_AGENT_ID = 'contract-list-changed-agent'
const LC_BEFORE = 'CONTRACT_LC_BEFORE: just answer.'
const LC_CALL = 'CONTRACT_LC_CALL: call the added tool.'
const LC_LATE = 'CONTRACT_LC_LATE: call the tool added last.'
/** The tool Cinna's server offers only after the session started. */
const LC_TOOL = 'added_probe'
/** The tool added after the `late` session's `session/new`, before its first prompt. */
const LC_LATE_TOOL = 'late_probe'

/**
 * `opencode.mcp.list-changed`: what a tool added to Cinna's server mid-session
 * reaches. The production launcher's plan; Cinna's real server, offering no
 * tool at `session/new` (a chat that started with nothing attached), then
 * {@link LC_TOOL} announced by `refreshTools`. The re-list is awaited, and the
 * launcher's settle time, before the next prompt — the most a live session
 * could get. Kept out of the snapshot.
 */
async function listChangedScenario(binary: string): Promise<void> {
  let trap: EgressTrap | undefined
  let provider: FakeOpenAi | undefined
  let scratch: OpencodeScratch | undefined
  let connection: AcpConnection | undefined
  const mcp = new ConductorMcpServer()
  const observed = seen.listChanged
  try {
    trap = await startEgressTrap()
    scratch = makeOpencodeScratch('cinna-contract-opencode-lc-', { trapPort: trap.port })
    provider = await startFakeOpenAi((turn) => {
      if (turn.kind === 'auxiliary') return { kind: 'text', text: 'Contract title' }
      const late = turn.lastUserText.includes('CONTRACT_LC_LATE')
      if (!(late || turn.lastUserText.includes('CONTRACT_LC_CALL')) || turn.pendingToolResults.length > 0 || !turn.tools.includes('execute')) return { kind: 'text', text: 'OK' }
      return { kind: 'tool', name: 'execute', args: { code: `return await tools["cinna"].${late ? LC_LATE_TOOL : LC_TOOL}({})` } }
    })
    const port = provider.port
    const env = scratch.env
    const launcher = createOpencodeLauncher({
      binary: async () => ({ path: binary, version: null }),
      configInput: async () => ({
        providers: [{ id: PROVIDER_ID, type: 'openai_compatible', name: 'Contract fake', apiKey: 'sk-contract-dummy-not-a-real-key',
          baseUrl: `http://127.0.0.1:${port}/v1`, models: [{ id: MODEL_ID, name: 'Contract model' }] }],
        agents: [{ agentId: LIST_CHANGED_AGENT_ID, slug: 'list-changed', description: 'List changed', prompt: 'Contract list-changed agent.',
          providerId: PROVIDER_ID, modelId: MODEL_ID }]
      }),
      configRoot: () => scratch!.configRoot,
      childEnv: async () => ({ ...env })
    })
    const planned = await launcher.plan({ userId: 'contract', agentId: LIST_CHANGED_AGENT_ID,
      folder: { name: 'List changed', slug: 'list-changed', description: '', path: scratch.cwd, kind: 'bare', runtimeMode: 'isolated' } })
    if (isRefusal(planned)) throw new Error(`the launcher refused: ${planned.error}`)
    const plan = planned
    const calls: string[] = []
    let offered = false, offeredLate = false
    const tool = (name: string) => ({ name, description: 'Return the contract result.', inputSchema: { type: 'object', properties: {} }, mcpProviderId: 'probe', providerType: 'mcp' })
    const lease: ConductorMcpSession = await mcp.ensureSession('opencode-contract-lc', { getProviders: () => [{
      providerType: 'mcp', displayName: 'Contract',
      getTools: () => [...(offered ? [tool(LC_TOOL)] : []), ...(offeredLate ? [tool(LC_LATE_TOOL)] : [])],
      callTool: async (name: string) => { calls.push(name); return { content: PROBE_RESULT } }
    }] } as never)
    const settle = async (listedAt: number | null): Promise<void> => {
      if (listedAt !== null && plan.awaitMcpTools) await sleep(Math.max(0, listedAt + plan.awaitMcpTools.settleMs - Date.now()))
    }
    connection = spawnAcp({ command: plan.spec.command, args: plan.spec.args, cwd: plan.spec.cwd, env: plan.spec.env, answer })
    await connection.rpc('initialize', plan.init as unknown as Json, 60_000)
    /** `session/new`, waiting `listWaitMs` for a listing it causes; whether one came. */
    const open = async (listWaitMs = 10_000): Promise<{ id: string; listed: boolean }> => {
      const mark = lease.toolsListings()
      const created = await connection!.rpc('session/new', { cwd: scratch!.cwd, mcpServers: [lease.descriptor] }, 60_000)
      const listedAt = await lease.toolsListed(mark, listWaitMs)
      await settle(listedAt)
      const id = String(created.result?.sessionId ?? '')
      const opened = { id, listed: listedAt !== null }
      if (!id) { observed.error ??= JSON.stringify(created.error ?? 'no session'); return opened }
      for (const option of plan.setup.configOptions ?? []) {
        await connection!.rpc('session/set_config_option', { sessionId: id, configId: option.configId, value: option.value })
      }
      return opened
    }
    const prompt = async (sessionId: string, text: string, into: PromptObservation): Promise<void> => {
      const updatesAt = connection!.updates.length, turnsAt = provider!.turns.length
      into.answer = await connection!.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, 90_000)
      await sleep(300)
      into.updates = connection!.updates.slice(updatesAt)
      into.turns = provider!.turns.slice(turnsAt).filter((turn) => turn.kind === 'conversation')
    }
    const { id: sessionId } = await open()
    if (!sessionId) return
    await prompt(sessionId, LC_BEFORE, observed.before)
    offered = true
    const mark = lease.toolsListings()
    await lease.refreshTools()
    const relistedAt = await lease.toolsListed(mark, 10_000)
    observed.relisted = relistedAt !== null
    await settle(relistedAt)
    let callsAt = calls.length
    await prompt(sessionId, LC_CALL, observed.after)
    observed.afterCalls = calls.length - callsAt
    // A process that holds the endpoint, a new session, nothing announced.
    const { id: freshId, listed: freshListed } = await open(3_000)
    observed.freshListed = freshListed
    if (!freshId) return
    callsAt = calls.length
    await prompt(freshId, LC_CALL, observed.fresh)
    observed.freshCalls = calls.length - callsAt
    // Announced between `session/new` and the first prompt.
    const { id: lateId } = await open(3_000)
    if (!lateId) return
    offeredLate = true
    const lateMark = lease.toolsListings()
    await lease.refreshTools()
    const lateAt = await lease.toolsListed(lateMark, 10_000)
    observed.lateRelisted = lateAt !== null
    await settle(lateAt)
    callsAt = calls.length
    await prompt(lateId, LC_LATE, observed.late)
    observed.lateCalls = calls.length - callsAt
  } catch (err) {
    observed.error = err instanceof Error ? err.message : String(err)
  } finally {
    await connection?.close()
    await mcp.dispose()
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
/** The prompt's `usage_update`s. */
const usageUpdates = (observation: PromptObservation): Json[] => observation.updates.filter((update) => update.sessionUpdate === 'usage_update')
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
      promptUsage: { usageKeys: keys(seen.usage.answer?.result?.usage), usageUpdates: usageUpdates(seen.usage).length,
        usageUpdateKeys: [...new Set(usageUpdates(seen.usage).flatMap((update) => keys(update)))].sort(),
        costKeys: [...new Set(usageUpdates(seen.usage).flatMap((update) => keys(update.cost)))].sort() },
      firstStart: { rounds: seen.firstStarts.length, processes: seen.firstStarts[0]?.length ?? 0 },
      kills: seen.kills
    },
    model: {
      offeredTools: [...(first?.tools ?? [])].sort(),
      systemPromptArrives: first?.systemText.includes(SYSTEM_MARKER) ?? false,
      // Every per-skill folder from `skills.paths` (cinna-tasks, cinna-artifacts, cinna-dashboards).
      kitSkill: (first?.mentions(KIT_SKILL_MARKER) && first?.mentions(KIT_ARTIFACTS_SKILL_MARKER) && first?.mentions(KIT_DASHBOARDS_SKILL_MARKER)) ?? false,
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
    await workspaceScenario(binaryRef?.path ?? '')
    await commandScenario(binaryRef?.path ?? '')
    await listChangedScenario(binaryRef?.path ?? '')
  }, 600_000)

  it(entry('opencode.session.slash-command-context'), () => {
    expect(seen.command.error).toBeNull()
    // As the driver sends it: the command alone, then the context for the assistant only.
    expect(seen.command.annotatedBlocks).toHaveLength(2)
    expect(seen.command.annotatedBlocks[1]).toMatchObject({ annotations: { audience: ['assistant'] } })
    const ran = seen.command.annotated.find((turn) => turn.mentions(COMMAND_MARKER))
    expect(ran, 'the command did not run with an annotated context block after it').toBeDefined()
    // `$ARGUMENTS` is the command's own argument alone…
    expect(ran!.lastUserText.trim(), 'the context became the command’s arguments').toBe(`${COMMAND_MARKER} Reply OK. ${COMMAND_ARG_MARKER}`)
    // …and the context still reached the model, as embedded context.
    expect(ran!.mentions(COMMAND_CONTEXT_MARKER), 'the context block never reached the model').toBe(true)
    // A plain second block is joined into the arguments: why the driver annotates it.
    const plain = seen.command.plain.find((turn) => turn.mentions(COMMAND_MARKER))
    expect(plain?.userText ?? '', 'a plain second block no longer joins the arguments').toMatch(new RegExp(`${COMMAND_ARG_MARKER}\\s+Cinna task context`))
  })

  it(entry('opencode.policy.workspace-native-tools'), () => {
    expect(seen.workspace.error).toBeNull()
    const first = seen.workspace.bash.turns[0]
    expect(first, 'the workspace session reached no provider request').toBeDefined()
    // Native tools beside Code Mode's `execute`, which carries Cinna's.
    expect(first!.tools).toEqual(expect.arrayContaining(['read', 'write', 'execute']))
    expect(shellTool(first!)).toBeDefined()
    // The instructions arrive from the generated entry, with no AGENTS.md in the folder.
    expect(existsSync(join(seen.workspace.cwd, 'AGENTS.md'))).toBe(false)
    expect(first!.systemText).toContain(WORKSPACE_MARKER)
  })

  it(entry('opencode.policy.workspace-asks'), () => {
    // The shell and the write each ask, and run once allowed.
    expect(asks(seen.workspace.bash).map(askCommand)).toEqual(['pwd -P'])
    expect(asks(seen.workspace.write)).toHaveLength(1)
    expect(seen.workspace.written).toBe(WORKSPACE_WRITE)
    // A read inside the folder does not; one outside it asks (`external_directory`).
    expect(asks(seen.workspace.readInside)).toHaveLength(0)
    expect(seen.workspace.readInside.turns[1]?.pendingToolResults.join('\n')).toContain('hello')
    expect(asks(seen.workspace.readOutside).length).toBeGreaterThanOrEqual(1)
    expect(asks(seen.workspace.readOutside).map((ask) => String((ask.params?.toolCall as Json | undefined)?.title ?? '')).join(' ')).toMatch(/external|outside|secret/i)
  })

  it(entry('opencode.policy.workspace-session-scope'), () => {
    expect(seen.workspace.error).toBeNull()
    const titles = (observation: PromptObservation): string => asks(observation).map((ask) => String((ask.params?.toolCall as Json | undefined)?.title ?? '')).join(' ')
    // From chat A, chat B's folder is outside: it asks.
    expect(asks(seen.workspace.readOther).length, 'reading another chat\'s folder ran without an ask').toBeGreaterThanOrEqual(1)
    expect(titles(seen.workspace.readOther)).toMatch(/external|outside|own/i)
    // Chat B, on a process started in A's folder, reads its own folder freely…
    expect(asks(seen.workspace.otherReadInside)).toHaveLength(0)
    expect(seen.workspace.otherReadInside.turns[1]?.pendingToolResults.join('\n')).toContain('other chat')
    // …and A's folder, the process cwd, is outside for it: it asks.
    expect(asks(seen.workspace.otherReadProcess).length, 'the process folder counted as the session\'s').toBeGreaterThanOrEqual(1)
    // A write asks in the second session too, and lands in its own folder.
    expect(asks(seen.workspace.otherWrite)).toHaveLength(1)
    expect(seen.workspace.otherWritten).toBe(WORKSPACE_WRITE)
  })

  it(entry('opencode.policy.workspace-cwd'), () => {
    expect(seen.workspace.bash.turns[1]?.pendingToolResults.join('\n')).toContain(seen.workspace.cwd)
  })

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
    expect(first!.mentions(KIT_DASHBOARDS_SKILL_MARKER), 'cinna-dashboards from its skills.paths folder was not listed').toBe(true)
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

  it(entry('opencode.telemetry.prompt-usage'), () => {
    const [first, last] = USAGE_STEPS
    expect(seen.usage.turns.length, 'the usage prompt did not make its two model requests').toBe(2)
    expect(seen.usage.answer?.result?.stopReason).toBe('end_turn')
    const usage = (seen.usage.answer?.result?.usage ?? {}) as Json
    // The whole turn: both requests summed, never the last one alone. Input is
    // the uncached part, so a cached read is never counted twice.
    expect(usage).toMatchObject({
      inputTokens: first.prompt - first.cached + last.prompt - last.cached,
      outputTokens: first.completion + last.completion,
      cachedReadTokens: first.cached + last.cached
    })
    // An OpenAI-compatible provider reports no cache writes, and OpenCode
    // leaves out a count of 0.
    expect(usage.cachedWriteTokens).toBeUndefined()
    const updates = usageUpdates(seen.usage)
    expect(updates.length, 'no usage_update at the end of the turn').toBe(1)
    const update = updates[0]
    // The last request's whole input plus its output: the context as it stands.
    expect(update.used).toBe(last.prompt + last.completion)
    expect(update.size).toBeGreaterThan(0)
    expect(update.cost).toMatchObject({ currency: 'USD' })
    expect(typeof (update.cost as Json).amount).toBe('number')
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

  it(entry('opencode.mcp.list-changed'), () => {
    const lc = seen.listChanged
    const added = `tools.cinna.${LC_TOOL}`
    expect(lc.error).toBeNull()
    expect(lc.relisted, 'the engine never re-listed Cinna’s tools after tools/list_changed').toBe(true)
    const before = lc.before.turns[0], after = lc.after.turns[0], fresh = lc.fresh.turns[0]
    expect(before?.systemText, 'the first prompt sent no system prompt').toContain('# Code Mode')
    expect(before?.systemText).not.toContain(added)
    // The session's system prompt — its Code Mode catalog included — is the one
    // rendered at its first prompt: the added tool is not in it.
    expect(after?.systemText === before?.systemText, 'the system prompt changed mid-session').toBe(true)
    expect(after?.systemText).not.toContain(added)
    // The change reaches the model only as a user-role notice before the prompt.
    expect(after?.userText).toMatch(new RegExp(`<system-update>[\\s\\S]*${added.replace(/\./g, '\\.')}[\\s\\S]*</system-update>`))
    // The control: a new session's system prompt lists the tool, and its call runs.
    expect(fresh?.systemText, 'a new session’s catalog does not list the added tool').toContain(added)
    expect(fresh?.userText).not.toContain('<system-update>')
    expect(lc.freshCalls).toBe(1)
    // A process that holds the endpoint does not list again for a new
    // session on its own: only an announcement makes it re-list (the bridge
    // sends one for a fresh session, `toolsRefreshMark`).
    expect(lc.freshListed, 'a new session on a warm process listed Cinna’s tools unannounced').toBe(false)
    // Announced after `session/new` and before the first prompt: re-listed,
    // and the catalog rendered at that prompt holds the tool.
    const late = lc.late.turns[0], lateTool = `tools.cinna.${LC_LATE_TOOL}`
    expect(lc.lateRelisted, 'no re-list on an announcement before the session’s first prompt').toBe(true)
    expect(late?.systemText).toContain(lateTool)
    expect(late?.userText).not.toContain('<system-update>')
    expect(lc.lateCalls).toBe(1)
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
