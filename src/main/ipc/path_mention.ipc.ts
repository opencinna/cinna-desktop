import { pathMentionIntentService } from '../host/desktop/pathMentionIntentService'
import { finderQuickAction } from '../host/desktop/finderQuickAction'
import type { PathMentionTake } from '../../shared/pathMentions'
import type { FinderQuickActionResult, FinderQuickActionStatus } from '../../shared/finderQuickAction'
import { ipcHandle } from './_wrap'

/**
 * "Mention in Cinna": the buffered Finder paths, and the Quick Action that
 * sends them. Failures come back as data; nothing here throws a code.
 */
export function registerPathMentionHandlers(): void {
  // The service decides whether a profile is active to take for.
  ipcHandle('path-mention:take', (): Promise<PathMentionTake> => pathMentionIntentService.take())

  ipcHandle('finder-quick-action:status', async (): Promise<FinderQuickActionStatus> => finderQuickAction.status())
  ipcHandle('finder-quick-action:install', (): Promise<FinderQuickActionResult> => finderQuickAction.install())
  ipcHandle('finder-quick-action:uninstall', (): Promise<FinderQuickActionResult> => finderQuickAction.uninstall())
}
