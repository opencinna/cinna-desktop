import { notificationService } from '../host/desktop/notificationService'
import { ipcHandle } from './_wrap'
import type { NotificationOpenChat } from '../../shared/desktopNotifications'

export function registerNotificationHandlers(): void {
  /**
   * The chat a notification click asked for, when the renderer that should
   * open it was not mounted to hear the push. Returned once, then cleared.
   */
  ipcHandle('notifications:take-pending-open-chat', (): NotificationOpenChat | null =>
    notificationService.takePendingOpenChat())
}
