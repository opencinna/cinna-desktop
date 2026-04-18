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
import { AuthError } from '../errors'
import { createLogger } from '../logger/logger'

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
    if (userRepo.getByUsername(username)) {
      logger.warn('cinna register rejected: account already exists', { username })
      throw new AuthError('username_taken', `Account already exists for ${username}`)
    }

    const id = nanoid()
    userRepo.insert({
      id,
      type: 'cinna_user',
      username,
      displayName: tokens.profile.displayName,
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
    await userActivation.activate('__default__')
    logger.info('user.logout')
  },

  updateUser(input: UpdateUserInput): { user: UserDto } {
    const row = userRepo.get(input.userId)
    if (!row) {
      throw new AuthError('not_found', 'User not found')
    }
    if (input.userId === '__default__') {
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
    if (input.userId === '__default__') {
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

    if (wasCurrent) {
      await userActivation.deactivate()
    }

    clearCinnaTokens(input.userId)
    userActivation.forgetUnlock(input.userId)
    userRepo.deleteWithCascade(input.userId)

    logger.info('user.deleted', { userId: input.userId, username: row.username, type: row.type })

    if (wasCurrent) {
      await userActivation.activate('__default__')
    }
  },

  async getStartup(lastUserId: string): Promise<StartupResult> {
    const row = userRepo.get(lastUserId)
    if (!row) {
      await userActivation.activate('__default__')
      const defaultUser = userRepo.get('__default__')
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
