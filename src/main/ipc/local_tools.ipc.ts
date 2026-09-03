import { userActivation } from '../auth/activation'
import { toolDetectionService } from '../services/localAgents/toolDetectionService'
import { openInService } from '../services/localAgents/openInService'
import { ipcHandle } from './_wrap'
import type { DetectedTool, OpenInRequest } from '../../shared/localTools'

/**
 * Detection of the user's installed developer tools, and the "Open in…"
 * launchers for a local agent folder. Thin controllers — validation of the
 * folder path and of the tool id lives in `openInService`.
 */
export function registerLocalToolsHandlers(): void {
  ipcHandle('local-tools:list', (): Promise<DetectedTool[]> => {
    userActivation.requireActivated()
    return toolDetectionService.list()
  })

  ipcHandle('local-tools:refresh', (): Promise<DetectedTool[]> => {
    userActivation.requireActivated()
    return toolDetectionService.refresh()
  })

  ipcHandle('local-tools:open-in', async (_event, data: OpenInRequest) => {
    userActivation.requireActivated()
    await openInService.openIn(data)
    return { success: true as const }
  })
}
