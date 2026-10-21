import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, type TestDatabase } from '../db/testSupport/nodeSqlite'
import { HANDOVERS_DIR } from '../../shared/handovers'
import type { TaskDto } from '../../shared/tasks'

/*
  An executor reporting one piece of work through both channels, over the **real** handover and
  delegation repositories and the real messages table. The in-memory maps in the unit tests cannot
  show what matters here: `handoverRepo.update` mirrors `woke_at` into the delegation row, and the
  executor's input is read from rows with second-resolution timestamps.
*/
const holder = vi.hoisted(() => ({ current: null as TestDatabase | null }))
vi.mock('../db/client', () => ({ getDb: () => holder.current!.db, getRawSqlite: () => holder.current!.sqlite }))
vi.mock('../auth/scope', () => ({
  getAgentLookupScope: () => ['__default__'],
  getProfileScopeUserId: () => '__default__',
  getSettingsScopeUserId: () => '__default__'
}))
vi.mock('../auth/activation', () => ({ userActivation: { isActivated: () => true } }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }))
vi.mock('./chatRouting', () => ({ chatAnswersToAgent: () => null }))
vi.mock('./handoverGit', () => ({ handoverGit: { check: async () => ({ result: 'unknown' }) } }))
vi.mock('./localAgents/localAgentService', () => ({ localAgentService: {} }))
vi.mock('./taskExecutionService', () => ({ taskExecutionService: {} }))
vi.mock('./taskService', () => ({ taskService: {} }))
vi.mock('./taskRunnerBridge', () => ({ installTaskRunnerHooks: () => {} }))
vi.mock('./runExecutionService', () => ({ runExecutionService: { isRunning: () => false, start: () => {} } }))
vi.mock('./inboxService', () => ({ inboxService: {} }))
vi.mock('./handoverWake', () => ({
  createHandoverWake: () => ({}),
  handoverWake: { wake: () => {}, wakeGroup: () => {} },
  HANDOVER_WAKE_POLL_MS: 1,
  HANDOVER_WAKE_MAX_WAIT_MS: 1
}))
vi.mock('./handoverRevisions', () => ({ handoverRevisions: { send: () => {} } }))

const { handoverRepo } = await import('../db/handovers')
const { delegationRepo } = await import('../db/delegations')
const { messageRepo } = await import('../db/messages')
const { chatRepo } = await import('../db/chats')
const { taskRepo } = await import('../db/tasks')
const { createDelegationLifecycle } = await import('./delegationLifecycle')
const { createHandoverService } = await import('./handoverService')
const { executorInputs, executorInputMarker } = await import('./executorInputs')

const USER = '__default__'
const SCOPE = { profileUserId: USER, settingsUserId: USER }
const HANDOVER = '20261021-notes'
const BRIEF = '---\ncinna_handover: 1\ntitle: Notes\nstatus: ready\n---\nWrite the notes.\n'
const report = (summary: string) => `---\ncinna_handover: 1\nstatus: done\nsummary: ${summary}\n---\nBody.\n`

let dir: string
let clock: number
let wake: ReturnType<typeof vi.fn>
let rowId: string
let chatId: string
let lifecycle: ReturnType<typeof createDelegationLifecycle>
let service: ReturnType<typeof createHandoverService>
const agent = () => ({ id: 'bare-agent', path: dir, name: 'Bare', handovers: 'auto' as const })

/** A message row reaching the executor chat at `seconds` — `created_at` holds whole seconds. */
function inbound(content: string, seconds: number): string {
  const id = messageRepo.saveUser({ chatId, content })
  holder.current!.raw.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(seconds, id)
  return id
}

function writeReport(text: string, seconds: number): void {
  const file = join(dir, HANDOVERS_DIR, HANDOVER, 'report.md')
  writeFileSync(file, text)
  utimesSync(file, seconds, seconds)
}

/** What the real wake records once the packet lands. */
function delivered(): void {
  handoverRepo.update(USER, rowId, { wokeAt: new Date(clock), wakeRunId: `run-${clock}` })
}

/** `tasks_report`, through the same seam `taskToolService` uses. */
function toolReport(summary: string): void {
  service.applyReport(SCOPE, handoverRepo.getById(USER, rowId)!, { status: 'done', summary, question: null, artifacts: [], body: 'Body.' })
}

beforeEach(() => {
  holder.current = createTestDatabase()
  executorInputs.reset()
  dir = mkdtempSync(join(tmpdir(), 'restatement-'))
  mkdirSync(join(dir, HANDOVERS_DIR, HANDOVER), { recursive: true })
  writeFileSync(join(dir, HANDOVERS_DIR, HANDOVER, 'brief.md'), BRIEF)
  clock = 1_005_000
  wake = vi.fn()

  chatId = chatRepo.create(USER, { title: 'Executor', router: 'direct', agentId: null }).id
  const task = taskRepo.create(USER, { title: 'Notes', goal: 'Write the notes.', chatId })
  inbound('Write the notes.', 1_000)
  rowId = handoverRepo.insert({
    userId: USER, agentId: 'bare-agent', folderPath: dir, handoverId: HANDOVER, taskId: task.id, depth: 1,
    execution: 'auto', state: 'running', briefDigest: 'brief', originChatId: 'origin-chat', originAgentId: 'source', runId: 'run'
  }).id

  lifecycle = createDelegationLifecycle({
    repo: delegationRepo,
    tasks: {
      getById: (userId, id) => taskRepo.getById(userId, id) as unknown as TaskDto,
      setStatus: vi.fn(), setHandoffNote: vi.fn(), setArtifacts: vi.fn(), acceptRemoteResult: vi.fn()
    },
    hasOpenAsk: () => false,
    isRunning: () => false,
    executorInputMarker,
    wake,
    // As production mirrors the bus row onto its handover.
    mirror: (row) => {
      if (row.handoverId) handoverRepo.update(row.userId, row.handoverId, { state: row.state === 'waiting_user' ? 'blocked' : row.state as 'done', reportStatus: row.resultStatus, summary: row.summary, wokeAt: row.wokeAt, wakeRunId: row.wakeRunId })
    },
    now: () => clock,
    logger: { warn() {} }
  })
  const none = () => { throw new Error('not used here') }
  service = createHandoverService({
    repo: handoverRepo,
    applyResult: (scope, row, result, reportedAt) => {
      const delegation = delegationRepo.getById(row.userId, row.id)
      if (!delegation) return false
      lifecycle.applyResult(scope, delegation, result, reportedAt)
      return true
    },
    checkDelegationGroup: (scope, row) => lifecycle.checkGroup(scope, delegationRepo.getById(row.userId, row.id)!),
    tasks: { create: none, getById: none, setStatus: none, setHandoffNote: none, setArtifacts: none, applyRunState: none },
    execution: { start: none },
    inputRequests: { open: none, getById: () => undefined, hasOpenForTask: () => false, settle: none },
    chats: { create: none, showInList: () => false, permanentDelete: () => false, isEmpty: () => true },
    agents: () => [agent()],
    agentExists: () => true,
    chatAnswersToAgent: () => null,
    git: { check: async () => ({ result: 'unknown' as const }) },
    setHandovers: async () => undefined,
    wake: none,
    wakeGroup: none,
    sendRevision: none,
    isRunning: () => false,
    transaction: (fn) => fn(),
    currentScope: () => SCOPE,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    now: () => new Date(clock)
  })
})

afterEach(() => {
  holder.current?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('one piece of work reported twice', () => {
  it('stays one wake when an unparseable report.md lands between tasks_report and a reworded report.md', async () => {
    toolReport('Wrote the notes')
    expect(wake).toHaveBeenCalledTimes(1)
    delivered()

    clock = 1_025_000
    writeReport('just some text, no frontmatter\n', 1_020)
    await service.scanAgent(SCOPE, agent())
    expect(handoverRepo.getById(USER, rowId)?.warning).toBe('report_unparseable')
    expect(delegationRepo.getById(USER, rowId)?.wokeAt).not.toBeNull()

    clock = 1_035_000
    writeReport(report('Notes written'), 1_030)
    await service.scanAgent(SCOPE, agent())
    expect(wake).toHaveBeenCalledTimes(1)
    expect(delegationRepo.getById(USER, rowId)).toMatchObject({ summary: 'Notes written', state: 'done' })
    expect(delegationRepo.getById(USER, rowId)?.wokeAt).not.toBeNull()
  })

  it('wakes again for a report after a mid-turn steer, which has no row until the turn ends', () => {
    toolReport('Wrote the notes')
    delivered()
    executorInputs.recordSteer(chatId, 1_006_000)
    clock = 1_007_000
    toolReport('Wrote the notes, in French as asked')
    expect(wake).toHaveBeenCalledTimes(2)
  })

  it('judges a report.md the scan applies late against the input it had when written', async () => {
    writeReport(report('Wrote the notes'), 1_010)
    inbound('Also add a summary.', 1_020)
    clock = 1_030_000
    await service.scanAgent(SCOPE, agent())
    expect(wake).toHaveBeenCalledTimes(1)
    delivered()

    clock = 1_040_000
    toolReport('Wrote the notes and the summary')
    expect(wake).toHaveBeenCalledTimes(2)
  })

  it('counts a row from the same second as a report as arriving after it', () => {
    inbound('Also add a summary.', 1_010)
    clock = 1_010_500
    toolReport('Wrote the notes')
    delivered()
    clock = 1_020_000
    toolReport('Wrote the notes and the summary')
    expect(wake).toHaveBeenCalledTimes(2)
  })

  it('still swallows a pure restatement with nothing new in between', () => {
    toolReport('Wrote the notes')
    delivered()
    clock = 1_009_000
    toolReport('Notes written')
    expect(wake).toHaveBeenCalledTimes(1)
  })
})
