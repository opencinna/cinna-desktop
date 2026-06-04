import { nanoid } from 'nanoid'
import { userRepo, UserRow } from '../db/users'
import { hashPassword, verifyPassword, getCurrentUserId } from '../auth/session'
import { userActivation } from '../auth/activation'
import {
  CINNA_CLOUD_URL,
  startCinnaOAuthFlow,
  CinnaReauthRequired
} from '../auth/cinna-oauth'
import { storeCinnaTokens, clearCinnaTokens } from '../auth/cinna-tokens'
import { syncService } from './syncService'
import { AuthError } from '../errors'
import { createLogger } from '../logger/logger'
import { DEFAULT_USER_ID } from '../../shared/userIds'

const logger = createLogger('auth')

const MIN_PASSWORD_LENGTH = 4

function assertPasswordStrong(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(
      'password_too_weak',
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
    )
  }
}

export interface UserDto {
  id: string
  type: string
  username: string
  displayName: string
  hasPassword: boolean
  createdAt: Date
  cinnaFullName?: string
  cinnaHostingType?: 'cloud' | 'self_hosted'
  cinnaServerUrl?: string
  hasCinnaTokens?: boolean
}

export interface LocalRegisterInput {
  username: string
  displayName?: string
  password?: string
}

export interface CinnaRegisterInput {
  hostingType: 'cloud' | 'self_hosted'
  serverUrl?: string
}


export interface LoginInput {
  userId: string
  password?: string
}

export interface UpdateUserInput {
  userId: string
  displayName?: string
  password?: string
  removePassword?: boolean
}

export interface DeleteAccountInput {
  userId: string
  password?: string
  /**
   * Non-destructive sign-out (UserMenu) vs. full account removal (Settings →
   * User Accounts). When true, a Cinna profile's row is KEPT (tokens cleared)
   * so a later re-login rebinds to it; only local profile-scoped data is wiped.
   * When false/absent, the profile is fully deleted. Ignored for local
   * profiles, which are always fully deleted (no server copy to restore from).
   */
  signOut?: boolean
  /**
   * Cinna sign-out only. When true (the default), also removes this device from
   * the account — the local sync keypair is dropped and the device is revoked
   * server-side, so the next sign-in must restore via recovery key or pairing.
   * When false, the device stays trusted and the next sign-in re-syncs
   * automatically. A full delete (`signOut !== true`) always removes the device.
   */
  removeDevice?: boolean
}

export interface StartupResult {
  needsLogin: boolean
  user?: UserDto
  pendingUser?: UserDto
}

function toDto(row: UserRow): UserDto {
  const dto: UserDto = {
    id: row.id,
    type: row.type,
    username: row.username,
    displayName: row.displayName,
    hasPassword: !!row.passwordHash,
    createdAt: row.createdAt
  }
  if (row.type === 'cinna_user') {
    dto.cinnaFullName = row.cinnaFullName ?? undefined
    dto.cinnaHostingType = row.cinnaHostingType as 'cloud' | 'self_hosted' | undefined
    dto.cinnaServerUrl = row.cinnaServerUrl ?? undefined
    dto.hasCinnaTokens = !!(row.cinnaAccessTokenEnc && row.cinnaRefreshTokenEnc)
  }
  return dto
}

export const authService = {
  listUsers(): UserDto[] {
    return userRepo.list().map(toDto)
  },

  getCurrent(userId: string): UserDto | null {
    const row = userRepo.get(userId)
    return row ? toDto(row) : null
  },

  register(input: LocalRegisterInput): { user: UserDto } {
    const username = input.username?.trim()
    if (!username) {
      throw new AuthError('username_required', 'Username is required')
    }

    if (userRepo.getByUsername(username)) {
      throw new AuthError('username_taken', 'Username already taken')
    }

    if (input.password) assertPasswordStrong(input.password)

    const id = nanoid()
    const creds = input.password ? hashPassword(input.password) : undefined

    const row = userRepo.insert({
      id,
      type: 'local_user',
      username,
      displayName: input.displayName?.trim() || username,
      passwordHash: creds?.hash,
      salt: creds?.salt
    })

    logger.info('user.created', { userId: id, username, type: 'local_user' })

    return { user: toDto(row) }
  },

  async registerCinna(input: CinnaRegisterInput): Promise<{ user: UserDto }> {
    const serverUrl = input.hostingType === 'cloud' ? CINNA_CLOUD_URL : input.serverUrl
    if (!serverUrl) {
      throw new AuthError(
        'missing_server_url',
        'Server URL is required for self-hosted accounts'
      )
    }

    logger.info('cinna register: starting OAuth', { hostingType: input.hostingType, serverUrl })

    let tokens: Awaited<ReturnType<typeof startCinnaOAuthFlow>>
    try {
      tokens = await startCinnaOAuthFlow(serverUrl)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'OAuth authentication failed'
      logger.error('cinna OAuth failed', {
        serverUrl,
        message,
        stack: err instanceof Error ? err.stack : undefined
      })
      throw new AuthError('oauth_failed', message)
    }

    const username = tokens.profile.email
    const existing = userRepo.getByUsername(username)
    if (existing) {
      if (existing.type !== 'cinna_user') {
        logger.warn('cinna register rejected: name collides with a local account', { username })
        throw new AuthError('username_taken', `Account already exists for ${username}`)
      }
      // Rebind: a previously signed-out Cinna profile is signing back in. Reuse
      // the existing profile row (so its kept device key + synced data line up
      // again) instead of minting a new id and orphaning everything. Refresh
      // identity fields + tokens, then reactivate — activation silently
      // auto-unlocks if the device was kept, or surfaces needs-unlock if it was
      // removed at sign-out.
      //
      // A local password on the row (the device-level profile-switch lock) is
      // intentionally NOT re-checked here: a completed OAuth flow proves control
      // of the Cinna identity (email matches `existing.username`), which is a
      // stronger assertion than the local password. Mirrors `reauthCinna`.
      userRepo.updateCinnaProfile(existing.id, {
        displayName: tokens.profile.displayName,
        cinnaFullName: tokens.profile.fullName,
        cinnaServerUrl: serverUrl,
        cinnaHostingType: input.hostingType ?? 'cloud'
      })
      storeCinnaTokens(existing.id, tokens)
      await userActivation.activate(existing.id)
      logger.info('user.rebound', { userId: existing.id, username, type: 'cinna_user' })
      const reboundRow = userRepo.get(existing.id)
      if (!reboundRow) throw new Error('User disappeared after rebind')
      return { user: toDto(reboundRow) }
    }

    const id = nanoid()
    userRepo.insert({
      id,
      type: 'cinna_user',
      username,
      displayName: tokens.profile.displayName,
      cinnaFullName: tokens.profile.fullName,
      cinnaServerUrl: serverUrl,
      cinnaHostingType: input.hostingType ?? 'cloud'
    })

    // If storing tokens fails, roll back the user row so we don't leave a half-created account.
    try {
      storeCinnaTokens(id, tokens)
    } catch (err) {
      userRepo.deleteWithCascade(id)
      logger.error('cinna token store failed, rolled back user', {
        userId: id,
        username,
        error: err instanceof Error ? err.message : String(err)
      })
      throw err
    }

    await userActivation.activate(id)
    logger.info('user.created', { userId: id, username, type: 'cinna_user' })

    const row = userRepo.get(id)
    if (!row) throw new Error('User disappeared after activation')
    return { user: toDto(row) }
  },

  /**
   * Re-link an existing Cinna user with fresh OAuth tokens without deleting
   * local data. The user row, chats, agents, and settings stay put — we just
   * swap in a new access/refresh pair.
   *
   * Operates on the active profile (passed by the IPC layer) rather than an
   * arbitrary id from the renderer — prevents a confused-deputy scenario
   * where a renderer bug targets a non-active account.
   *
   * Guards against accidental identity swap by requiring the OAuth-returned
   * email to match the user's stored username.
   */
  async reauthCinna(userId: string): Promise<{ user: UserDto }> {
    const row = userRepo.get(userId)
    if (!row) throw new AuthError('not_found', 'User not found')
    if (row.type !== 'cinna_user' || !row.cinnaServerUrl) {
      throw new AuthError('invalid_user_type', 'Not a Cinna account')
    }

    logger.info('cinna reauth: starting OAuth', {
      userId: row.id,
      serverUrl: row.cinnaServerUrl
    })

    let tokens: Awaited<ReturnType<typeof startCinnaOAuthFlow>>
    try {
      tokens = await startCinnaOAuthFlow(row.cinnaServerUrl)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'OAuth authentication failed'
      logger.error('cinna reauth OAuth failed', {
        userId: row.id,
        serverUrl: row.cinnaServerUrl,
        message
      })
      throw new AuthError('oauth_failed', message)
    }

    if (tokens.profile.email !== row.username) {
      logger.warn('cinna reauth rejected: identity mismatch', {
        existing: row.username,
        got: tokens.profile.email
      })
      throw new AuthError(
        'identity_mismatch',
        `Signed in as ${tokens.profile.email}, but this account is ${row.username}. Sign in with the matching account on the Cinna server.`
      )
    }

    storeCinnaTokens(userId, tokens)
    logger.info('cinna reauth: tokens refreshed', { userId: row.id })

    const refreshed = userRepo.get(userId)
    if (!refreshed) throw new Error('User disappeared after reauth')
    return { user: toDto(refreshed) }
  },

  async login(input: LoginInput): Promise<{ user: UserDto }> {
    const row = userRepo.get(input.userId)
    if (!row) {
      throw new AuthError('not_found', 'User not found')
    }

    const requiresPassword =
      !!(row.passwordHash && row.salt) && !userActivation.isUnlocked(row.id)
    if (requiresPassword) {
      if (!input.password) {
        throw new AuthError('password_required', 'Password required')
      }
      if (!verifyPassword(input.password, row.passwordHash!, row.salt!)) {
        throw new AuthError('invalid_password', 'Invalid password')
      }
    }

    if (row.passwordHash && row.salt) {
      userActivation.markUnlocked(row.id)
    }
    await userActivation.activate(row.id)
    logger.info('user.login', { userId: row.id, username: row.username, type: row.type })

    return { user: toDto(row) }
  },

  async logout(): Promise<void> {
    userActivation.clearUnlocks()
    await userActivation.activate(DEFAULT_USER_ID)
    logger.info('user.logout')
  },

  updateUser(input: UpdateUserInput): { user: UserDto } {
    const row = userRepo.get(input.userId)
    if (!row) {
      throw new AuthError('not_found', 'User not found')
    }
    if (input.userId === DEFAULT_USER_ID) {
      throw new AuthError('default_user_immutable', 'Cannot modify default user')
    }

    if (input.displayName !== undefined && input.displayName.trim()) {
      userRepo.updateProfile(input.userId, { displayName: input.displayName.trim() })
    }

    if (input.removePassword) {
      userRepo.clearPassword(input.userId)
      userActivation.forgetUnlock(input.userId)
      logger.info('user.password_removed', { userId: input.userId, username: row.username })
    } else if (input.password) {
      assertPasswordStrong(input.password)
      userRepo.setPassword(input.userId, hashPassword(input.password))
      logger.info('user.password_set', { userId: input.userId, username: row.username })
    }

    const updated = userRepo.get(input.userId)
    if (!updated) throw new Error('User disappeared after update')
    return { user: toDto(updated) }
  },

  async deleteAccount(input: DeleteAccountInput): Promise<void> {
    if (input.userId === DEFAULT_USER_ID) {
      throw new AuthError('default_user_immutable', 'Cannot delete default user')
    }
    const row = userRepo.get(input.userId)
    if (!row) {
      throw new AuthError('not_found', 'User not found')
    }
    if (row.passwordHash && row.salt) {
      if (!input.password) {
        throw new AuthError(
          'password_required',
          'Password required to delete this account'
        )
      }
      if (!verifyPassword(input.password, row.passwordHash, row.salt)) {
        throw new AuthError('invalid_password', 'Invalid password')
      }
    }

    const wasCurrent = getCurrentUserId() === row.id
    const signOut = input.signOut === true

    if (row.type === 'cinna_user') {
      // Sign-out and full delete both **remove every local trace** of the profile
      // (the user row included, so it leaves the account switcher) and revoke
      // THIS device server-side — but they NEVER touch the remote synced records.
      // Every other device keeps its data, and a later sign-in restores from the
      // cloud via recovery key / pairing. `signOutCleanup` flushes a final push
      // first (while the UMK is still in memory) so edits made inside the debounce
      // window aren't lost, then drops the local sync keys/state; it calls only
      // `revokeDevice` (this device's envelope), never the delete-propagating
      // `wipe`/`resetEncryption`. The local profile delete is raw (tombstone-free)
      // so it likewise can't propagate as a peer delete.
      //
      // `removeDevice` is true whenever sync is active: on sign-out the renderer
      // sends it defined iff sync is on; a full delete always removes the device.
      const removeDevice = signOut ? input.removeDevice !== undefined : true
      // Runs regardless of `wasCurrent` so removing a non-active profile from
      // Settings still revokes its device and clears its sync keys.
      await syncService.signOutCleanup(input.userId, { removeDevice })
      if (wasCurrent) {
        await userActivation.deactivate()
      }
      clearCinnaTokens(input.userId)
      userActivation.forgetUnlock(input.userId)
      // `deleteWithCascade` also clears `llmProviders`/`mcpProviders`/`chatModes`
      // by userId — a no-op for Cinna profiles, since those are Default-scope
      // (stored under `__default__`, never under a Cinna userId).
      userRepo.deleteWithCascade(input.userId)
      logger.info(signOut ? 'user.signed_out' : 'user.deleted', {
        userId: input.userId,
        username: row.username,
        type: row.type,
        removeDevice
      })
    } else {
      // Local profiles have no server copy — always a destructive delete.
      if (wasCurrent) {
        await userActivation.deactivate()
      }
      clearCinnaTokens(input.userId)
      userActivation.forgetUnlock(input.userId)
      userRepo.deleteWithCascade(input.userId)
      logger.info('user.deleted', { userId: input.userId, username: row.username, type: row.type })
    }

    if (wasCurrent) {
      await userActivation.activate(DEFAULT_USER_ID)
    }
  },

  async getStartup(lastUserId: string): Promise<StartupResult> {
    const row = userRepo.get(lastUserId)
    if (!row) {
      await userActivation.activate(DEFAULT_USER_ID)
      const defaultUser = userRepo.get(DEFAULT_USER_ID)
      return {
        needsLogin: false,
        user: defaultUser ? toDto(defaultUser) : undefined
      }
    }

    if (!row.passwordHash) {
      await userActivation.activate(row.id)
      return { needsLogin: false, user: toDto(row) }
    }

    return { needsLogin: true, pendingUser: toDto(row) }
  }
}

// Re-export handy for IPC layer.
export { CinnaReauthRequired }
