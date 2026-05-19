import { userActivation } from '../auth/activation'
import { getSettingsScopeUserId } from '../auth/scope'
import { mcpService } from '../services/mcpService'
import { mcpRegistryService } from '../services/mcpRegistryService'
import { ipcErrorShape } from '../errors'
import { ipcHandle } from './_wrap'

export function registerMcpHandlers(): void {
  ipcHandle('mcp:list', async () => {
    userActivation.requireActivated()
    return mcpService.list(getSettingsScopeUserId())
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
      const { id } = await mcpService.upsert(getSettingsScopeUserId(), data)
      return { id, success: true }
    }
  )

  ipcHandle('mcp:delete', async (_event, providerId: string) => {
    userActivation.requireActivated()
    await mcpService.delete(getSettingsScopeUserId(), providerId)
    return { success: true }
  })

  // mcp:connect returns error inline — settings UI surfaces the message
  // beside the provider card rather than as a React Query error.
  ipcHandle('mcp:connect', async (_event, providerId: string) => {
    userActivation.requireActivated()
    try {
      const { tools, status } = await mcpService.connect(getSettingsScopeUserId(), providerId)
      return { success: true as const, tools, status }
    } catch (err) {
      const e = ipcErrorShape(err)
      return { success: false as const, error: e.message }
    }
  })

  ipcHandle('mcp:disconnect', async (_event, providerId: string) => {
    userActivation.requireActivated()
    await mcpService.disconnect(getSettingsScopeUserId(), providerId)
    return { success: true }
  })

  ipcHandle('mcp:list-tools', async (_event, providerId: string) => {
    userActivation.requireActivated()
    return mcpService.listTools(getSettingsScopeUserId(), providerId)
  })

  ipcHandle('mcp:registry-list', async () => {
    userActivation.requireActivated()
    return mcpRegistryService.list()
  })

  // Aggregated search across every built-in registry — used by the unified
  // picker UI. Always returns success: per-registry failures are reported in
  // the `errors` array alongside the merged entries. The try/catch is a
  // defensive backstop — `searchAll` is meant to be throwless (it uses
  // `Promise.allSettled` internally), so anything bubbling up here is a
  // programmer error we still want the picker to recover from gracefully.
  ipcHandle(
    'mcp:registry-search-all',
    async (_event, data: { query?: string; limit?: number }) => {
      userActivation.requireActivated()
      try {
        return await mcpRegistryService.searchAll(data.query ?? '', data.limit)
      } catch (err) {
        const e = ipcErrorShape(err)
        return {
          entries: [],
          errors: [{ registryId: '*', code: e.code, error: e.message }]
        }
      }
    }
  )
}
