import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { runtimeHost } from '../host/runtimeHost'
import { createLogger } from '../logger/logger'
import { githubAuthService } from '../services/github/githubAuthService'
import { GITHUB_URLS, type GithubDeviceFlowDto, type GithubResult, type GithubStatusDto, type GithubUrlTarget } from '../../shared/github'
import { ipcHandle } from './_wrap'

const logger = createLogger('github')

/** A window regaining focus asks for a coverage read; one per profile per 10 s reaches GitHub. */
export const CHECK_AGAIN_INTERVAL_MS = 10_000
const lastCheck = new Map<string, number>()

/** Only github.com pages leave through these handlers, whatever a stored need says. */
function isGithubPage(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com'
  } catch {
    return false
  }
}

/**
 * Every verb acts on the active profile, which main resolves itself (no `userId` from the renderer,
 * as `localdev:*`). A refusal comes back as data: a thrown error's message crosses IPC rewritten
 * and its code not at all.
 */
async function outcome<T>(fn: (userId: string) => T | Promise<T>, fallback: string): Promise<GithubResult<T>> {
  try {
    userActivation.requireActivated()
    return { ok: true, value: await fn(getProfileScopeUserId()) }
  } catch (error) {
    return { ok: false, error: error instanceof Error && error.message ? error.message : fallback }
  }
}

async function open(url: string): Promise<void> {
  if (!isGithubPage(url)) throw new Error('That link is not a GitHub page.')
  try {
    await runtimeHost.shell.openExternal(url)
  } catch (error) {
    logger.warn('Could not open a GitHub page', { error: error instanceof Error ? error.message : String(error) })
    throw new Error(`Couldn’t open your browser. Go to ${url} yourself.`)
  }
}

/** GitHub (OpenCinna) sign-in, coverage and the composer's needs, for the active profile. */
export function registerGithubHandlers(): void {
  ipcHandle('github:status', (): Promise<GithubResult<GithubStatusDto>> =>
    outcome((userId) => githubAuthService.status(userId), 'Couldn’t read the GitHub sign-in.'))

  // Starts the device flow (or answers the one already pending) and opens github.com/login/device.
  // The code stays in `status.device` when the browser does not open, so the row still shows it.
  ipcHandle('github:sign-in', (): Promise<GithubResult<GithubDeviceFlowDto>> =>
    outcome(async (userId) => {
      const device = await githubAuthService.startDeviceFlow(userId)
      await open(device.verificationUri)
      return device
    }, 'The GitHub sign-in couldn’t start. Try again.'))

  ipcHandle('github:cancel-sign-in', (): Promise<GithubResult<null>> =>
    outcome((userId) => { githubAuthService.cancelDeviceFlow(userId); return null }, 'Couldn’t cancel the sign-in.'))

  ipcHandle('github:sign-out', (): Promise<GithubResult<null>> =>
    outcome((userId) => { githubAuthService.signOut(userId); return null }, 'Couldn’t sign out of GitHub.'))

  ipcHandle('github:check-again', (): Promise<GithubResult<GithubStatusDto>> =>
    outcome((userId) => {
      const now = Date.now()
      if (now - (lastCheck.get(userId) ?? -Infinity) < CHECK_AGAIN_INTERVAL_MS) return githubAuthService.status(userId)
      lastCheck.set(userId, now)
      return githubAuthService.checkAgain(userId)
    }, 'Couldn’t read the GitHub installations.'))

  ipcHandle('github:dismiss', (_event, key: unknown): Promise<GithubResult<null>> =>
    outcome((userId) => {
      if (typeof key !== 'string' || !key) throw new Error('Nothing to dismiss.')
      githubAuthService.dismiss(userId, key)
      return null
    }, 'Couldn’t dismiss it.'))

  // Opens the install (or configure) page main stored for that need; the URL never comes from the renderer.
  ipcHandle('github:open-install', (_event, key: unknown): Promise<GithubResult<null>> =>
    outcome(async (userId) => {
      const need = typeof key === 'string' ? (await githubAuthService.status(userId)).needs.find((n) => n.key === key && n.kind === 'install') : undefined
      if (!need?.installUrl) throw new Error('This GitHub request is gone. Run the command again.')
      await open(need.installUrl)
      return null
    }, 'Couldn’t open GitHub.'))

  ipcHandle('github:open-url', (_event, target: unknown): Promise<GithubResult<null>> =>
    outcome(async () => {
      if (typeof target !== 'string' || !Object.hasOwn(GITHUB_URLS, target)) throw new Error('That GitHub page isn’t offered.')
      await open(GITHUB_URLS[target as GithubUrlTarget])
      return null
    }, 'Couldn’t open GitHub.'))
}
