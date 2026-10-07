/**
 * OS desktop notifications for a chat's turn that stopped while Cinna was in
 * the background (`host/desktop/notificationService.ts`).
 *
 * Main → renderer push when the user clicks one: open this chat. The chat may
 * be hidden from the list (a task's chat); opening it by id works the same.
 */
export const NOTIFICATION_OPEN_CHAT_CHANNEL = 'notification:open-chat'

export interface NotificationOpenChat {
  chatId: string
}
