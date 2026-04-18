import { ipcMain } from 'electron'
import { getCurrentUserId } from '../auth/session'
import { userActivation } from '../auth/activation'
import { mcpService } from '../services/mcpService'
import { ipcErrorShape } from '../errors'

export function registerMcpHandlers(): void {
  ipcMain.handle('mcp:list', async () => {
    userActivation.requireActivated()
    return mcpService.list(getCurrentUserId())
  })

  ipcMain.handle(
    'mcp:upsert',
    async (
      _event,
      data: {
        id?: string
        name: string
        transportType: string
        command?: string
        args?: string[]
        url?: string
        env?: Record<string, string>
        enabled?: boolean
      }
    ) => {
      userActivation.requireActivated()
      const { id } = await mcpService.upsert(getCurrentUserId(), data)
      return { id, success: true }
    }
  )

  ipcMain.handle('mcp:delete', async (_event, providerId: string) => {
    userActivation.requireActivated()
    await mcpService.delete(getCurrentUserId(), providerId)
    return { success: true }
  })

  ipcMain.handle('mcp:connect', async (_event, providerId: string) => {
    userActivation.requireActivated()
    try {
      const { tools, status } = await mcpService.connect(getCurrentUserId(), providerId)
      return { success: true as const, tools, status }
    } catch (err) {
      const e = ipcErrorShape(err)
      return { success: false as const, error: e.message }
    }
  })

  ipcMain.handle('mcp:disconnect', async (_event, providerId: string) => {
    userActivation.requireActivated()
    await mcpService.disconnect(getCurrentUserId(), providerId)
    return { success: true }
  })

  ipcMain.handle('mcp:list-tools', async (_event, providerId: string) => {
    userActivation.requireActivated()
    return mcpService.listTools(getCurrentUserId(), providerId)
  })
}
