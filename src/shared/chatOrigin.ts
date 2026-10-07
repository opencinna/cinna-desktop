/**
 * Who opened a chat, recorded once when the chat row is created and never
 * changed afterwards (`chats.origin`).
 *
 * - `user`: the user opened it (the new-chat flow, `chatService.create`).
 * - `task`: a task's first conversation (`taskExecutionService.start`).
 * - `delegation`: a delegation's gate chat (`delegationService`).
 * - `handover`: a file handover's gate chat (`handoverService`).
 * - `job`: a job run's chat, or one of its script steps.
 *
 * Read by the desktop-notification decision (`services/turnNotices.ts`): a
 * chat is the user's own when it is `user`, or when the task bound to it was
 * started by the user. A chat with a task attached later (the Inbox's
 * `taskForChat`) keeps the origin it was created with.
 */
export const CHAT_ORIGINS = ['user', 'task', 'delegation', 'handover', 'job'] as const

export type ChatOrigin = (typeof CHAT_ORIGINS)[number]
