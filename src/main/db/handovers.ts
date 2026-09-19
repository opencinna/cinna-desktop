import { and, eq, isNull } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { getDb } from './client'
import { handovers } from './schema'
import { delegationRepo, type DelegationPatch } from './delegations'
import { parseHandoverState, type HandoverDto } from '../../shared/handovers'

export type HandoverRow = typeof handovers.$inferSelect

/** Everything the caller decides at intake. The rest is defaulted here. */
export interface HandoverInsert {
  id?: string
  title?: string
  brief?: string
  userId: string
  agentId: string
  folderPath: string
  handoverId: string
  taskId: string | null
  originAgentId?: string | null
  originChatId?: string | null
  originTaskId?: string | null
  depth: number
  groupId?: string | null
  execution: HandoverRow['execution']
  state: HandoverRow['state']
  refusalReason?: string | null
  warning?: string | null
  briefDigest: string
  briefStat?: string | null
  reportDigest?: string | null
  reportStat?: string | null
  reportStatus?: HandoverRow['reportStatus']
  summary?: string | null
  revisionsDelivered?: string | null
  gateRequestId?: string | null
  gateChatId?: string | null
  runId?: string | null
  lastScannedAt?: Date | null
}

export type HandoverPatch = Partial<
  Pick<
    HandoverRow,
    | 'taskId'
    | 'state'
    | 'refusalReason'
    | 'warning'
    | 'briefDigest'
    | 'briefStat'
    | 'reportDigest'
    | 'reportStat'
    | 'reportStatus'
    | 'summary'
    | 'revisionsDelivered'
    | 'gateRequestId'
    | 'gateChatId'
    | 'runId'
    | 'wokeAt'
    | 'wakeRunId'
    | 'briefMissingAt'
    | 'lastScannedAt'
    | 'originAgentId'
    | 'originChatId'
    | 'originTaskId'
  >
>

/**
 * `handovers` — one row per `.cinna/handovers/<id>/` folder the desktop has
 * seen.
 *
 * Scoped by `user_id` like every profile-owned table. The one method that is
 * not is {@link handoverRepo.byAgentAndHandoverId}, which is the dedupe read
 * behind the unique index: a scan asks "have I seen this folder before" and the
 * answer has to be the same one the index would give, profile or no profile.
 * Every caller then checks the row's `userId` for itself.
 */
export const handoverRepo = {
  insert(input: HandoverInsert): HandoverRow {
    const now = new Date()
    const row: HandoverRow = {
      id: input.id ?? nanoid(),
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
      gateRequestId: input.gateRequestId ?? null,
      gateChatId: input.gateChatId ?? null,
      runId: input.runId ?? null,
      wokeAt: null,
      wakeRunId: null,
      briefMissingAt: null,
      lastScannedAt: input.lastScannedAt ?? now,
      createdAt: now,
      updatedAt: now
    }
    getDb().transaction(() => {
      getDb().insert(handovers).values(row).run()
      const parent = delegationRepo.parentOfOrigin(row.userId, { taskId: row.originTaskId, chatId: row.originChatId })
      delegationRepo.insert({
        id: row.id, userId: row.userId, requesterKey: row.handoverId,
        originKind: row.originTaskId ? 'local_task' : row.originChatId ? 'local_chat' : 'external',
        originAgentId: row.originAgentId, originChatId: row.originChatId, originTaskId: row.originTaskId,
        targetKind: 'bare', targetAgentId: row.agentId, channel: 'file',
        rootDelegationId: parent?.rootDelegationId ?? row.id,
        title: input.title ?? row.handoverId, brief: input.brief ?? '',
        depth: row.depth, taskId: row.taskId, handoverId: row.id,
        execution: row.execution, state: row.state, refusalReason: row.refusalReason,
        warning: row.warning, resultStatus: row.reportStatus, resultDigest: row.reportDigest,
        summary: row.summary, groupId: row.groupId, gateRequestId: row.gateRequestId,
        gateChatId: row.gateChatId, runId: row.runId
      })
    })
    return row
  },

  /**
   * The dedupe read. Deliberately unscoped — see the note on the repo: the
   * unique index is `(agent_id, handover_id)`, so a scoped read could report
   * "new" for a pair the insert is about to be refused for.
   */
  byAgentAndHandoverId(agentId: string, handoverId: string): HandoverRow | undefined {
    return getDb()
      .select()
      .from(handovers)
      .where(and(eq(handovers.agentId, agentId), eq(handovers.handoverId, handoverId)))
      .get()
  },

  getById(userId: string, id: string): HandoverRow | undefined {
    return getDb()
      .select()
      .from(handovers)
      .where(and(eq(handovers.userId, userId), eq(handovers.id, id)))
      .get()
  },

  byTaskId(userId: string, taskId: string): HandoverRow | undefined {
    return getDb()
      .select()
      .from(handovers)
      .where(and(eq(handovers.userId, userId), eq(handovers.taskId, taskId)))
      .get()
  },

  listForAgent(userId: string, agentId: string): HandoverRow[] {
    return getDb()
      .select()
      .from(handovers)
      .where(and(eq(handovers.userId, userId), eq(handovers.agentId, agentId)))
      .all()
  },

  /**
   * Patch a row, and bump `updated_at` — **unless the only thing being written
   * is `lastScannedAt`.**
   *
   * "When this handover last changed" and "when the desktop last looked at its
   * folder" are different facts, and the scan touches every live row every
   * minute. Bumping `updated_at` for a look that found nothing would make the
   * column say a handover changed sixty times an hour, and the staleness check
   * that notices a run the app lost (`handoverService`, `run_lost`) reads
   * exactly that column — a freshness it can never outlive is a check that
   * never fires.
   */
  update(userId: string, id: string, patch: HandoverPatch): HandoverRow | undefined {
    const keys = Object.keys(patch)
    const scanOnly = keys.length === 0 || (keys.length === 1 && keys[0] === 'lastScannedAt')
    getDb().transaction(() => {
      getDb()
        .update(handovers)
        .set(scanOnly ? patch : { ...patch, updatedAt: new Date() })
        .where(and(eq(handovers.userId, userId), eq(handovers.id, id)))
        .run()
      if (!scanOnly) {
        const neutral: DelegationPatch = {}
        for (const key of ['taskId', 'state', 'refusalReason', 'warning', 'summary', 'gateRequestId', 'gateChatId', 'runId', 'wokeAt', 'wakeRunId', 'originAgentId', 'originChatId', 'originTaskId'] as const) {
          if (key in patch) Object.assign(neutral, { [key]: patch[key] })
        }
        if ('reportStatus' in patch) neutral.resultStatus = patch.reportStatus
        // File-byte digest stays on handovers; the bus hashes the parsed result.
        if (Object.keys(neutral).length) delegationRepo.update(userId, id, neutral)
      }
    })
    return this.getById(userId, id)
  },

  /**
   * Every row of one fan-out group: the same profile, the same origin chat and
   * the same `group:` id (§3.7).
   *
   * The origin chat is part of the key on purpose. A group id is a string a
   * requester chose — `release-cut` is a plausible thing for two unrelated
   * conversations to pick in the same week — and the thing being decided with
   * this list is *whose chat gets woken*, so a group that spans two origins is
   * two groups.
   */
  listForGroup(userId: string, originChatId: string, groupId: string): HandoverRow[] {
    return getDb()
      .select()
      .from(handovers)
      .where(
        and(
          eq(handovers.userId, userId),
          eq(handovers.originChatId, originChatId),
          eq(handovers.groupId, groupId)
        )
      )
      .all()
  },

  /** Rows the profile owns whose task is gone — inert, and shown as skipped. */
  orphaned(userId: string): HandoverRow[] {
    return getDb()
      .select()
      .from(handovers)
      .where(and(eq(handovers.userId, userId), isNull(handovers.taskId)))
      .all()
  },

  /**
   * What the renderer sees.
   *
   * The two digests never cross: they are a reconciliation detail of the scan,
   * and a surface that had them would be tempted to compare them itself. Dates
   * become epoch milliseconds, as `LocalAgentDto.scannedAt` does — this DTO
   * travels with the local-agent ones.
   *
   * **A row whose task is gone reads as `skipped`, whatever the column says.**
   * Deleting the task is how a user withdraws the work; the row survives only
   * so a rescan cannot create a second task for the same brief, and reporting
   * it as `running` would be a claim about a task that no longer exists.
   */
  toDto(row: HandoverRow): HandoverDto {
    const state = parseHandoverState(row.state)
    return {
      id: row.id,
      agentId: row.agentId,
      folderPath: row.folderPath,
      handoverId: row.handoverId,
      taskId: row.taskId,
      originAgentId: row.originAgentId,
      originChatId: row.originChatId,
      originTaskId: row.originTaskId,
      depth: row.depth,
      groupId: row.groupId,
      execution: row.execution,
      state:
        row.taskId === null && !['done', 'failed', 'refused', 'skipped'].includes(state)
          ? 'skipped'
          : state,
      refusalReason: row.refusalReason,
      warning: row.warning,
      reportStatus: row.reportStatus,
      runId: row.runId,
      wokeAt: row.wokeAt?.getTime() ?? null,
      briefMissingAt: row.briefMissingAt?.getTime() ?? null,
      lastScannedAt: row.lastScannedAt?.getTime() ?? null,
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime()
    }
  }
}
