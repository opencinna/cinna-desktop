import { messageRepo } from '../db/messages'

/**
 * Messages that reached a running turn mid-turn (a steer the engine reported `injected`), by chat.
 *
 * Such a message becomes a `user` row only when the turn's rows are saved at its end, so the
 * transcript alone cannot say an executor had new input between two of its reports. The delegation
 * bus counts these too. In memory on purpose: after a restart the count only differs, and a differing
 * count makes a later report wake its requester — the safe direction.
 */
const KEPT_PER_CHAT = 200
const steers = new Map<string, number[]>()

export const executorInputs = {
  /** A steer the running turn in `chatId` accepted, at `at` (ms). */
  recordSteer(chatId: string, at: number = Date.now()): void {
    const list = steers.get(chatId) ?? []
    list.push(at)
    if (list.length > KEPT_PER_CHAT) list.splice(0, list.length - KEPT_PER_CHAT)
    steers.set(chatId, list)
  },

  /** How many accepted steers this chat had strictly before `at` (ms). */
  steersBefore(chatId: string, at: number): number {
    return (steers.get(chatId) ?? []).filter((time) => time < at).length
  },

  /** Test support. */
  reset(): void {
    steers.clear()
  }
}

/**
 * What had reached an executor chat from outside before `at` (ms): its newest `user`/`system` row and
 * how many mid-turn steers came before `at`. Null when the chat had no inbound row by then.
 */
export function executorInputMarker(chatId: string, at: number): string | null {
  const inbound = messageRepo.lastInboundIdBefore(chatId, at)
  return inbound ? `${inbound}#${executorInputs.steersBefore(chatId, at)}` : null
}
