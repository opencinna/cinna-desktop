import type { HandoverExecution, HandoverReportStatus, HandoverState } from './handovers'

export type DelegationOriginKind = 'local_chat' | 'local_task' | 'remote_task' | 'external'
export type DelegationTargetKind = 'bare' | 'kit' | 'cloud'
export type DelegationChannel = 'file' | 'local' | 'cloud'
export type DelegationState = HandoverState | 'creating' | 'uncertain' | 'waiting_user'
export type DelegationDispatchState = 'pending' | 'creating' | 'created' | 'uploading' | 'executing' | 'uncertain' | 'running' | 'failed'
export interface DelegationResult {
  /** Stable remote report identity; distinct questions may have identical text. */
  resultId?: string
  status: HandoverReportStatus
  summary: string
  question?: string | null
  artifacts?: string[]
  body?: string
  audience?: 'requester' | 'user'
}
export interface DelegationDto {
  id: string
  requesterKey: string
  originKind: DelegationOriginKind
  originAgentId: string | null
  originChatId: string | null
  originTaskId: string | null
  targetKind: DelegationTargetKind
  targetAgentId: string
  channel: DelegationChannel
  rootDelegationId: string
  depth: number
  taskId: string | null
  handoverId: string | null
  title: string
  execution: HandoverExecution
  state: DelegationState
  refusalReason: string | null
  warning: string | null
  resultStatus: HandoverReportStatus | null
  summary: string | null
  question: string | null
  artifacts: string[]
  groupId: string | null
  runId: string | null
  waitingOnUser: boolean
  remoteTaskKey: string | null
  remoteUrl: string | null
  /** Why a cloud dispatch stopped — the sentence a user acts on when the state is `uncertain` or `failed`. */
  dispatchError: string | null
  wokeAt: number | null
  createdAt: number
  updatedAt: number
}
export const DELEGATION_TERMINAL_STATES = new Set<DelegationState>(['done', 'failed', 'skipped', 'refused'])
/** Origins nobody in the app chose: a brief written from a terminal, later a cloud task. They never inherit a standing grant. */
const OUTSIDE_ORIGINS = new Set<DelegationOriginKind>(['external', 'remote_task'])
export function isOutsideOrigin(kind: DelegationOriginKind): boolean { return OUTSIDE_ORIGINS.has(kind) }
export function delegationOriginKey(origin: { originKind: DelegationOriginKind; originChatId?: string | null; originTaskId?: string | null; originRemoteRef?: string | null; originAgentId?: string | null }): string {
  return JSON.stringify([origin.originKind, origin.originChatId ?? null, origin.originTaskId ?? null, origin.originRemoteRef ?? null, origin.originAgentId ?? null])
}

/** Device-local links, independent of the user-made one-level task hierarchy. */
export interface TaskDelegationsDto {
  from: DelegationDto | null
  to: DelegationDto[]
}

/** A durable local follow-up. Sending is never replayed after a crash. */
export interface DelegationReply {
  id: string
  message: string
  state: 'pending' | 'sending'
}
