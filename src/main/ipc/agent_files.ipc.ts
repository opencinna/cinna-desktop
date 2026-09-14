import { BrowserWindow } from 'electron'
import { userActivation } from '../auth/activation'
import { agentFileService, nativeConsentPrompt } from '../services/agentFiles'
import { ipcHandle } from './_wrap'
import type {
  AgentFileActionResult,
  AuthorizeAgentFileResult,
  ReadAgentFilePreviewResult,
  ResolveAgentFileRefsResult
} from '../../shared/agentFiles'

/**
 * Inline file references in a folder agent's chat. Thin controllers: gate,
 * delegate. Every payload is untrusted — the service re-validates the shape,
 * locates the agent folder itself, and re-checks containment or consent on
 * every read, open and reveal. Results carry failure codes as data.
 */
export function registerAgentFileHandlers(): void {
  ipcHandle('agent-files:resolve', (_event, data: unknown): Promise<ResolveAgentFileRefsResult> => {
    userActivation.requireActivated()
    return agentFileService.resolve(data)
  })

  /** Ask the user — natively, from main — before a path outside the folder is used. */
  ipcHandle('agent-files:authorize', (event, data: unknown): Promise<AuthorizeAgentFileResult> => {
    userActivation.requireActivated()
    return agentFileService.authorize(data, nativeConsentPrompt(BrowserWindow.fromWebContents(event.sender)))
  })

  ipcHandle('agent-files:read-preview', (_event, data: unknown): Promise<ReadAgentFilePreviewResult> => {
    userActivation.requireActivated()
    return agentFileService.readPreview(data)
  })

  ipcHandle('agent-files:open', (_event, data: unknown): Promise<AgentFileActionResult> => {
    userActivation.requireActivated()
    return agentFileService.open(data)
  })

  ipcHandle('agent-files:reveal', (_event, data: unknown): Promise<AgentFileActionResult> => {
    userActivation.requireActivated()
    return agentFileService.reveal(data)
  })
}
