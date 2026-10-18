/** A task reservation spans queued work, owner transitions and durable waits. */
export interface TaskRunnerReservation {
  userId: string
  taskId: string
  /** Parent execution controlling a script child reservation. */
  controllerTaskId?: string
  id: string
  working: boolean
  cancel(): void
}

type WorkingListener = (chatId: string) => void
const workingListeners = new Set<WorkingListener>()

/**
 * Told whenever a chat starts or stops having a task runner working in it: a
 * working reservation added or removed, or an entry's `working` flipping. An
 * idle reservation coming and going is not news. Synchronous, inside the
 * map's own write; a listener that throws is ignored.
 */
export function onTaskRunnerWorkingChanged(listener: WorkingListener): () => void {
  workingListeners.add(listener)
  return () => { workingListeners.delete(listener) }
}

function notify(chatId: string): void {
  for (const listener of workingListeners) {
    try { listener(chatId) } catch { /* a listener's failure never breaks a runner's bookkeeping */ }
  }
}

/**
 * The map every runner writes (task and script runtimes, their hooks). The
 * one choke point for "is a runner working in this chat": its writers stay
 * plain `set`/`delete`, and whoever needs to know subscribes with
 * {@link onTaskRunnerWorkingChanged} — the running-sessions notice does.
 * Reservations are replaced whole (never mutated in place), so a `working`
 * flip always goes through `set`.
 */
class TaskRunnerMap extends Map<string, TaskRunnerReservation> {
  override set(chatId: string, value: TaskRunnerReservation): this {
    const before = !!super.get(chatId)?.working
    super.set(chatId, value)
    if (before !== !!value.working) notify(chatId)
    return this
  }

  override delete(chatId: string): boolean {
    const before = !!super.get(chatId)?.working
    const removed = super.delete(chatId)
    if (before) notify(chatId)
    return removed
  }

  override clear(): void {
    const working = [...super.entries()].filter(([, value]) => value.working).map(([chatId]) => chatId)
    super.clear()
    for (const chatId of working) notify(chatId)
  }
}

export const taskRunnersByChat: Map<string, TaskRunnerReservation> = new TaskRunnerMap()
