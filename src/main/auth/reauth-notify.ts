/**
 * Single place that tells the renderer "the active Cinna session is gone".
 *
 * Broadcasting an explicit event — rather than relying on the renderer to read
 * `error.code` off a rejected `invoke` — keeps the global reauth modal trigger
 * independent of IPC error serialization and React Query retry/observer
 * timing. The payload names the account + server so the modal can say *which*
 * connection needs re-auth instead of showing generic copy.
 *
 * Called from the IPC wrapper (`ipc/_wrap.ts`) for every handler that either
 * throws or returns a reauth-required code, so it fires app-wide — not just on
 * whichever screen happens to be observing the failing query.
 */
import { getMainWindow } from '../index'
import { getProfileScopeUserId } from './scope'
import { userRepo } from '../db/users'
import { CINNA_REAUTH_REQUIRED_CHANNEL, type ReauthRequiredEvent } from '../../shared/cinnaErrors'
import { createLogger } from '../logger/logger'

const logger = createLogger('reauth')

/** Map an IPC channel name to a friendly description of what was happening. */
function sourceLabel(channel: string | undefined): string | null {
  if (!channel) return null
  if (channel.startsWith('catalog:')) return 'the bundles catalog'
  if (channel.startsWith('agent-status:')) return 'agent status'
  if (channel.startsWith('agent:')) return 'remote agents'
  if (channel.startsWith('auth:')) return 'your account'
  return null
}

function resolveAccount(): { account: string; serverUrl: string | null } {
  try {
    const user = userRepo.get(getProfileScopeUserId())
    if (user && user.type === 'cinna_user') {
      return {
        account: user.cinnaFullName || user.displayName || user.username || 'your Cinna account',
        serverUrl: user.cinnaServerUrl ?? null
      }
    }
  } catch (err) {
    logger.warn('could not resolve active account for reauth event', { error: String(err) })
  }
  return { account: 'your Cinna account', serverUrl: null }
}

export function broadcastReauthRequired(channel?: string): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  const { account, serverUrl } = resolveAccount()
  const payload: ReauthRequiredEvent = { account, serverUrl, source: sourceLabel(channel) }
  logger.info('broadcasting reauth-required', { account, serverUrl, channel })
  win.webContents.send(CINNA_REAUTH_REQUIRED_CHANNEL, payload)
}
