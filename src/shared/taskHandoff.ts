import type { TaskDto } from './tasks'

export interface TaskHandoffTarget { adapterId: string; ref: string }

/** A local receipt survives lost acknowledgements and app restart. */
export interface TaskHandoffReceipt {
  taskId: string
  chatId: string | null
  state: 'creating' | 'preparing' | 'executing' | 'accepted_pending' | 'accepted' | 'uncertain' | 'dismissed'
  adapterId: string
  bindingPending: boolean
  assignee: { ref: string; name: string | null }
  remote: { id: string; key: string | null; url: string | null } | null
  message: string | null
  updatedAt: number
}

export interface TaskHandoffOptions {
  adapterId: string | null
  assignees: Array<{ ref: string; name: string | null }>
  reason: string | null
  receipt: TaskHandoffReceipt | null
}

export interface TaskHandoffOutcome {
  kind: 'accepted' | 'attention' | 'uncertain' | 'refused'
  task?: TaskDto
  receipt?: TaskHandoffReceipt
  message: string
}
