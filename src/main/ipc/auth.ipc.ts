import { ipcMain } from 'electron'
import { getCurrentUserId, getLastUserId } from '../auth/session'
import { abortCinnaOAuthFlow } from '../auth/cinna-oauth'
import { authService, UserDto } from '../services/authService'
import { ipcErrorShape } from '../errors'

function errorResponse(err: unknown): { success: false; error: string } {
  return { success: false, error: ipcErrorShape(err).message }
}

export function registerAuthHandlers(): void {
  ipcMain.handle('auth:list-users', async () => authService.listUsers())

  ipcMain.handle(
    'auth:get-current',
    async (): Promise<UserDto | null> => authService.getCurrent(getCurrentUserId())
  )

  ipcMain.handle('auth:get-startup', async () => authService.getStartup(getLastUserId()))

  ipcMain.handle(
    'auth:register',
    async (
      _event,
      data: {
        username?: string
        displayName?: string
        password?: string
        accountType: 'local' | 'cinna'
        cinnaHostingType?: 'cloud' | 'self_hosted'
        cinnaServerUrl?: string
      }
    ) => {
      try {
        if (data.accountType === 'cinna') {
          const { user } = await authService.registerCinna({
            hostingType: data.cinnaHostingType ?? 'cloud',
            serverUrl: data.cinnaServerUrl
          })
          return { success: true as const, user }
        }
        const { user } = authService.register({
          username: data.username ?? '',
          displayName: data.displayName,
          password: data.password
        })
        return { success: true as const, user }
      } catch (err) {
        return errorResponse(err)
      }
    }
  )

  ipcMain.handle(
    'auth:login',
    async (_event, data: { userId: string; password?: string }) => {
      try {
        const { user } = await authService.login(data)
        return { success: true as const, user }
      } catch (err) {
        return errorResponse(err)
      }
    }
  )

  ipcMain.handle('auth:logout', async () => {
    await authService.logout()
    return { success: true as const }
  })

  ipcMain.handle('auth:cinna-oauth-abort', async () => {
    abortCinnaOAuthFlow()
    return { success: true as const }
  })

  ipcMain.handle(
    'auth:update-user',
    async (
      _event,
      data: {
        userId: string
        displayName?: string
        password?: string
        removePassword?: boolean
      }
    ) => {
      try {
        const { user } = authService.updateUser(data)
        return { success: true as const, user }
      } catch (err) {
        return errorResponse(err)
      }
    }
  )

  ipcMain.handle(
    'auth:delete-user',
    async (_event, data: { userId: string; password?: string }) => {
      try {
        await authService.deleteAccount(data)
        return { success: true as const }
      } catch (err) {
        return errorResponse(err)
      }
    }
  )
}
