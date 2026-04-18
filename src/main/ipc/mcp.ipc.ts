import { getCurrentUserId } from '../auth/session'
import { userActivation } from '../auth/activation'
import { mcpService } from '../services/mcpService'
import { ipcErrorShape } from '../errors'
import { ipcHandle } from './_wrap'

export function registerMcpHandlers(): void {
  ipcHandle('mcp:list', async () => {
    userActivation.requireActivated()
    return mcpService.list(getCurrentUserId())
  })

  ipcHandle(
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

  ipcHandle('mcp:delete', async (_event, providerId: string) => {
    userActivation.requireActivated()
    await mcpService.delete(getCurrentUserId(), providerId)
    return { success: true }
  })

  // mcp:connect returns error inline — settings UI surfaces the message
  // beside the provider card rather than as a React Query error.
  ipcHandle('mcp:connect', async (_event, providerId: string) => {
    userActivation.requireActivated()
    try {
      const { tools, status } = await mcpService.connect(getCurrentUserId(), providerId)
      return { success: true as const, tools, status }
    } catch (err) {
      const e = ipcErrorShape(err)
      return { success: false as const, error: e.message }
    }
  })

  ipcHandle('mcp:disconnect', async (_event, providerId: string) => {
    userActivation.requireActivated()
    await mcpService.disconnect(getCurrentUserId(), providerId)
    return { success: true }
  })

  ipcHandle('mcp:list-tools', async (_event, providerId: string) => {
    userActivation.requireActivated()
    return mcpService.listTools(getCurrentUserId(), providerId)
  })
}
