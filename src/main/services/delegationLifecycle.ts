import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { DELEGATION_TERMINAL_STATES, type DelegationResult } from '../../shared/delegations'
import { canTransition, type TaskStatus } from '../../shared/taskStatus'
import { delegationRepo, type DelegationRow, type DelegationPatch } from '../db/delegations'
import { handoverRepo, type HandoverRow } from '../db/handovers'
import { taskInputRequestRepo } from '../db/taskInputRequests'
import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { createLogger } from '../logger/logger'
import { createHandoverWake } from './handoverWake'
import { chatAnswersToAgent } from './chatRouting'
import { inboxService } from './inboxService'
import { runExecutionService, type RunScope } from './runExecutionService'
import { taskService } from './taskService'
import type { HandoverTurnOutcome } from './handoverService'

export interface DelegationLifecycleDeps {
  repo: Pick<typeof delegationRepo, 'getById' | 'update' | 'list' | 'listForGroup'>
  tasks: Pick<typeof taskService, 'getById' | 'setStatus' | 'setHandoffNote' | 'setArtifacts' | 'acceptRemoteResult'>
  hasOpenAsk(taskId: string): boolean
  isRunning(chatId: string): boolean
  wake(scope: RunScope, rows: DelegationRow[], groupId?: string, settled?: () => void): void
  mirror?(row: DelegationRow): void
  now(): number
  logger: { warn(message: string, detail?: unknown): void }
}

/** What a result digest stands in for while a row has none. */
function wakeDigestOf(row: DelegationRow): string {
  return row.resultDigest ?? `state:${row.state}`
}

function taskStatusFor(status: DelegationResult['status']): TaskStatus {
  if (status === 'done') return 'completed'
  if (status === 'failed') return 'error'
  if (status === 'blocked') return 'blocked'
  return 'in_progress'
}

function stateFor(row: DelegationRow, status: DelegationResult['status'], audience: 'requester' | 'user') {
  if (status === 'blocked' && audience === 'user') return 'waiting_user' as const
  if (status !== 'in_progress') return status
  return row.channel === 'file' && !row.runId ? 'waiting_external' as const : 'running' as const
}

/** The fields a row carries only while it holds a result or an acknowledged wake. */
const NO_WAKE = { wokeAt: null, wakeRunId: null, wakeDigest: null }
const NO_RESULT = { resultStatus: null, resultDigest: null, question: null, questionAudience: null, ...NO_WAKE }

export function createDelegationLifecycle(deps: DelegationLifecycleDeps) {
  const pendingWakes = new Set<string>()
  const wakeKey = (row: DelegationRow) => `${row.id}:${row.resultDigest ?? row.state}`

  function patch(row: DelegationRow, values: DelegationPatch): DelegationRow {
    const updated = deps.repo.update(row.userId, row.id, values) ?? row
    deps.mirror?.(updated)
    return updated
  }

  function advance(row: DelegationRow, to: TaskStatus): void {
    if (!row.taskId) return
    const task = deps.tasks.getById(row.userId, row.taskId)
    if (task.status === to) return
    if (!canTransition(task.status, to)) {
      if (!canTransition(task.status, 'in_progress') || !canTransition('in_progress', to)) return
      deps.tasks.setStatus(row.userId, row.taskId, 'in_progress')
    }
    deps.tasks.setStatus(row.userId, row.taskId, to)
  }

  function wake(scope: RunScope, row: DelegationRow): void {
    if (!row.originChatId || !row.originAgentId) return
    if (row.resultStatus === 'blocked' && row.questionAudience === 'user') return

    let rows = [row]
    const groupId = row.resultStatus !== 'blocked' ? row.groupId : null
    if (groupId) {
      rows = deps.repo.listForGroup(row.userId, row.originChatId, groupId)
      if (rows.some((member) => !DELEGATION_TERMINAL_STATES.has(member.state))) return
    }
    const pending = rows.filter((member) => !member.wokeAt && !pendingWakes.has(wakeKey(member)))
    if (!pending.length) return
    if (!groupId) rows = pending

    // Claim before enqueueing: two channels can finish while this chat is busy.
    const claimed = rows.map((member) => {
      pendingWakes.add(wakeKey(member))
      return patch(member, { wakeDigest: wakeDigestOf(member) })
    })
    deps.wake(scope, claimed, groupId ?? undefined, () => {
      for (const member of claimed) pendingWakes.delete(wakeKey(member))
    })
  }

  function applyResult(scope: RunScope, initial: DelegationRow, result: DelegationResult): void {
    const row = deps.repo.getById(scope.profileUserId, initial.id)
    if (!row || !row.taskId) return

    // Key order is part of the digest: do not reorder these fields.
    const normalized = {
      status: result.status,
      summary: result.summary.trim(),
      question: result.question ?? null,
      artifacts: result.artifacts ?? [],
      body: result.body ?? '',
      audience: result.audience ?? 'requester',
      ...(result.resultId ? { resultId: result.resultId } : {})
    }
    const digest = createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
    const state = stateFor(row, result.status, normalized.audience)
    const status = taskStatusFor(result.status)

    if (row.resultDigest === digest) {
      // A revision can report the same answer; restore its state without waking twice.
      if (row.state !== state) {
        if (row.channel !== 'cloud') advance(row, status)
        patch(row, { state })
      }
      return
    }

    const questionPart = normalized.question ? `\n\nQuestion: ${normalized.question}` : ''
    const handoffNote = `${normalized.summary}${questionPart}\n\n${normalized.body}`
    const artifacts = normalized.artifacts.map((ref) => ({
      kind: /^https?:\/\//.test(ref) ? 'link' as const : 'file' as const,
      name: basename(ref),
      ref
    }))
    if (row.channel === 'cloud') {
      deps.tasks.acceptRemoteResult(row.userId, row.taskId, {
        status,
        handoffNote,
        artifacts,
        errorMessage: status === 'error' ? normalized.summary : null
      })
    } else {
      deps.tasks.setHandoffNote(row.userId, row.taskId, handoffNote)
      deps.tasks.setArtifacts(row.userId, row.taskId, artifacts)
      advance(row, status)
    }

    const updated = patch(row, {
      state,
      resultStatus: result.status,
      summary: normalized.summary,
      question: normalized.question,
      artifacts: normalized.artifacts,
      resultBody: normalized.body,
      questionAudience: normalized.audience,
      resultDigest: digest,
      ...NO_WAKE
    })
    if (result.status !== 'in_progress') wake(scope, updated)
  }

  function applyOutcome(scope: RunScope, rowId: string, outcome: HandoverTurnOutcome): void {
    const row = deps.repo.getById(scope.profileUserId, rowId)
    if (!row || !row.taskId) return
    if (DELEGATION_TERMINAL_STATES.has(row.state) || row.state === 'blocked' || row.state === 'waiting_user') return
    if (outcome.state === 'needs_input' || row.pendingReplies?.some((reply) => reply.state === 'pending')) return
    if (deps.hasOpenAsk(row.taskId)) return

    if (outcome.state === 'canceled') {
      advance(row, 'cancelled')
      const stopped = patch(row, {
        state: 'skipped',
        warning: 'report_missing',
        summary: 'The executor’s turn was stopped before it reported.',
        ...NO_RESULT
      })
      wake(scope, stopped)
      return
    }

    const completed = outcome.state === 'completed'
    applyResult(scope, row, {
      status: completed ? 'done' : 'failed',
      summary: completed
        ? 'The executor finished its turn without a structured report.'
        : 'The executor’s turn ended without a structured report.',
      body: outcome.text
    })
    patch(row, { warning: 'report_missing' })
  }

  return {
    applyResult,
    applyOutcome,
    skip(scope: RunScope, initial: DelegationRow, summary: string): void {
      const row = deps.repo.getById(scope.profileUserId, initial.id)
      if (!row || DELEGATION_TERMINAL_STATES.has(row.state)) return
      advance(row, 'cancelled')
      wake(scope, patch(row, { state: 'skipped', summary, ...NO_RESULT }))
    },

    checkGroup(scope: RunScope, row: DelegationRow): void {
      wake(scope, row)
    },

    watchTurn(scope: RunScope, rowId: string, completed: Promise<HandoverTurnOutcome>): void {
      void completed
        .then((outcome) => applyOutcome(scope, rowId, outcome))
        .catch((error) => {
          deps.logger.warn('delegated turn outcome could not be applied', { rowId, error: String(error) })
          applyOutcome(scope, rowId, { state: 'failed', text: String(error) })
        })
    },

    sweepLostRuns(scope: RunScope): void {
      for (const row of deps.repo.list(scope.profileUserId)) {
        // Retry only a result whose packet never arrived. A row with no result was never owed one
        // here (every handover settled before this table existed is one), and a refused wake is
        // final — retrying either opens a paid turn in the origin chat on every tick.
        const owed =
          !row.wokeAt &&
          !!row.resultDigest &&
          !row.warning?.startsWith('wake_refused:') &&
          row.warning !== 'report_unparseable'
        if (owed && (DELEGATION_TERMINAL_STATES.has(row.state) || row.resultStatus === 'blocked')) wake(scope, row)

        // A remote executor remains alive after this desktop closes, and the file channel
        // sweeps its own rows, where a run between two queued revisions is not a lost one.
        if (row.channel !== 'local' || row.state !== 'running' || !row.taskId) continue
        if (row.updatedAt.getTime() > deps.now() - 120_000) continue
        if (deps.hasOpenAsk(row.taskId)) continue

        let task
        try {
          task = deps.tasks.getById(row.userId, row.taskId)
        } catch (error) {
          const retired = patch(row, {
            state: 'skipped',
            summary: 'The delegation’s task was removed.',
            warning: 'task_removed'
          })
          wake(scope, retired)
          deps.logger.warn('A removed delegation task was retired', { id: row.id, error: String(error) })
          continue
        }
        if (row.pendingReplies?.length || (task.chatId && deps.isRunning(task.chatId))) continue

        applyResult(scope, row, { status: 'failed', summary: 'The executor’s run was lost when the app closed.' })
        patch(row, { warning: 'run_lost' })
      }
    }
  }
}

/** Legacy packet shape retained for existing transcript rendering. */
function packetRow(row: DelegationRow): HandoverRow {
  const file = row.handoverId ? handoverRepo.getById(row.userId, row.handoverId) : undefined
  const transient = row.state === 'waiting_user' || row.state === 'creating' || row.state === 'uncertain'
  return {
    ...file,
    id: row.id,
    userId: row.userId,
    handoverId: row.requesterKey,
    folderPath: file?.folderPath ?? row.remoteUrl ?? row.targetAgentId,
    taskId: row.taskId,
    originAgentId: row.originAgentId,
    originChatId: row.originChatId,
    originTaskId: row.originTaskId,
    state: transient ? 'running' : row.state,
    summary: row.summary
  } as HandoverRow
}

/** What the requester reads when a local or cloud delegation comes back. The file channel builds its own. */
function returnPacket(row: DelegationRow): string {
  const remoteTask = [row.remoteTaskKey, row.remoteUrl].filter(Boolean).join(' ')
  return [
    `Delegation ${row.requesterKey} ${row.resultStatus ?? row.state}: ${row.summary ?? ''}`,
    `Target: ${row.targetAgentId}`,
    `Task: ${row.taskId}`,
    ...(row.remoteUrl ? [`Remote task: ${remoteTask}`] : []),
    ...(row.channel === 'cloud' && row.warning ? [`Note: ${row.warning}`] : []),
    ...(row.question
      ? [`Question: ${row.question}`, `Reply with handover_reply using id "${row.id}" and your answer as message.`]
      : []),
    ...row.artifacts.map((ref) => `Artifact: ${ref}`),
    (row.resultBody ?? '').slice(0, 4000)
  ]
    .filter(Boolean)
    .join('\n\n')
}

const logger = createLogger('delegations')
let sharedWake: ReturnType<typeof createHandoverWake> | undefined

function getWake() {
  return (sharedWake ??= createHandoverWake({
    chatAnswersToAgent,
    isActive: (scope) => userActivation.isActivated() && getProfileScopeUserId() === scope.profileUserId,
    isCurrent(userId, id, digest) {
      const row = delegationRepo.getById(userId, id)
      if (!row || wakeDigestOf(row) !== digest) return false
      return DELEGATION_TERMINAL_STATES.has(row.state) || row.state === 'blocked'
    },
    isRunning: (id) => runExecutionService.isRunning(id),
    async send(scope, chatId, content) {
      const handle = runExecutionService.start(
        scope,
        { chatId, content },
        { inputOrigin: 'handover', observe: (ctx, event) => inboxService.recordRunEvent(ctx, event) }
      )
      await handle.accepted
      return { runId: handle.id }
    },
    record(userId, id, values, expectedDigest) {
      const row = delegationRepo.recordWake(userId, id, expectedDigest, values)
      if (row?.handoverId) handoverRepo.update(userId, row.handoverId, values)
    },
    logger,
    now: () => Date.now(),
    delay: (ms) =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms)
        timer.unref?.()
      })
  }))
}

export const delegationLifecycle = createDelegationLifecycle({
  repo: delegationRepo,
  tasks: taskService,
  hasOpenAsk: (id) => taskInputRequestRepo.listOpenForTask(id).length > 0,
  isRunning: (id) => runExecutionService.isRunning(id),
  now: () => Date.now(),
  logger,
  mirror(row) {
    if (!row.handoverId) return
    const state = row.state === 'waiting_user' ? 'blocked' : row.state
    if (state === 'creating' || state === 'uncertain') return
    handoverRepo.update(row.userId, row.handoverId, {
      state,
      reportStatus: row.resultStatus,
      summary: row.summary,
      warning: row.warning,
      wokeAt: row.wokeAt,
      wakeRunId: row.wakeRunId
    })
  },
  wake(scope, rows, groupId, onSettled) {
    if (groupId) {
      getWake().wakeGroup({
        scope,
        onSettled,
        groupId,
        rows: rows.map(packetRow),
        expectedDigests: Object.fromEntries(rows.map((row) => [row.id, wakeDigestOf(row)]))
      })
      return
    }

    const row = rows[0]
    getWake().wake({
      scope,
      onSettled,
      row: packetRow(row),
      packet: row.channel === 'file' ? undefined : returnPacket(row),
      expectedDigest: wakeDigestOf(row),
      status: row.resultStatus ?? (row.state === 'done' ? 'done' : 'failed'),
      summary: row.summary ?? '',
      question: row.question,
      artifacts: row.artifacts,
      body: row.resultBody ?? ''
    })
  }
})
