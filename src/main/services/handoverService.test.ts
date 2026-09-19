import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canTransition } from '../../shared/taskStatus'
import {
  HANDOVERS_DIR,
  HANDOVER_GATE_OPTIONS,
  HANDOVER_REVISIONS_DIR,
  handoverGateRequestId,
  type HandoverIgnoreCheck
} from '../../shared/handovers'
import type { TaskArtifact, TaskDto } from '../../shared/tasks'
import type { TaskStatus } from '../../shared/taskStatus'
import type { HandoverInsert, HandoverPatch, HandoverRow } from '../db/handovers'

/*
  Everything below is driven through injected deps — the production wiring at
  the bottom of `handoverService.ts` is not what these tests exercise. It is
  still *evaluated* on import, though, and it reaches `localAgentService`, which
  reaches Electron. So the production collaborators are stubbed to nothing:
  a test that used one of them by accident would fail on the stub rather than
  quietly talking to a real repository.
*/
vi.mock('../db/client', () => ({ getDb: () => ({ transaction: (fn: () => unknown) => fn() }) }))
vi.mock('../db/handovers', () => ({ handoverRepo: {} }))
vi.mock('../db/agents', () => ({ agentRepo: {} }))
vi.mock('../db/chats', () => ({ chatRepo: {} }))
vi.mock('../db/taskInputRequests', () => ({ taskInputRequestRepo: {} }))
vi.mock('../auth/scope', () => ({
  getAgentLookupScope: () => ['__default__'],
  getProfileScopeUserId: () => 'profile-user',
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
vi.mock('./handoverWake', () => ({
  handoverWake: { wake: () => {}, wakeGroup: () => {} },
  HANDOVER_WAKE_POLL_MS: 1,
  HANDOVER_WAKE_MAX_WAIT_MS: 1
}))
vi.mock('./handoverRevisions', () => ({ handoverRevisions: { send: () => {} } }))

const { createHandoverService } = await import('./handoverService')
type HandoverAgent = import('./handoverService').HandoverAgent
type HandoverDeps = import('./handoverService').HandoverDeps

/**
 * Intake, the gate, the answer and the report — over injected collaborators and
 * **real folders** (`mkdtempSync`), which is pattern 1 in
 * `drafts/file_handovers/codebase_map.md` §13.2.
 *
 * Real files rather than a mocked `fs` because the thing being tested is a
 * reconciliation against a directory somebody else writes: half-written files,
 * a brief that vanishes, a `report.md` that appears between two scans. A mock
 * would be a second copy of the behaviour under test.
 *
 * The task store below is the smallest thing that still enforces what matters —
 * `canTransition`, so a test cannot assert a status the real `taskService`
 * would have refused, and `parentTaskId` one level deep, so the origin fallback
 * is exercised rather than assumed.
 */

const PROFILE = 'profile-user'
const SETTINGS = '__default__'
const SCOPE = { profileUserId: PROFILE, settingsUserId: SETTINGS }

interface Harness {
  service: ReturnType<typeof createHandoverService>
  deps: HandoverDeps
  agent: HandoverAgent
  dir: string
  rows: Map<string, HandoverRow>
  tasks: Map<string, TaskDto>
  requests: Map<string, { status: string; input: unknown }>
  chats: Map<string, { title: string; hidden: boolean }>
  /** Chats a test says the user has talked in. */
  usedChats: Set<string>
  started: { taskId: string; agentId: string; reuseChatId?: string }[]
  settingsWritten: string[]
  /** Every task write the service made, so "no writes" can be asserted as such. */
  taskWrites: string[]
  /** Every `repo.update` the service attempted, scope mismatch included. */
  repoWrites: number
  /** Every wake the service fired, in order. */
  wakes: { status: string; summary: string; question?: string | null; body?: string; rowId: string }[]
  /** Every group wake, with the members it spoke for. */
  groupWakes: { groupId: string; rowIds: string[] }[]
  /** Every revision turn handed to the sender, in order. */
  revisionSends: { rowId: string; chatId: string; file: string; content: string }[]
  /**
   * Revision files the sender cannot deliver — the chat is gone, the start was
   * refused, the chat never went idle. It answers `onNotSent` for these and
   * starts no turn, which is what the real sender does on all three.
   */
  refuseRevisions: Set<string>
  /**
   * What `deps.agents` answers, or `null` for "the one agent of this harness".
   * A test that changes the list under a scan in flight sets it.
   */
  agentList: HandoverAgent[] | null
  /** Resolvers for the turns `execution.start` handed back. */
  turns: ((outcome: { state: string; text: string }) => void)[]
  /** Chats `isRunning` should answer true for. */
  liveChats: Set<string>
  /** Moves the fake clock, which `now()` reads. */
  clockMs: number
  /** Set to refuse the next `start`, as `taskExecutionService` would. */
  startRefusal: string | null
  gitResult: HandoverIgnoreCheck
  handoversSetting: 'ask' | 'auto' | null
  setHandoversRefusal: string | null
  /** What `LocalAgentError.detail` carries with that refusal — `check.result`. */
  setHandoversRefusalDetail: string | null
  write(handoverId: string, file: string, text: string): void
  writeRevision(handoverId: string, file: string, text: string): void
  remove(handoverId: string, file: string): void
  row(): HandoverRow
  task(): TaskDto
}

const brief = (extra: string, body = 'Add retry to the uploader.'): string =>
  `---\ncinna_handover: 1\ntitle: Add retry\nstatus: ready\n${extra}---\n${body}\n`

const report = (extra: string, body = 'Report body.'): string =>
  `---\ncinna_handover: 1\n${extra}---\n${body}\n`

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'handover-svc-'))
  const rows = new Map<string, HandoverRow>()
  const tasks = new Map<string, TaskDto>()
  const requests = new Map<string, { status: string; input: unknown }>()
  const chats = new Map<string, { title: string; hidden: boolean }>()
  const usedChats = new Set<string>()
  const started: { taskId: string; agentId: string; reuseChatId?: string }[] = []
  const settingsWritten: string[] = []
  const taskWrites: string[] = []
  const wakes: Harness['wakes'] = []
  const groupWakes: Harness['groupWakes'] = []
  const revisionSends: Harness['revisionSends'] = []
  const refuseRevisions = new Set<string>()
  let repoWrites = 0
  const turns: Harness['turns'] = []
  const liveChats = new Set<string>()
  let ids = 0
  const nextId = (prefix: string): string => `${prefix}-${++ids}`

  const h: Partial<Harness> = {
    dir,
    rows,
    tasks,
    requests,
    chats,
    usedChats,
    started,
    settingsWritten,
    taskWrites,
    wakes,
    groupWakes,
    revisionSends,
    refuseRevisions,
    agentList: null,
    repoWrites: 0,
    turns,
    liveChats,
    clockMs: Date.now(),
    startRefusal: null,
    gitResult: { result: 'ignored' },
    handoversSetting: null,
    setHandoversRefusal: null,
    setHandoversRefusalDetail: null
  }

  const agent: HandoverAgent = {
    id: 'folder:external:root:.',
    path: dir,
    name: 'Uploader',
    get handovers() {
      return h.handoversSetting ?? null
    }
  } as HandoverAgent

  const deps: HandoverDeps = {
    repo: {
      insert(input: HandoverInsert): HandoverRow {
        const clash = [...rows.values()].find(
          (row) => row.agentId === input.agentId && row.handoverId === input.handoverId
        )
        if (clash) throw new Error('UNIQUE constraint failed: handovers.agent_id, handovers.handover_id')
        const now = new Date()
        const row = {
          id: input.id ?? nextId('row'),
          userId: input.userId,
          agentId: input.agentId,
          folderPath: input.folderPath,
          handoverId: input.handoverId,
          taskId: input.taskId,
          originAgentId: input.originAgentId ?? null,
          originChatId: input.originChatId ?? null,
          originTaskId: input.originTaskId ?? null,
          depth: input.depth,
          groupId: input.groupId ?? null,
          execution: input.execution,
          state: input.state,
          refusalReason: input.refusalReason ?? null,
          warning: input.warning ?? null,
          briefDigest: input.briefDigest,
          briefStat: input.briefStat ?? null,
          reportDigest: input.reportDigest ?? null,
          reportStat: input.reportStat ?? null,
          reportStatus: input.reportStatus ?? null,
          summary: input.summary ?? null,
          revisionsDelivered: input.revisionsDelivered ?? null,
          wokeAt: null,
          wakeRunId: null,
          briefMissingAt: null,
          gateRequestId: input.gateRequestId ?? null,
          gateChatId: input.gateChatId ?? null,
          runId: input.runId ?? null,
          lastScannedAt: input.lastScannedAt ?? now,
          createdAt: now,
          updatedAt: now
        } as HandoverRow
        rows.set(row.id, row)
        return row
      },
      byAgentAndHandoverId: (agentId, handoverId) =>
        [...rows.values()].find((row) => row.agentId === agentId && row.handoverId === handoverId),
      getById: (userId, id) => {
        const row = rows.get(id)
        return row?.userId === userId ? row : undefined
      },
      byTaskId: (userId, taskId) =>
        [...rows.values()].find((row) => row.userId === userId && row.taskId === taskId),
      listForAgent: (userId, agentId) =>
        [...rows.values()].filter((row) => row.userId === userId && row.agentId === agentId),
      listForGroup: (userId, originChatId, groupId) =>
        [...rows.values()].filter(
          (row) => row.userId === userId && row.originChatId === originChatId && row.groupId === groupId
        ),
      update(userId, id, patch: HandoverPatch) {
        repoWrites += 1
        h.repoWrites = repoWrites
        const row = rows.get(id)
        if (!row || row.userId !== userId) return undefined
        const next = { ...row, ...patch, updatedAt: new Date() } as HandoverRow
        rows.set(id, next)
        return next
      },
      toDto: (row) => ({ ...row, lastScannedAt: null, createdAt: 0, updatedAt: 0 }) as never
    },
    tasks: {
      create(userId, input) {
        if (input.parentTaskId && tasks.get(input.parentTaskId as string)?.parentTaskId) {
          throw new Error('nested_too_deep')
        }
        const task = {
          id: nextId('task'),
          title: input.title,
          goal: input.goal,
          description: input.description ?? null,
          status: (input.status as TaskStatus) ?? 'new',
          parentTaskId: (input.parentTaskId as string | null) ?? null,
          chatId: null,
          handoffNote: null,
          artifacts: [] as TaskArtifact[],
          errorMessage: null,
          assignee: { kind: 'agent', agentId: input.assigneeAgentId, name: input.assigneeName }
        } as unknown as TaskDto
        const owned = { ...task, userId } as TaskDto
        tasks.set(task.id, owned)
        return owned
      },
      getById(userId, taskId) {
        const task = tasks.get(taskId)
        // Scoped, because `taskService.getById` is: it throws `not_found` for
        // another profile's task, and a fake that answered anyway would hide
        // every cross-profile bug this suite exists to catch.
        if (!task || (task as TaskDto & { userId?: string }).userId !== userId) throw new Error('not_found')
        return task
      },
      setStatus(_userId, taskId, status, opts) {
        taskWrites.push(`status:${taskId}:${status}`)
        const task = tasks.get(taskId)
        if (!task) throw new Error('not_found')
        if (!canTransition(task.status, status)) throw new Error(`invalid_transition ${task.status}->${status}`)
        const next = { ...task, status, errorMessage: opts?.errorMessage ?? task.errorMessage }
        tasks.set(taskId, next)
        return next
      },
      setHandoffNote(_userId, taskId, note) {
        taskWrites.push(`note:${taskId}`)
        const task = tasks.get(taskId)
        if (!task) throw new Error('not_found')
        const next = { ...task, handoffNote: note }
        tasks.set(taskId, next)
        return next
      },
      setArtifacts(_userId, taskId, artifacts) {
        taskWrites.push(`artifacts:${taskId}`)
        const task = tasks.get(taskId)
        if (!task) throw new Error('not_found')
        const next = { ...task, artifacts }
        tasks.set(taskId, next)
        return next
      },
      applyRunState(_userId, taskId) {
        // `needs_input` maps to `blocked`, which `new` cannot reach — the real
        // service logs and leaves the task alone rather than throwing.
        const task = tasks.get(taskId)
        if (!task) throw new Error('not_found')
        if (!canTransition(task.status, 'blocked')) return task
        const next = { ...task, status: 'blocked' as TaskStatus }
        tasks.set(taskId, next)
        return next
      }
    },
    execution: {
      async start(_scope, taskId, target, options) {
        if (h.startRefusal) throw new Error(h.startRefusal)
        started.push({ taskId, agentId: target.agentId, reuseChatId: options?.reuseChatId })
        const chatId = options?.reuseChatId ?? nextId('chat')
        const task = tasks.get(taskId)
        if (task) tasks.set(taskId, { ...task, status: 'in_progress', chatId })
        liveChats.add(chatId)
        // The turn is left open: tests settle it by hand, which is what a real
        // one does minutes later.
        const completed = new Promise<{ state: string; text: string }>((resolve) => {
          turns.push((outcome) => {
            liveChats.delete(chatId)
            resolve(outcome)
          })
        })
        return { chatId, runId: nextId('run'), completed: completed as never }
      }
    },
    inputRequests: {
      open(input) {
        requests.set(input.requestId, { status: 'open', input })
        return input
      },
      getById: (requestId) => requests.get(requestId),
      hasOpenForTask: (taskId) =>
        [...requests.values()].some(
          (request) =>
            request.status === 'open' && (request.input as { taskId?: string }).taskId === taskId
        ),
      settle(requestId, status) {
        const existing = requests.get(requestId)
        if (existing?.status === 'open') requests.set(requestId, { ...existing, status })
        return existing
      }
    },
    chats: {
      create(_userId, init) {
        const id = nextId('chat')
        chats.set(id, { title: init.title, hidden: init.hiddenFromList })
        return { id }
      },
      showInList(_userId, chatId) {
        const chat = chats.get(chatId)
        if (!chat) return false
        chats.set(chatId, { ...chat, hidden: false })
        return true
      },
      permanentDelete: (_userId, chatId) => chats.delete(chatId),
      isEmpty: (chatId) => !h.usedChats?.has(chatId)
    },
    agents: () => h.agentList ?? [agent],
    agentExists: (agentId) => agentId === 'agent-known',
    chatAnswersToAgent: (_userId, chatId) => (chatId === 'chat-known' ? null : 'the chat is gone'),
    git: { check: async () => h.gitResult as HandoverIgnoreCheck },
    async setHandovers(settingsUserId, agentId, setting) {
      if (h.setHandoversRefusal) {
        // Shaped like the real refusal: `LocalAgentError` carries git's own
        // answer as `detail`, and the message is only a sentence for a person.
        throw Object.assign(new Error(h.setHandoversRefusal), {
          detail: h.setHandoversRefusalDetail ?? undefined
        })
      }
      settingsWritten.push(`${settingsUserId}:${agentId}:${setting}`)
      h.handoversSetting = setting
      return undefined
    },
    wake: (input) => {
      wakes.push({
        rowId: input.row.id,
        status: input.status,
        summary: input.summary,
        question: input.question,
        body: input.body
      })
    },
    wakeGroup: (input) => {
      groupWakes.push({ groupId: input.groupId, rowIds: input.rows.map((row) => row.id) })
      // The real wake records `woke_at` on every member it spoke for, and the
      // "a late member wakes alone" rule is built on exactly that column.
      for (const member of input.rows) {
        const current = rows.get(member.id)
        if (current) rows.set(member.id, { ...current, wokeAt: new Date() } as HandoverRow)
      }
    },
    sendRevision: (input) => {
      revisionSends.push({
        rowId: input.row.id,
        chatId: input.chatId,
        file: input.file,
        content: input.content
      })
      // A revision the sender could not deliver at all: no turn happens, and
      // the caller is told so it stops waiting for one.
      if (refuseRevisions.has(input.file)) {
        input.onNotSent?.('the chat is gone')
        return
      }
      // What the real sender does once the turn is accepted: hand its end back,
      // so the row is followed exactly as the first turn's is. The turn itself
      // is left open — a test settles it through `h.turns`.
      const chatId = input.chatId
      liveChats.add(chatId)
      input.watch?.(
        new Promise((resolve) => {
          turns.push((outcome) => {
            liveChats.delete(chatId)
            resolve(outcome as never)
          })
        })
      )
    },
    isRunning: (chatId) => liveChats.has(chatId),
    transaction: (fn) => fn(),
    currentScope: () => SCOPE,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    now: () => new Date(h.clockMs ?? Date.now())
  }

  Object.assign(h, {
    deps,
    agent,
    service: createHandoverService(deps),
    write(handoverId: string, file: string, text: string) {
      const folder = join(dir, HANDOVERS_DIR, handoverId)
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, file), text)
    },
    writeRevision(handoverId: string, file: string, text: string) {
      const folder = join(dir, HANDOVERS_DIR, handoverId, HANDOVER_REVISIONS_DIR)
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, file), text)
    },
    remove(handoverId: string, file: string) {
      rmSync(join(dir, HANDOVERS_DIR, handoverId, file), { force: true })
    },
    row: () => [...rows.values()][0],
    task: () => [...tasks.values()][0]
  })
  return h as Harness
}

let h: Harness

beforeEach(() => {
  h = harness()
})

afterEach(() => {
  rmSync(h.dir, { recursive: true, force: true })
})

describe('intake', () => {
  it('creates one task per brief, however often the folder is scanned', async () => {
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    await h.service.scanAgent(SCOPE, h.agent)
    await h.service.scanAgent(SCOPE, h.agent)
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.rows.size).toBe(1)
    expect(h.tasks.size).toBe(1)
    expect(h.row()).toMatchObject({ handoverId: '20260917-1200-retry', state: 'gated', depth: 1 })
    expect(h.task()).toMatchObject({ title: 'Add retry', goal: 'Add retry to the uploader.', status: 'new' })
  })

  it('ignores a draft brief, and picks it up the moment it says ready', async () => {
    h.write('20260917-1200-retry', 'brief.md', '---\ncinna_handover: 1\ntitle: Add retry\nstatus: draft\n---\nBody\n')
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.rows.size).toBe(0)

    h.write('20260917-1200-retry', 'brief.md', brief(''))
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.rows.size).toBe(1)
  })

  it('ignores a directory whose name is not a handover id', async () => {
    h.write('Not An Id', 'brief.md', brief(''))
    h.write('ab', 'brief.md', brief(''))
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.rows.size).toBe(0)
  })

  it('records an edit after ready as a warning and never as a second task', async () => {
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    await h.service.scanAgent(SCOPE, h.agent)
    const taskId = h.row().taskId

    h.write('20260917-1200-retry', 'brief.md', brief('', 'Actually, rewrite the whole uploader.'))
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.tasks.size).toBe(1)
    expect(h.row().taskId).toBe(taskId)
    expect(h.row().warning).toBe('brief_edited')
    expect(h.task().goal).toBe('Add retry to the uploader.')
  })

  it('cancels the task and skips the row when the brief is withdrawn', async () => {
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    await h.service.scanAgent(SCOPE, h.agent)
    const chatId = h.row().gateChatId

    h.remove('20260917-1200-retry', 'brief.md')
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.row().state).toBe('skipped')
    expect(h.task().status).toBe('cancelled')
    // And the row stops pointing at a directory that is gone: the task page
    // prints `.cinna/handovers/<id>` and that is a claim about a file
    // (`ux_rules.md` §9). Mutation: drop the stamp and the page names it still.
    expect(h.row().briefMissingAt).toBeInstanceOf(Date)
    // The gate and the chat it was holding go with it.
    expect(h.requests.get(handoverGateRequestId(h.row().id))?.status).toBe('expired')
    expect(h.chats.has(chatId as string)).toBe(false)
  })

  it('stamps a finished handover whose folder was tidied up, and nothing else', async () => {
    // §3.2 invites the requester to delete the folder once it has read the
    // report. The task is over and keeps everything it recorded; only the row
    // that names the directory has to stop claiming it is there.
    h.handoversSetting = 'auto'
    h.write('20260917-1200-retry', 'brief.md', brief('execution: auto\n'))
    await h.service.scanAgent(SCOPE, h.agent)
    h.write('20260917-1200-retry', 'report.md', report('status: done\nsummary: Done\n'))
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.row().state).toBe('done')
    const status = h.task().status

    h.remove('20260917-1200-retry', 'brief.md')
    h.remove('20260917-1200-retry', 'report.md')
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.row().briefMissingAt).toBeInstanceOf(Date)
    expect(h.row().state).toBe('done')
    expect(h.task().status).toBe(status)
  })

  it('points at the folder again when the brief comes back', async () => {
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    await h.service.scanAgent(SCOPE, h.agent)
    h.remove('20260917-1200-retry', 'brief.md')
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.row().briefMissingAt).toBeInstanceOf(Date)

    h.write('20260917-1200-retry', 'brief.md', brief(''))
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.row().briefMissingAt).toBeNull()
  })

  it('leaves a running handover alone when its brief disappears mid-turn', async () => {
    h.handoversSetting = 'auto'
    h.write('20260917-1200-retry', 'brief.md', brief('execution: auto\n'))
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.row().state).toBe('running')

    h.remove('20260917-1200-retry', 'brief.md')
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.row().state).toBe('running')
    expect(h.row().warning).toBe('brief_removed_while_running')
    expect(h.task().status).toBe('in_progress')
  })

  it('refuses a brief over the depth cap, with the reason on the row', async () => {
    h.write('20260917-1200-retry', 'brief.md', brief('depth: 3\n'))
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.row()).toMatchObject({ state: 'refused', refusalReason: 'depth_exceeded', depth: 3 })
    expect(h.task().status).toBe('cancelled')
    expect(h.started).toEqual([])
    expect(h.requests.size).toBe(0)
  })
})

describe('auto execution', () => {
  const matrix: {
    execution: 'ask' | 'auto'
    setting: 'ask' | 'auto' | null
    git: HandoverIgnoreCheck['result']
    state: string
    warning: string | null
  }[] = [
    { execution: 'auto', setting: 'auto', git: 'ignored', state: 'running', warning: null },
    { execution: 'auto', setting: 'auto', git: 'not_a_repo', state: 'running', warning: null },
    { execution: 'auto', setting: 'auto', git: 'not_ignored', state: 'gated', warning: 'auto_not_allowed:not_ignored' },
    { execution: 'auto', setting: 'auto', git: 'tracked', state: 'gated', warning: 'auto_not_allowed:tracked' },
    { execution: 'auto', setting: 'auto', git: 'unknown', state: 'gated', warning: 'auto_not_allowed:unknown' },
    { execution: 'auto', setting: 'ask', git: 'ignored', state: 'gated', warning: 'auto_not_allowed:setting_ask' },
    { execution: 'auto', setting: null, git: 'ignored', state: 'gated', warning: 'auto_not_allowed:setting_ask' },
    { execution: 'ask', setting: 'auto', git: 'ignored', state: 'gated', warning: null }
  ]

  for (const item of matrix) {
    it(`brief ${item.execution} + setting ${item.setting} + git ${item.git} → ${item.state}`, async () => {
      h.handoversSetting = item.setting
      h.gitResult = { result: item.git }
      h.write('20260917-1200-retry', 'brief.md', brief(`execution: ${item.execution}\n`))
      await h.service.scanAgent(SCOPE, h.agent)

      expect(h.row().state).toBe(item.state)
      expect(h.row().warning).toBe(item.warning)
      expect(h.started.length).toBe(item.state === 'running' ? 1 : 0)
    })
  }
})

describe('the gate', () => {
  it('opens a handover-owned question with no agent, a chat of its own and three options', async () => {
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    await h.service.scanAgent(SCOPE, h.agent)

    const row = h.row()
    const opened = h.requests.get(handoverGateRequestId(row.id))
    expect(opened?.status).toBe('open')
    expect(opened?.input).toMatchObject({
      taskId: row.taskId,
      chatId: row.gateChatId,
      agentId: null,
      deliveryOwner: 'handover',
      resume: 'reply'
    })
    const question = (opened?.input as { request: { questions: { options: { label: string }[] }[] } }).request.questions[0]
    expect(question.options.map((option) => option.label)).toEqual([
      HANDOVER_GATE_OPTIONS.run,
      HANDOVER_GATE_OPTIONS.runAndAuto,
      HANDOVER_GATE_OPTIONS.skip
    ])
    // The chat is created for the gate and never attached to the task.
    expect(h.chats.has(row.gateChatId as string)).toBe(true)
    expect(h.task().chatId).toBeNull()
    expect(h.task().status).toBe('new')
  })

  it('offers only Run and Skip where auto could not be granted anyway', async () => {
    h.gitResult = { result: 'tracked' }
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    await h.service.scanAgent(SCOPE, h.agent)

    const opened = h.requests.get(handoverGateRequestId(h.row().id))
    const question = (opened?.input as { request: { questions: { options: { label: string }[] }[] } }).request.questions[0]
    expect(question.options.map((option) => option.label)).toEqual([
      HANDOVER_GATE_OPTIONS.run,
      HANDOVER_GATE_OPTIONS.skip
    ])
  })
})

describe('a claim from outside the app', () => {
  it('starts nothing when a report is already there at intake', async () => {
    h.handoversSetting = 'auto'
    h.write('20260917-1200-retry', 'brief.md', brief('execution: auto\n'))
    h.write('20260917-1200-retry', 'report.md', report('status: in_progress\nsummary: Mine, I am on it\n'))
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.row()).toMatchObject({ state: 'waiting_external', reportStatus: 'in_progress' })
    expect(h.started).toEqual([])
    expect(h.task().status).toBe('in_progress')
  })

  it('withdraws an open gate when the claim lands after it', async () => {
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    await h.service.scanAgent(SCOPE, h.agent)
    const row = h.row()
    expect(row.state).toBe('gated')

    h.write('20260917-1200-retry', 'report.md', report('status: in_progress\nsummary: Picked up in a terminal\n'))
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.row()).toMatchObject({ state: 'waiting_external', gateRequestId: null, gateChatId: null })
    expect(h.requests.get(handoverGateRequestId(row.id))?.status).toBe('expired')
    expect(h.chats.has(row.gateChatId as string)).toBe(false)
    expect(h.task().status).toBe('in_progress')
  })
})

describe('answering the gate', () => {
  const runResolution = { kind: 'question' as const, answers: [[HANDOVER_GATE_OPTIONS.run]] }

  it('settles the gate and starts the executor in the chat the gate was holding', async () => {
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    await h.service.scanAgent(SCOPE, h.agent)
    const row = h.row()

    const result = await h.service.answer(PROFILE, handoverGateRequestId(row.id), runResolution)

    expect(result).toEqual({ ok: true })
    expect(h.requests.get(handoverGateRequestId(row.id))?.status).toBe('answered')
    expect(h.started).toEqual([{ taskId: row.taskId, agentId: h.agent.id, reuseChatId: row.gateChatId }])
    expect(h.row()).toMatchObject({ state: 'running', gateRequestId: null, gateChatId: null })
  })

  it('flips the agent setting before it runs, when the user asks for both', async () => {
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    await h.service.scanAgent(SCOPE, h.agent)
    const row = h.row()

    await h.service.answer(PROFILE, handoverGateRequestId(row.id), {
      kind: 'question',
      answers: [[HANDOVER_GATE_OPTIONS.runAndAuto]]
    })

    expect(h.settingsWritten).toEqual([`${SETTINGS}:${h.agent.id}:auto`])
    expect(h.started.length).toBe(1)
    expect(h.row().state).toBe('running')
  })

  it('still runs when the setting write is refused, and says why', async () => {
    h.setHandoversRefusal = 'git tracks this folder’s handovers'
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    await h.service.scanAgent(SCOPE, h.agent)

    await h.service.answer(PROFILE, handoverGateRequestId(h.row().id), {
      kind: 'question',
      answers: [[HANDOVER_GATE_OPTIONS.runAndAuto]]
    })

    expect(h.settingsWritten).toEqual([])
    expect(h.started.length).toBe(1)
    expect(h.row().warning).toMatch(/^auto_not_allowed:/)
  })

  it('takes the auto refusal from git’s own answer, not from the words of the message', async () => {
    /*
      `LocalAgentError` carries `check.result` as `detail`. Reading the message
      for the word "track" instead reported `tracked` for anything whose
      sentence happened to contain it — and `not_ignored` for a check that
      never ran. Mutation: sniff the message again and this reads `tracked`.
    */
    h.setHandoversRefusal = 'Cinna could not ask git whether it tracks this folder.'
    h.setHandoversRefusalDetail = 'unknown'
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    await h.service.scanAgent(SCOPE, h.agent)

    await h.service.answer(PROFILE, handoverGateRequestId(h.row().id), {
      kind: 'question',
      answers: [[HANDOVER_GATE_OPTIONS.runAndAuto]]
    })

    expect(h.row().warning).toBe('auto_not_allowed:unknown')
    expect(h.started.length).toBe(1)
  })

  it('names the committed folder for what it is', async () => {
    h.setHandoversRefusal = 'Add `.cinna/` to this project’s .gitignore first.'
    h.setHandoversRefusalDetail = 'tracked'
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    await h.service.scanAgent(SCOPE, h.agent)

    await h.service.answer(PROFILE, handoverGateRequestId(h.row().id), {
      kind: 'question',
      answers: [[HANDOVER_GATE_OPTIONS.runAndAuto]]
    })

    expect(h.row().warning).toBe('auto_not_allowed:tracked')
  })

  it('cancels the task and removes the unused chat on Skip', async () => {
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    await h.service.scanAgent(SCOPE, h.agent)
    const row = h.row()

    const result = await h.service.answer(PROFILE, handoverGateRequestId(row.id), {
      kind: 'question',
      answers: [[HANDOVER_GATE_OPTIONS.skip]]
    })

    expect(result).toEqual({ ok: true })
    expect(h.row()).toMatchObject({ state: 'skipped', gateChatId: null })
    expect(h.task().status).toBe('cancelled')
    expect(h.chats.has(row.gateChatId as string)).toBe(false)
    expect(h.started).toEqual([])
  })

  it('spends the gate even when the start is refused, and reports the refusal', async () => {
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    await h.service.scanAgent(SCOPE, h.agent)
    const row = h.row()
    h.startRefusal = 'That agent is unavailable. Choose another agent.'

    const result = await h.service.answer(PROFILE, handoverGateRequestId(row.id), runResolution)

    expect(result).toMatchObject({ ok: false, code: 'unavailable' })
    expect(h.requests.get(handoverGateRequestId(row.id))?.status).toBe('answered')
    expect(h.row().warning).toBe('start_refused:That agent is unavailable. Choose another agent.')
  })

  it('returns null for a request id that belongs to somebody else', () => {
    expect(h.service.answer(PROFILE, 'runner:attempt:run:tool', { kind: 'rejected' })).toBeNull()
    expect(h.service.answer(PROFILE, 'handover:no-such-row', { kind: 'rejected' })).toBeNull()
  })

  it('refuses an answer that is not one of the options', async () => {
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    await h.service.scanAgent(SCOPE, h.agent)

    const result = await h.service.answer(PROFILE, handoverGateRequestId(h.row().id), {
      kind: 'question',
      answers: [['Maybe later']]
    })

    expect(result).toMatchObject({ ok: false, code: 'malformed' })
    expect(h.started).toEqual([])
  })
})

describe('the report', () => {
  async function gateThenRun(): Promise<HandoverRow> {
    h.handoversSetting = 'auto'
    h.write('20260917-1200-retry', 'brief.md', brief('execution: auto\n'))
    await h.service.scanAgent(SCOPE, h.agent)
    return h.row()
  }

  it('completes the task on done, with the summary, the body and the artifacts', async () => {
    await gateThenRun()
    h.write(
      '20260917-1200-retry',
      'report.md',
      report('status: done\nsummary: Retry added with backoff\nartifacts:\n  - src/upload/retry.ts\n  - test/retry.test.ts\n', 'Two tests cover the 5xx path.')
    )
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.row()).toMatchObject({ state: 'done', reportStatus: 'done' })
    expect(h.task().status).toBe('completed')
    expect(h.task().handoffNote).toBe('Retry added with backoff\n\nTwo tests cover the 5xx path.')
    expect(h.task().artifacts).toEqual([
      { kind: 'file', name: 'retry.ts', ref: join(h.dir, 'src/upload/retry.ts') },
      { kind: 'file', name: 'retry.test.ts', ref: join(h.dir, 'test/retry.test.ts') }
    ])
  })

  it('errors the task on failed, with the summary as the error message', async () => {
    await gateThenRun()
    h.write('20260917-1200-retry', 'report.md', report('status: failed\nsummary: The upload API changed\n'))
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.row().state).toBe('failed')
    expect(h.task().status).toBe('error')
    expect(h.task().errorMessage).toBe('The upload API changed')
  })

  it('blocks the task and puts the question in the note', async () => {
    await gateThenRun()
    h.write(
      '20260917-1200-retry',
      'report.md',
      report('status: blocked\nsummary: Needs a decision\nquestion: Retry 4xx as well?\n', 'The API returns 429 for both.')
    )
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.row().state).toBe('blocked')
    expect(h.task().status).toBe('blocked')
    expect(h.task().handoffNote).toBe('Needs a decision\n\nQuestion: Retry 4xx as well?\n\nThe API returns 429 for both.')
  })

  it('touches the task not once more when the report has not changed', async () => {
    await gateThenRun()
    h.write('20260917-1200-retry', 'report.md', report('status: done\nsummary: Done\n'))
    await h.service.scanAgent(SCOPE, h.agent)
    const task = { ...h.task() }
    const writes = [...h.taskWrites]
    expect(writes.length).toBeGreaterThan(0)

    // The digest is what makes the minute tick free: a rescan over byte-
    // identical files must reach the task store zero times, not merely leave it
    // looking the same. An idempotent re-apply would pass the weaker assertion
    // while writing to SQLite once per minute per handover, forever.
    await h.service.scanAgent(SCOPE, h.agent)
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.taskWrites).toEqual(writes)
    expect(h.task()).toEqual(task)
    expect(h.row().reportDigest).toBeTruthy()
  })

  it('warns rather than guessing when the report will not parse', async () => {
    await gateThenRun()
    h.write('20260917-1200-retry', 'report.md', '---\ncinna_handover: 1\nstatus: done\n---\nNo summary anywhere.\n')
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.row().warning).toBe('report_unparseable')
    expect(h.row().state).toBe('running')
    expect(h.task().status).toBe('in_progress')
  })

  it('takes a brief that arrives already done from new to completed', async () => {
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    h.write('20260917-1200-retry', 'report.md', report('status: in_progress\nsummary: Started outside\n'))
    await h.service.scanAgent(SCOPE, h.agent)
    h.write('20260917-1200-retry', 'report.md', report('status: done\nsummary: Finished outside\n'))
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.row().state).toBe('done')
    expect(h.task().status).toBe('completed')
  })
})

describe('origin', () => {
  it('keeps the origin link independently of the user task tree', async () => {
    const parent = h.deps.tasks.create(PROFILE, { title: 'Ticket', goal: 'Ship the release' })
    h.write(
      '20260917-1200-retry',
      'brief.md',
      brief(`origin:\n  agent: agent-known\n  chat: chat-known\n  task: ${parent.id}\n`)
    )
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.row()).toMatchObject({
      originAgentId: 'agent-known',
      originChatId: 'chat-known',
      originTaskId: parent.id,
      warning: null
    })
    expect(h.tasks.get(h.row().taskId as string)?.parentTaskId).toBeNull()
  })

  it('drops an origin it cannot reach and runs the handover anyway', async () => {
    h.write('20260917-1200-retry', 'brief.md', brief('origin:\n  agent: agent-gone\n  chat: chat-gone\n'))
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.row()).toMatchObject({
      originAgentId: null,
      originChatId: null,
      warning: 'origin_unresolved',
      state: 'gated'
    })
  })

  it('accepts a delegation from a user subtask without a nesting warning', async () => {
    const grandparent = h.deps.tasks.create(PROFILE, { title: 'Epic', goal: 'Epic' })
    const parent = h.deps.tasks.create(PROFILE, { title: 'Ticket', goal: 'Ticket', parentTaskId: grandparent.id })
    h.write('20260917-1200-retry', 'brief.md', brief(`origin:\n  task: ${parent.id}\n`))
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.row()).toMatchObject({ originTaskId: parent.id, warning: null })
    expect(h.tasks.get(h.row().taskId as string)?.parentTaskId).toBeNull()
  })
})

describe('delegation intake', () => {
  it('preserves depth across a non-file delegation leg instead of trusting the brief', async () => {
    const parent = h.deps.tasks.create(PROFILE, { title: 'Kit task', goal: 'Delegate' })
    h.deps.chainDepth = (_userId, origin) => origin.taskId === parent.id ? 2 : null
    h.write('20260917-1200-retry', 'brief.md', brief(`depth: 1\norigin:\n  task: ${parent.id}\n`))
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.row()).toMatchObject({ depth: 3, state: 'refused', refusalReason: 'depth_exceeded' })
  })
  it('derives depth through the origin chat when the brief names no task', async () => {
    h.deps.chainDepth = (_userId, origin) => origin.chatId === 'chat-known' ? 2 : null
    h.write('20260917-1200-retry', 'brief.md', brief('depth: 1\norigin:\n  agent: agent-known\n  chat: chat-known\n'))
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.row()).toMatchObject({ depth: 3, state: 'refused', refusalReason: 'depth_exceeded' })
  })
  it('does not let the scanning profile claim another profile’s validated brief', async () => {
    h.deps.originProfile = () => 'another-profile'
    h.write('20260917-1200-retry', 'brief.md', brief('origin:\n  agent: agent-known\n  chat: chat-known\n'))
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.rows.size).toBe(0)
    expect(h.tasks.size).toBe(0)
    h.deps.originProfile = () => PROFILE
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.row().userId).toBe(PROFILE)
  })
})

describe('scanning', () => {
  it('never lets one folder take the rest of the scan down with it', async () => {
    const exploding = { ...h.agent, id: 'folder:external:root:boom', path: '/nope/does/not/exist' }
    const deps = { ...h.deps, agents: () => [exploding as HandoverAgent, h.agent] }
    const service = createHandoverService(deps)
    h.write('20260917-1200-retry', 'brief.md', brief(''))

    await expect(service.scanAll(SCOPE)).resolves.toBeUndefined()
    expect(h.rows.size).toBe(1)
  })

  it('does nothing at all when no profile is activated', async () => {
    const service = createHandoverService({ ...h.deps, currentScope: () => null })
    h.write('20260917-1200-retry', 'brief.md', brief(''))

    await service.scanFolderNow(h.dir)

    expect(h.rows.size).toBe(0)
  })

  it('scans exactly the folder a watch event named', async () => {
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    await h.service.scanFolderNow(h.dir)
    expect(h.rows.size).toBe(1)

    await h.service.scanFolderNow('/some/other/project')
    expect(h.rows.size).toBe(1)
  })

  it('answers forTask with the row behind a task, and null for an ordinary one', async () => {
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.service.forTask(PROFILE, h.row().taskId as string)).toMatchObject({
      handoverId: '20260917-1200-retry',
      state: 'gated'
    })
    expect(h.service.forTask(PROFILE, 'task-nobody')).toBeNull()
  })
})

/**
 * The return path (§3.6) and the fallback behind it (§3.9).
 *
 * Two independent signals can close a handover — the file the executor writes,
 * and the turn Cinna ran — and the whole point of these tests is the order
 * between them: **the report wins whenever it says something final**, the turn's
 * outcome speaks only where the report stayed silent, and neither may fire the
 * origin's wake twice.
 */
describe('waking the origin', () => {
  async function withOrigin(extra = ''): Promise<void> {
    h.write('20260917-1200-retry', 'brief.md', brief(`origin:\n  agent: agent-known\n  chat: chat-known\n${extra}`))
    await h.service.scanAgent(SCOPE, h.agent)
  }

  it('tells the origin how a done report ended, once', async () => {
    await withOrigin()
    h.write('20260917-1200-retry', 'report.md', report('status: done\nsummary: Retry added\nartifacts:\n  - src/retry.ts\n', 'Body.'))
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.wakes).toEqual([
      expect.objectContaining({ status: 'done', summary: 'Retry added', body: 'Body.' })
    ])

    // The digest guard is the "once": a week of scans over the same bytes must
    // not keep telling the origin the same thing.
    await h.service.scanAgent(SCOPE, h.agent)
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.wakes.length).toBe(1)
  })

  it('carries the question when the report is blocked', async () => {
    await withOrigin()
    h.write('20260917-1200-retry', 'report.md', report('status: blocked\nsummary: Needs a decision\nquestion: Retry 4xx too?\n'))
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.wakes).toEqual([
      expect.objectContaining({ status: 'blocked', question: 'Retry 4xx too?' })
    ])
    expect(h.task().status).toBe('blocked')
  })

  it('says nothing for a human-origin handover, and calls that no failure', async () => {
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    await h.service.scanAgent(SCOPE, h.agent)
    h.write('20260917-1200-retry', 'report.md', report('status: done\nsummary: Done\n'))
    await h.service.scanAgent(SCOPE, h.agent)

    // `wake` is still called — the row carries no origin and the wake module is
    // what decides there is nobody to tell — but nothing is warned about.
    expect(h.row().state).toBe('done')
    expect(h.row().warning).toBeNull()
  })

  it('never wakes on an in_progress report', async () => {
    await withOrigin()
    h.write('20260917-1200-retry', 'report.md', report('status: in_progress\nsummary: Working\n'))
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.wakes).toEqual([])
  })
})

describe('when the turn ends and the report did not', () => {
  async function running(): Promise<void> {
    h.handoversSetting = 'auto'
    h.write('20260917-1200-retry', 'brief.md', brief('execution: auto\norigin:\n  agent: agent-known\n  chat: chat-known\n'))
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.row().state).toBe('running')
  }

  /** Settle the turn `execution.start` handed back, and let the continuation run. */
  async function settle(state: string, text = ''): Promise<void> {
    h.turns[0]({ state, text })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  it('closes the task from the outcome, and says the report was missing', async () => {
    await running()
    await settle('completed', 'I added the retry and ran the tests.')

    expect(h.row()).toMatchObject({ state: 'done', warning: 'report_missing' })
    expect(h.task().status).toBe('completed')
    expect(h.task().handoffNote).toBe('I added the retry and ran the tests.')
    expect(h.wakes).toEqual([
      expect.objectContaining({ status: 'done', body: 'I added the retry and ran the tests.' })
    ])
  })

  it('errors the task on a failed turn and on a budget stop', async () => {
    await running()
    await settle('failed', 'The engine crashed.')
    expect(h.row()).toMatchObject({ state: 'failed', warning: 'report_missing' })
    expect(h.task().status).toBe('error')
    expect(h.wakes).toEqual([expect.objectContaining({ status: 'failed' })])
  })

  it('cancels the task when the turn was stopped', async () => {
    await running()
    await settle('canceled')
    expect(h.row()).toMatchObject({ state: 'skipped', warning: 'report_missing' })
    expect(h.task().status).toBe('cancelled')
    // Nothing finished, so nothing is claimed to the origin.
    expect(h.wakes).toEqual([])
  })

  it('leaves a parked turn alone — its ask is on the Inbox', async () => {
    await running()
    await settle('needs_input')
    expect(h.row().state).toBe('running')
    expect(h.task().status).toBe('in_progress')
    expect(h.wakes).toEqual([])
  })

  it('lets a report written in the turn’s last second win', async () => {
    await running()
    h.write('20260917-1200-retry', 'report.md', report('status: done\nsummary: Retry added with backoff\n', 'From the file.'))
    await settle('failed', 'the turn thought otherwise')

    // The rescan inside the continuation sees the report first, so the row is
    // no longer `running` by the time the outcome is consulted.
    expect(h.row()).toMatchObject({ state: 'done', reportStatus: 'done' })
    expect(h.row().warning).toBeNull()
    expect(h.task().status).toBe('completed')
    expect(h.wakes).toEqual([expect.objectContaining({ status: 'done', summary: 'Retry added with backoff' })])
  })

  it('leaves a blocked report blocked even when the turn completed', async () => {
    await running()
    h.write('20260917-1200-retry', 'report.md', report('status: blocked\nsummary: Needs a decision\nquestion: Which?\n'))
    await settle('completed', 'all done!')

    expect(h.row().state).toBe('blocked')
    expect(h.task().status).toBe('blocked')
    expect(h.wakes).toEqual([expect.objectContaining({ status: 'blocked' })])
  })
})

describe('a run the app lost', () => {
  async function runningRow(): Promise<void> {
    h.handoversSetting = 'auto'
    h.write('20260917-1200-retry', 'brief.md', brief('execution: auto\norigin:\n  agent: agent-known\n  chat: chat-known\n'))
    await h.service.scanAgent(SCOPE, h.agent)
  }

  it('fails the task once the run is gone and the row has gone stale', async () => {
    await runningRow()
    // The app restarted: the handle died with the process, so nothing is live
    // in that chat and nothing will ever report the outcome.
    h.liveChats.clear()
    h.clockMs += 3 * 60_000
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.row()).toMatchObject({ state: 'failed', warning: 'run_lost' })
    expect(h.task().status).toBe('error')
    expect(h.wakes).toEqual([expect.objectContaining({ status: 'failed' })])
  })

  it('gives a fresh run its grace period, and a live one forever', async () => {
    await runningRow()
    h.liveChats.clear()

    // Inside the window: a start that has only just happened must not be swept.
    h.clockMs += 30_000
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.row().state).toBe('running')

    // Past the window, but the turn is live again: still not lost.
    h.liveChats.add(h.task().chatId as string)
    h.clockMs += 5 * 60_000
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.row().state).toBe('running')
  })

  it('never calls a run lost while its executor is parked on a question', async () => {
    /*
      `applyOutcome` returns on `needs_input` and leaves the row `running` on
      purpose: the ask is the executor's own, it is on the Inbox, and answering
      it resumes the same turn. But the turn has ended — nothing is live in the
      chat — and `updated_at` goes stale while the user reads the card. The
      sweep used to error the task and tell the origin the app had closed, with
      the question still on screen. Mutation: drop the open-ask check and this
      fails on the first expectation.
    */
    await runningRow()
    const taskId = h.row().taskId as string
    h.deps.inputRequests.open({
      requestId: 'ask-of-the-executor',
      taskId,
      chatId: h.task().chatId as string,
      agentId: null,
      deliveryOwner: 'handover',
      request: { kind: 'question', questions: [] },
      resume: 'reply'
    })
    h.turns[0]({ state: 'needs_input', text: '' })
    await flush()
    h.liveChats.clear()
    h.clockMs += 5 * 60_000

    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.row()).toMatchObject({ state: 'running', warning: null })
    expect(h.task().status).toBe('in_progress')
    expect(h.wakes).toEqual([])

    // And once the ask is settled and nothing resumes, it is a lost run again.
    h.deps.inputRequests.settle('ask-of-the-executor', 'answered')
    h.clockMs += 5 * 60_000
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.row()).toMatchObject({ state: 'failed', warning: 'run_lost' })
  })

  it('keeps the more specific warning when a turn ends on an unparseable report', async () => {
    // `report_unparseable` says a file is there and will not parse, which is
    // what the executor has to fix; `report_missing` says nobody wrote one.
    await runningRow()
    h.write('20260917-1200-retry', 'report.md', 'not a report at all\n')
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.row()).toMatchObject({ state: 'running', warning: 'report_unparseable' })

    h.turns[0]({ state: 'completed', text: 'I thought I had written it.' })
    await flush()

    expect(h.row()).toMatchObject({ state: 'done', warning: 'report_unparseable' })
    expect(h.task().status).toBe('completed')
  })

  it('does not sweep a row a scan has just touched for other reasons', async () => {
    await runningRow()
    h.liveChats.clear()
    h.clockMs += 3 * 60_000
    // A report arriving in the same scan settles the row before the sweep.
    h.write('20260917-1200-retry', 'report.md', report('status: done\nsummary: Finished outside\n'))
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.row()).toMatchObject({ state: 'done', warning: null })
    expect(h.wakes).toEqual([expect.objectContaining({ status: 'done' })])
  })
})

/**
 * The gate's chat is a means, not a conversation — until somebody makes it one.
 *
 * It exists because `task_input_requests.chat_id` is NOT NULL and a task that
 * has not started has no chat. Everything below is about that borrowed status:
 * it must not appear in the sidebar before the user has decided anything, and
 * it must not be destroyed if the user went and used it.
 */
describe('the chat the gate borrows', () => {
  async function gated(): Promise<string> {
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    await h.service.scanAgent(SCOPE, h.agent)
    return h.row().gateChatId as string
  }

  it('is hidden while the gate is only a question', async () => {
    const chatId = await gated()
    expect(h.chats.get(chatId)).toMatchObject({ hidden: true })
  })

  it('appears in the sidebar once a turn actually starts in it', async () => {
    const chatId = await gated()
    await h.service.answer(PROFILE, handoverGateRequestId(h.row().id), {
      kind: 'question',
      answers: [[HANDOVER_GATE_OPTIONS.run]]
    })
    expect(h.chats.get(chatId)).toMatchObject({ hidden: false })
  })

  it('is thrown away on Skip only while it is empty', async () => {
    const chatId = await gated()
    await h.service.answer(PROFILE, handoverGateRequestId(h.row().id), {
      kind: 'question',
      answers: [[HANDOVER_GATE_OPTIONS.skip]]
    })
    expect(h.chats.has(chatId)).toBe(false)
  })

  it('keeps — and reveals — a gate chat the user has talked in', async () => {
    // `permanentDelete` is permanent and there is no undo. A hidden chat is
    // still reachable by link or search, so a user who opened it and spoke to
    // the agent has a conversation, and a withdrawn brief must not destroy it.
    const chatId = await gated()
    h.usedChats.add(chatId)

    await h.service.answer(PROFILE, handoverGateRequestId(h.row().id), {
      kind: 'question',
      answers: [[HANDOVER_GATE_OPTIONS.skip]]
    })

    expect(h.chats.has(chatId)).toBe(true)
    expect(h.chats.get(chatId)).toMatchObject({ hidden: false })
    expect(h.row()).toMatchObject({ state: 'skipped', gateChatId: null })
  })

  it('keeps a used gate chat when the brief is withdrawn instead', async () => {
    const chatId = await gated()
    h.usedChats.add(chatId)
    h.remove('20260917-1200-retry', 'brief.md')
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.chats.has(chatId)).toBe(true)
    expect(h.row().state).toBe('skipped')
    expect(h.task().status).toBe('cancelled')
  })
})

describe('a folder two profiles can both see', () => {
  it('leaves another profile’s handover entirely alone', async () => {
    // Bare agents live in the settings scope and are visible from every
    // profile; their handover rows are profile-scoped. The dedupe read is
    // unscoped because it has to match the unique index, so profile B finds A's
    // row — and without the guard every write it then makes is silently scoped
    // away while `advance` throws on A's task and is swallowed, once a minute,
    // for ever. **Nothing**, not even a scan timestamp, is the assertion.
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    await h.service.scanAgent(SCOPE, h.agent)
    // A report, so the unguarded path would try to move A's task as well.
    h.write('20260917-1200-retry', 'report.md', report('status: done\nsummary: Done\n'))

    const before = { ...h.row() }
    const taskCount = h.tasks.size
    const writesBefore = h.repoWrites
    const taskWritesBefore = [...h.taskWrites]

    await h.service.scanAgent({ profileUserId: 'other-profile', settingsUserId: SETTINGS }, h.agent)

    expect(h.repoWrites).toBe(writesBefore)
    expect(h.taskWrites).toEqual(taskWritesBefore)
    expect(h.rows.size).toBe(1)
    expect(h.tasks.size).toBe(taskCount)
    expect(h.row()).toMatchObject({ state: before.state, taskId: before.taskId, reportDigest: before.reportDigest })

    // …and A's own scan still applies the report it was owed.
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.row().state).toBe('done')
    expect(h.task().status).toBe('completed')
  })
})

describe('a withdraw racing an accepted Run', () => {
  it('claims the row before it starts, so a scan in that window cannot cancel it', async () => {
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    await h.service.scanAgent(SCOPE, h.agent)
    const rowId = h.row().id
    const chatId = h.row().gateChatId as string

    // The requester deletes the brief in the window between the user clicking
    // Run and `start` resolving. Nothing may take the chat away underneath it.
    let scanned: Promise<void> | null = null
    h.startRefusal = null
    const original = h.deps.execution.start
    h.deps.execution.start = async (scope, taskId, target, options) => {
      h.remove('20260917-1200-retry', 'brief.md')
      scanned = h.service.scanAgent(SCOPE, h.agent)
      await scanned
      return original(scope, taskId, target, options)
    }

    const result = await h.service.answer(PROFILE, handoverGateRequestId(rowId), {
      kind: 'question',
      answers: [[HANDOVER_GATE_OPTIONS.run]]
    })

    expect(result).toEqual({ ok: true })
    // The scan saw `running`, so it warned instead of cancelling.
    expect(h.row().warning).toBe('brief_removed_while_running')
    expect(h.row().state).toBe('running')
    expect(h.task().status).toBe('in_progress')
    expect(h.chats.has(chatId)).toBe(true)
  })

  it('puts a refused start back to gated rather than leaving it claimed', async () => {
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    await h.service.scanAgent(SCOPE, h.agent)
    h.startRefusal = 'That agent is unavailable. Choose another agent.'

    await h.service.answer(PROFILE, handoverGateRequestId(h.row().id), {
      kind: 'question',
      answers: [[HANDOVER_GATE_OPTIONS.run]]
    })

    expect(h.row().state).toBe('gated')
    expect(h.row().warning).toMatch(/^start_refused:/)
  })
})

describe('answering with no profile activated', () => {
  it('refuses rather than guessing the settings scope', async () => {
    // `setHandovers` writes a standing permission to execute code. Falling back
    // to the profile id would put it on the wrong scope's agent.
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    await h.service.scanAgent(SCOPE, h.agent)
    const rowId = h.row().id
    h.deps.currentScope = () => null

    const result = await createHandoverService(h.deps).answer(PROFILE, handoverGateRequestId(rowId), {
      kind: 'question',
      answers: [[HANDOVER_GATE_OPTIONS.runAndAuto]]
    })

    expect(result).toMatchObject({ ok: false, code: 'unavailable' })
    expect(h.settingsWritten).toEqual([])
    expect(h.started).toEqual([])
  })
})

/**
 * Revisions (§3.2, §3.7): the requester coming back to a handover that is
 * already on its way. Each `revisions/NNN.md` is delivered **once**, as a new
 * turn on the handover's own chat — and what the row's state and the task's
 * status are at that moment decides whether it can be delivered at all.
 */
describe('revisions', () => {
  const revision = (body: string, frontmatter = 'cinna_handover: 1\ntitle: Retry 429 too\n'): string =>
    `---\n${frontmatter}---\n${body}\n`

  /** A handover the desktop is running itself, with a chat of ours. */
  async function running(): Promise<void> {
    h.handoversSetting = 'auto'
    h.write('20260917-1200-retry', 'brief.md', brief('execution: auto\n'))
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.row().state).toBe('running')
  }

  it('sends a new revision as a turn on the handover’s own chat, once', async () => {
    await running()
    const chatId = h.task().chatId
    h.writeRevision('20260917-1200-retry', '001.md', revision('Also retry 429, with a longer backoff.'))
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.revisionSends).toEqual([
      {
        rowId: h.row().id,
        chatId,
        file: '001.md',
        content: expect.stringContaining('Revision 001 of handover `20260917-1200-retry`: Retry 429 too')
      }
    ])
    expect(h.revisionSends[0].content).toContain('Also retry 429, with a longer backoff.')
    expect(h.row().state).toBe('running')
    expect(h.task().status).toBe('in_progress')

    // Delivered is delivered: a minute of scans is not a minute of turns.
    await h.service.scanAgent(SCOPE, h.agent)
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.revisionSends.length).toBe(1)
  })

  it('follows the revision’s turn, as it follows the first one', async () => {
    /*
      A revision is a turn, and a turn that ends without a report is what
      `applyOutcome` exists for. The sender used to drop the handle, so the row
      sat `running` behind a turn nobody was watching until the lost-run sweep
      closed the task as "the app closed" — with the app open and the turn long
      finished. Mutation: drop `watch` from the send and this fails.
    */
    await running()
    h.writeRevision('20260917-1200-retry', '001.md', revision('Also retry 429.'))
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.revisionSends.length).toBe(1)

    // A turn of its own, watched like the first: without the handle there is
    // no second entry here at all.
    expect(h.turns.length).toBe(2)
    h.turns[1]({ state: 'completed', text: 'Retried 429 too.' })
    await flush()

    expect(h.row()).toMatchObject({ state: 'done', warning: 'report_missing' })
    expect(h.task().status).toBe('completed')
    expect(h.task().handoffNote).toBe('Retried 429 too.')
  })

  it('holds the task open while a second revision is still queued behind the first', async () => {
    /*
      Two revisions found in one scan are two turns, and the second waits for
      the executor's chat. The first one's turn ending without a report used to
      close the task, wake the origin and mark the row `done` there and then —
      and `002.md` then ran against a finished row whose outcome `applyOutcome`
      dropped on the floor, so the requester heard about half the work.

      Mutation: drop the `owesRevision` guard in `settleWithoutReport` and the
      assertions after the first turn fail.
    */
    await running()
    h.writeRevision('20260917-1200-retry', '001.md', revision('The first thing.'))
    h.writeRevision('20260917-1200-retry', '002.md', revision('And the second thing.'))
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.revisionSends.map((send) => send.file)).toEqual(['001.md', '002.md'])
    // The brief's own turn, then one per revision.
    expect(h.turns.length).toBe(3)

    h.turns[1]({ state: 'completed', text: 'Did the first thing.' })
    await flush()
    expect(h.row()).toMatchObject({ state: 'running' })
    expect(h.task().status).toBe('in_progress')
    expect(h.wakes).toEqual([])

    // The last turn is the one that settles the row, with what it said.
    h.turns[2]({ state: 'completed', text: 'And the second thing too.' })
    await flush()
    expect(h.row()).toMatchObject({ state: 'done', warning: 'report_missing' })
    expect(h.task().status).toBe('completed')
    expect(h.task().handoffNote).toBe('And the second thing too.')
    expect(h.wakes).toEqual([expect.objectContaining({ status: 'done', body: 'And the second thing too.' })])
  })

  it('settles from the turn that did end when a queued revision is never sent', async () => {
    // The other half of the same bookkeeping: a revision the sender could not
    // deliver produces no turn, so the row must stop waiting for one. Mutation:
    // drop `onNotSent` from the send and this row sits `running` for ever.
    await running()
    h.refuseRevisions.add('002.md')
    h.writeRevision('20260917-1200-retry', '001.md', revision('The first thing.'))
    h.writeRevision('20260917-1200-retry', '002.md', revision('And the second thing.'))
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.turns.length).toBe(2)

    h.turns[1]({ state: 'completed', text: 'Did the first thing.' })
    await flush()
    expect(h.row()).toMatchObject({ state: 'done', warning: 'report_missing' })
    expect(h.task().status).toBe('completed')
  })

  it('sends them in name order, and only the ones that are new', async () => {
    await running()
    h.writeRevision('20260917-1200-retry', '002.md', revision('And the second thing.'))
    h.writeRevision('20260917-1200-retry', '001.md', revision('The first thing.'))
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.revisionSends.map((send) => send.file)).toEqual(['001.md', '002.md'])

    h.writeRevision('20260917-1200-retry', '003.md', revision('One more.'))
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.revisionSends.map((send) => send.file)).toEqual(['001.md', '002.md', '003.md'])
  })

  it('leaves a revision on disk while the brief is still waiting in the Inbox', async () => {
    // Nothing has run, so there is nobody to tell — and nothing is recorded
    // either: the executor reads the folder when it starts, and the same path
    // picks the file up the moment a turn exists to carry it.
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    h.writeRevision('20260917-1200-retry', '001.md', revision('Also retry 429.'))
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.row().state).toBe('gated')
    expect(h.revisionSends).toEqual([])
    expect(h.row().revisionsDelivered).toBeNull()
    expect(h.row().warning).toBeNull()

    await h.service.answer(PROFILE, handoverGateRequestId(h.row().id), {
      kind: 'question',
      answers: [[HANDOVER_GATE_OPTIONS.run]]
    })
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.revisionSends.map((send) => send.file)).toEqual(['001.md'])
  })

  it('warns instead of sending when the task is already completed', async () => {
    await running()
    h.write('20260917-1200-retry', 'report.md', report('status: done\nsummary: Retry added\n'))
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.task().status).toBe('completed')

    h.writeRevision('20260917-1200-retry', '001.md', revision('One more thing.'))
    await h.service.scanAgent(SCOPE, h.agent)

    // `completed` reaches only `archived`, so there is no turn to carry it.
    expect(h.revisionSends).toEqual([])
    expect(h.row().warning).toBe('revision_after_terminal')
    // Recorded against the file, so the warning is written once and not once a
    // minute for as long as the folder exists.
    expect(JSON.parse(h.row().revisionsDelivered as string)).toEqual(['001.md'])
    const writes = h.repoWrites
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.repoWrites).toBe(writes + 1) // the scan timestamp, and nothing else
  })

  it('sends a revision after a failed report — that is how a retry is asked for', async () => {
    await running()
    h.write('20260917-1200-retry', 'report.md', report('status: failed\nsummary: The 5xx path is untestable\n'))
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.task().status).toBe('error')

    h.writeRevision('20260917-1200-retry', '001.md', revision('Stub the client and try again.'))
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.revisionSends.map((send) => send.file)).toEqual(['001.md'])
    expect(h.row().state).toBe('running')
    expect(h.task().status).toBe('in_progress')
  })

  it('answers a blocked handover — the revision is how the question gets answered', async () => {
    await running()
    h.write('20260917-1200-retry', 'report.md', report('status: blocked\nsummary: Needs a decision\nquestion: Retry 4xx too?\n'))
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.row().state).toBe('blocked')
    expect(h.task().status).toBe('blocked')

    h.writeRevision('20260917-1200-retry', '001.md', revision('No — 5xx only.'))
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.revisionSends.map((send) => send.file)).toEqual(['001.md'])
    expect(h.row().state).toBe('running')
    expect(h.task().status).toBe('in_progress')
  })

  it('has nothing to send on while somebody else is running the brief', async () => {
    h.handoversSetting = 'auto'
    h.write('20260917-1200-retry', 'brief.md', brief('execution: auto\n'))
    h.write('20260917-1200-retry', 'report.md', report('status: in_progress\nsummary: Mine, I am on it\n'))
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.row().state).toBe('waiting_external')

    h.writeRevision('20260917-1200-retry', '001.md', revision('Also retry 429.'))
    await h.service.scanAgent(SCOPE, h.agent)

    // The outside executor reads the folder for everything else; it reads this
    // there too. Nothing is recorded, so a Cinna turn later still delivers it.
    expect(h.revisionSends).toEqual([])
    expect(h.row().revisionsDelivered).toBeNull()
  })

  it('holds the revisions behind one it cannot read, and says so', async () => {
    await running()
    h.writeRevision('20260917-1200-retry', '001.md', 'Not a revision at all.\n')
    h.writeRevision('20260917-1200-retry', '002.md', revision('The second thing.'))
    await h.service.scanAgent(SCOPE, h.agent)

    // Order is the whole meaning of `NNN`: 002 does not overtake 001.
    expect(h.revisionSends).toEqual([])
    expect(h.row().warning).toBe('revision_unparseable')

    h.writeRevision('20260917-1200-retry', '001.md', revision('The first thing.'))
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.revisionSends.map((send) => send.file)).toEqual(['001.md', '002.md'])
  })

  it('ignores a file in revisions/ that is not one', async () => {
    await running()
    h.writeRevision('20260917-1200-retry', 'notes.md', revision('A person’s scratch file.'))
    h.writeRevision('20260917-1200-retry', '01.md', revision('Two digits is not the rule.'))
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.revisionSends).toEqual([])
    expect(h.row().warning).toBeNull()
  })
})

/**
 * Groups (§3.7): a requester that handed the same piece of work to several
 * projects hears **once**, when all of it is over — with one packet naming
 * every member. A `blocked` member is the exception: a question cannot wait.
 */
describe('a fan-out group', () => {
  const member = (group = 'release-cut'): string =>
    brief(`origin:\n  agent: agent-known\n  chat: chat-known\ngroup: ${group}\n`)

  const rowIds = (): string[] => [...h.rows.values()].map((row) => row.id)

  it('says nothing until every member it knows is over, then says it once', async () => {
    h.write('20260917-1200-api', 'brief.md', member())
    h.write('20260917-1200-web', 'brief.md', member())
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.rows.size).toBe(2)

    h.write('20260917-1200-api', 'report.md', report('status: done\nsummary: Retry added\n'))
    await h.service.scanAgent(SCOPE, h.agent)
    // The first one finishing is not the group finishing.
    expect(h.wakes).toEqual([])
    expect(h.groupWakes).toEqual([])

    h.write('20260917-1200-web', 'report.md', report('status: done\nsummary: The caller was updated\n'))
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.wakes).toEqual([])
    expect(h.groupWakes).toEqual([{ groupId: 'release-cut', rowIds: rowIds() }])
  })

  it('counts a skipped and a failed member as over, and names all three', async () => {
    h.write('20260917-1200-api', 'brief.md', member())
    h.write('20260917-1200-web', 'brief.md', member())
    h.write('20260917-1200-docs', 'brief.md', member())
    await h.service.scanAgent(SCOPE, h.agent)

    h.write('20260917-1200-api', 'report.md', report('status: done\nsummary: Retry added\n'))
    h.write('20260917-1200-web', 'report.md', report('status: failed\nsummary: The build was already broken\n'))
    // The third is withdrawn rather than answered — still an end.
    h.remove('20260917-1200-docs', 'brief.md')
    await h.service.scanAgent(SCOPE, h.agent)

    // One packet for the group, and no per-member packet alongside it.
    expect(h.wakes).toEqual([])
    expect(h.groupWakes.length).toBe(1)
    expect(h.groupWakes[0].rowIds.length).toBe(3)
    expect([...h.rows.values()].map((row) => row.state).sort()).toEqual(['done', 'failed', 'skipped'])
  })

  it('lets a blocked member ask immediately, alone', async () => {
    h.write('20260917-1200-api', 'brief.md', member())
    h.write('20260917-1200-web', 'brief.md', member())
    await h.service.scanAgent(SCOPE, h.agent)

    h.write('20260917-1200-api', 'report.md', report('status: blocked\nsummary: Needs a decision\nquestion: Retry 4xx too?\n'))
    await h.service.scanAgent(SCOPE, h.agent)

    // A question that waited for the rest of the group is a question nobody
    // answers — so this is the one wake that is still per member.
    expect(h.wakes).toEqual([expect.objectContaining({ status: 'blocked', question: 'Retry 4xx too?' })])
    expect(h.groupWakes).toEqual([])
  })

  it('wakes a member that arrives after the group was reported on its own', async () => {
    h.write('20260917-1200-api', 'brief.md', member())
    await h.service.scanAgent(SCOPE, h.agent)
    h.write('20260917-1200-api', 'report.md', report('status: done\nsummary: Retry added\n'))
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.groupWakes.length).toBe(1)

    // "All" can only mean all the rows the desktop knows: nothing on disk says
    // how many members a group was meant to have.
    h.write('20260917-1200-late', 'brief.md', member())
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.groupWakes.length).toBe(1)

    h.write('20260917-1200-late', 'report.md', report('status: done\nsummary: Late but done\n'))
    await h.service.scanAgent(SCOPE, h.agent)

    const late = [...h.rows.values()].find((row) => row.handoverId === '20260917-1200-late')!
    expect(h.groupWakes.length).toBe(2)
    expect(h.groupWakes[1].rowIds).toEqual([late.id])
    expect(h.wakes).toEqual([])
  })

  it('still wakes per handover when the brief named no group', async () => {
    h.write('20260917-1200-api', 'brief.md', brief('origin:\n  agent: agent-known\n  chat: chat-known\n'))
    await h.service.scanAgent(SCOPE, h.agent)
    h.write('20260917-1200-api', 'report.md', report('status: done\nsummary: Retry added\n'))
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.groupWakes).toEqual([])
    expect(h.wakes).toEqual([expect.objectContaining({ status: 'done' })])
  })

  it('keeps the summary on the row, which is what the group packet quotes', async () => {
    h.write('20260917-1200-api', 'brief.md', member())
    await h.service.scanAgent(SCOPE, h.agent)
    h.write('20260917-1200-api', 'report.md', report('status: done\nsummary: Retry added\n'))
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.row().summary).toBe('Retry added')
  })
})

/** Let every continuation attached to a settled turn run. */
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Two scans of one folder at once — the watch event and the minute tick.
 *
 * A pass is not atomic: it awaits `git` and it awaits a start, and a watch
 * event during either used to begin a second pass over the same rows. Both
 * then held snapshots taken before the other's writes.
 */
describe('two scans of one folder at once', () => {
  it('applies a report once, and wakes the origin once', async () => {
    // `b-…` is known and about to grow a report; `a-…` is new, and its intake
    // is what holds the first pass open while the second one runs.
    h.write('b-20260917-retry', 'brief.md', brief('origin:\n  agent: agent-known\n  chat: chat-known\n'))
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.rows.size).toBe(1)

    let releaseGit: () => void = () => {}
    h.deps.git.check = () =>
      new Promise((resolve) => {
        releaseGit = () => resolve({ result: 'ignored' })
      })
    h.write('a-20260918-second', 'brief.md', brief(''))
    h.write('b-20260917-retry', 'report.md', report('status: done\nsummary: Retry added\n'))

    const first = h.service.scanAgent(SCOPE, h.agent)
    await Promise.resolve()
    // The watcher, mid-pass. Before the fix this ran straight through the same
    // rows, applied the report, and then the first pass applied it again from
    // the snapshot it had taken before any of it.
    const second = h.service.scanAgent(SCOPE, h.agent)
    releaseGit()
    await Promise.all([first, second])

    const retry = [...h.rows.values()].find((row) => row.handoverId === 'b-20260917-retry')!
    expect(retry.state).toBe('done')
    expect(h.wakes).toEqual([expect.objectContaining({ status: 'done', summary: 'Retry added' })])
    // One task each, and no second one for either brief.
    expect(h.tasks.size).toBe(2)
    expect(h.rows.size).toBe(2)
  })

  /** One deferred answer for every `git` call, so the second pass is not held too. */
  function heldGit(): () => void {
    let release: () => void = () => {}
    const gate = new Promise<HandoverIgnoreCheck>((resolve) => {
      release = () => resolve({ result: 'ignored' })
    })
    h.deps.git.check = () => gate
    return release
  }

  it('reads the agent again where the queued pass starts, not where it was queued', async () => {
    /*
      The queuer's `agent` is a snapshot taken when it arrived, and the pass it
      queued runs the length of a turn later. The queuer that most often waits
      is the rescan fired right after the user answered a card with "Run
      automatically": served its own snapshot, the follow-up pass gated the next
      brief for the permission that click had just granted.

      Mutation: hand `startScan` the queued `agent` again and this brief is
      `gated` with no start at all.
    */
    h.write('a-20260918-first', 'brief.md', brief('execution: auto\n'))
    const release = heldGit()
    // What the caller could see when it asked: no standing permission yet.
    const snapshot = { ...h.agent, handovers: null }

    const first = h.service.scanAgent(SCOPE, snapshot)
    await Promise.resolve()
    const second = h.service.scanAgent(SCOPE, snapshot)
    // The click, and the brief that arrives with it.
    h.handoversSetting = 'auto'
    h.write('b-20260918-second', 'brief.md', brief('execution: auto\n'))
    release()
    await Promise.all([first, second])

    const claimed = [...h.rows.values()].find((row) => row.handoverId === 'b-20260918-second')
    expect(claimed).toMatchObject({ state: 'running' })
    expect(h.started).toEqual([{ taskId: claimed?.taskId, agentId: h.agent.id, reuseChatId: undefined }])
  })

  it('drops the queued pass when the agent is gone by the time it starts', async () => {
    // Removed from the list, disabled, its root dropped — the folder is no
    // longer one this profile hands work to, and a pass that took its briefs in
    // anyway would make tasks for an agent that is not there.
    h.write('a-20260918-first', 'brief.md', brief(''))
    const release = heldGit()

    const first = h.service.scanAgent(SCOPE, h.agent)
    await Promise.resolve()
    const second = h.service.scanAgent(SCOPE, h.agent)
    h.agentList = []
    h.write('b-20260918-second', 'brief.md', brief(''))
    release()
    await Promise.all([first, second])

    expect([...h.rows.values()].map((row) => row.handoverId)).toEqual(['a-20260918-first'])
  })
})

/**
 * What the row remembers about the two files, so the next minute costs a
 * `stat` and not a read plus a sha256 — once per handover, per folder, per
 * minute, for as long as the app is open.
 */
describe('the stamp that makes an unchanged folder free', () => {
  it('records the brief and the report as it found them', async () => {
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    h.write('20260917-1200-retry', 'report.md', report('status: in_progress\nsummary: Working\n'))
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.row().briefStat).toMatch(/^\d+:\d+$/)
    expect(h.row().reportStat).toMatch(/^\d+:\d+$/)
  })

  it('does not open a file whose mtime and size are where it left them', async () => {
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    // A whole-second mtime, so `utimesSync` below can put it back exactly:
    // `utimes` takes a `Date`, and a file's own mtime has more precision than
    // one carries.
    const stamped = new Date(Math.floor((Date.now() - 60_000) / 1000) * 1000)
    utimesSync(join(h.dir, HANDOVERS_DIR, '20260917-1200-retry', 'brief.md'), stamped, stamped)
    await h.service.scanAgent(SCOPE, h.agent)
    const path = join(h.dir, HANDOVERS_DIR, '20260917-1200-retry', 'brief.md')

    // Rewritten to the same length, and stamped back to the same mtime: from
    // the outside this is a file that has not been touched. The scan must take
    // that at face value — which is the only way to prove it did not read it.
    const edited = brief('').replace('Add retry to the uploader.', 'Add retrz to the uploader.')
    expect(edited.length).toBe(brief('').length)
    writeFileSync(path, edited)
    utimesSync(path, stamped, stamped)
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.row().warning).toBeNull()

    // And a real edit, which moves both, is seen as it always was.
    h.write('20260917-1200-retry', 'brief.md', brief('', 'Rewrite the whole uploader, actually.'))
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.row().warning).toBe('brief_edited')
  })

  it('leaves `updated_at` alone on a scan that found nothing', async () => {
    // The lost-run sweep reads that column. A stamp rewritten every minute
    // would be a freshness the sweep can never outlive.
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    await h.service.scanAgent(SCOPE, h.agent)
    const writes = h.repoWrites
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.repoWrites).toBe(writes + 1)
    expect(h.row().briefStat).not.toBeNull()
  })
})

/** The gate goes when the brief is answered elsewhere — whatever it was answered with. */
describe('a report landing on a gated brief', () => {
  async function gatedWithOrigin(): Promise<string> {
    h.write('20260917-1200-retry', 'brief.md', brief('origin:\n  agent: agent-known\n  chat: chat-known\n'))
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.row().state).toBe('gated')
    return h.row().gateChatId as string
  }

  it('withdraws the card on a blocked report, rather than offering Run for a question', async () => {
    const chatId = await gatedWithOrigin()
    h.write('20260917-1200-retry', 'report.md', report('status: blocked\nsummary: Needs a decision\nquestion: Retry 4xx too?\n'))
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.row()).toMatchObject({ state: 'blocked', gateRequestId: null, gateChatId: null })
    expect(h.requests.get(handoverGateRequestId(h.row().id))?.status).toBe('expired')
    expect(h.chats.has(chatId)).toBe(false)
    // Nothing of ours started: an outside executor is waiting on the answer.
    expect(h.started).toEqual([])
    expect(h.wakes).toEqual([expect.objectContaining({ status: 'blocked', question: 'Retry 4xx too?' })])
  })

  it('withdraws it on a finished report too, and gives the borrowed chat back', async () => {
    const chatId = await gatedWithOrigin()
    h.write('20260917-1200-retry', 'report.md', report('status: done\nsummary: Someone did it in a terminal\n'))
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.row()).toMatchObject({ state: 'done', gateRequestId: null, gateChatId: null })
    expect(h.requests.get(handoverGateRequestId(h.row().id))?.status).toBe('expired')
    expect(h.chats.has(chatId)).toBe(false)
    expect(h.task().status).toBe('completed')
  })
})

/**
 * A gate that could not be opened at intake.
 *
 * `openGate` says the next scan tries again; nothing did, and the brief sat in
 * `seen` with a task in `new` and no card anywhere.
 */
describe('a gate that failed to open', () => {
  it('is asked again on the next scan', async () => {
    const open = h.deps.inputRequests.open
    let failing = true
    h.deps.inputRequests.open = (input) => {
      if (failing) {
        failing = false
        throw new Error('the Inbox write failed')
      }
      return open(input)
    }

    h.write('20260917-1200-retry', 'brief.md', brief(''))
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.row()).toMatchObject({ state: 'seen', gateRequestId: null })
    // The chat it had borrowed went back with the failure.
    expect(h.chats.size).toBe(0)

    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.row()).toMatchObject({ state: 'gated' })
    expect(h.requests.get(handoverGateRequestId(h.row().id))?.status).toBe('open')
    expect(h.chats.size).toBe(1)
  })

  it('is not asked again for a brief somebody else is already running', async () => {
    // A `seen` row that has heard from an outside executor is being worked on,
    // and a card offering Run for it is the second executor §3.9 forbids.
    const open = h.deps.inputRequests.open
    let failing = true
    h.deps.inputRequests.open = (input) => {
      if (failing) {
        failing = false
        throw new Error('the Inbox write failed')
      }
      return open(input)
    }
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.row().state).toBe('seen')

    h.write('20260917-1200-retry', 'report.md', report('status: in_progress\nsummary: Mine\n'))
    await h.service.scanAgent(SCOPE, h.agent)
    await h.service.scanAgent(SCOPE, h.agent)
    // Recorded as somebody else's work rather than left undecided, which is
    // also what keeps `retryGate` — a `seen`-only path — away from it.
    expect(h.row().state).toBe('waiting_external')
    expect(h.requests.size).toBe(0)
  })

  it('takes the task with it when an outside executor claims a row nobody was asked about', async () => {
    /*
      A gate that never opened leaves the row `seen` with its task `new`, and
      `retryGate` will not offer that brief again once a report status is set.
      So an `in_progress` report on a `seen` row used to change nothing at all:
      the row stayed `seen` and the task `new` for ever while somebody worked it
      outside the app, with no card and nothing on the task to say who had it.

      Mutation: drop `seen` from the `in_progress` branch of
      `applyReportEffects` and the state and the status below both go back.
    */
    const open = h.deps.inputRequests.open
    h.deps.inputRequests.open = () => {
      throw new Error('the Inbox write failed')
    }
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    await h.service.scanAgent(SCOPE, h.agent)
    h.deps.inputRequests.open = open
    expect(h.row()).toMatchObject({ state: 'seen', reportStatus: null })
    expect(h.task().status).toBe('new')

    h.write('20260917-1200-retry', 'report.md', report('status: in_progress\nsummary: I have this\n'))
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.row()).toMatchObject({ state: 'waiting_external', reportStatus: 'in_progress', summary: 'I have this' })
    expect(h.task().status).toBe('in_progress')
    // An `in_progress` report is not news for the origin — it is somebody
    // starting — and that is as true on this path as on the gated one.
    expect(h.wakes).toEqual([])
  })
})

/** Intake writes a file through `taskService`; the order is what keeps it honest. */
describe('a brief another scan got to first', () => {
  it('creates no task when the row cannot be inserted', async () => {
    // `taskService.create` exports `<userData>/tasks/<id>.md`, and a file
    // written inside a transaction survives the rollback the unique index
    // causes. Mutation: create the task before the insert and this finds one.
    h.deps.repo.insert = () => {
      throw new Error('UNIQUE constraint failed: handovers.agent_id, handovers.handover_id')
    }
    h.write('20260917-1200-retry', 'brief.md', brief(''))
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.tasks.size).toBe(0)
    expect(h.rows.size).toBe(0)
  })
})

/** One wake per (row, report digest) — the rule both wake paths now follow. */
describe('telling the origin twice', () => {
  async function reported(): Promise<void> {
    h.write('20260917-1200-retry', 'brief.md', brief('origin:\n  agent: agent-known\n  chat: chat-known\n'))
    await h.service.scanAgent(SCOPE, h.agent)
    h.write('20260917-1200-retry', 'report.md', report('status: done\nsummary: Retry added\n'))
    await h.service.scanAgent(SCOPE, h.agent)
    expect(h.wakes.length).toBe(1)
    // What the real wake records once the packet lands. The fake one above
    // does not, which is why the column is written here by hand.
    const row = h.row()
    h.rows.set(row.id, { ...row, wokeAt: new Date() } as HandoverRow)
  }

  it('says nothing more about a report the origin has already been told about', async () => {
    await reported()
    // Straight at the seam, because a rescan over identical bytes never gets
    // this far: the row carries `woke_at`, and that is the whole guard.
    h.service.applyReport(SCOPE, h.row(), {
      status: 'done',
      summary: 'Retry added',
      question: null,
      artifacts: [],
      body: 'Body.'
    })
    expect(h.wakes.length).toBe(1)
  })

  it('tells it again when the report is genuinely a new one', async () => {
    await reported()
    h.write('20260917-1200-retry', 'report.md', report('status: done\nsummary: Retry added, and the flake fixed\n'))
    await h.service.scanAgent(SCOPE, h.agent)

    expect(h.wakes.length).toBe(2)
    expect(h.wakes[1]).toMatchObject({ status: 'done', summary: 'Retry added, and the flake fixed' })
    expect(h.row().wokeAt).toBeNull()
  })
})
