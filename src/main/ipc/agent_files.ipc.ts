import { BrowserWindow } from 'electron'
import { userActivation } from '../auth/activation'
import { agentFileService, nativeConsentPrompt } from '../host/desktop/agentFiles'
import { agentPinnedFileService } from '../services/agentFiles/agentPinnedFiles'
import { ipcHandle } from './_wrap'
import type {
  AgentFileActionResult,
  AuthorizeAgentFileResult,
  ListPinnedAgentFilesResult,
  ReadAgentFilePreviewResult,
  ReadAgentFileTextResult,
  ResolveAgentFileRefsResult,
  SetPinnedAgentFileResult
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

  ipcHandle('agent-files:read-text', (_event, data: unknown): Promise<ReadAgentFileTextResult> => {
    userActivation.requireActivated()
    return agentFileService.readText(data)
  })

  ipcHandle('agent-files:open', (_event, data: unknown): Promise<AgentFileActionResult> => {
    userActivation.requireActivated()
    return agentFileService.open(data)
  })

  /** An HTML file in the default web browser (not the `.html` default app). */
  ipcHandle('agent-files:open-in-browser', (_event, data: unknown): Promise<AgentFileActionResult> => {
    userActivation.requireActivated()
    return agentFileService.openInBrowser(data)
  })

  // Pins belong to the active profile (the service reads its scope) and to a
  // folder agent main locates itself; the renderer names only the agent and path.
  ipcHandle('agent-files:pins-list', (_event, data: unknown): Promise<ListPinnedAgentFilesResult> => {
    userActivation.requireActivated()
    return agentPinnedFileService.list(data)
  })

  ipcHandle('agent-files:pins-set', (_event, data: unknown): Promise<SetPinnedAgentFileResult> => {
    userActivation.requireActivated()
    return agentPinnedFileService.set(data)
  })

  ipcHandle('agent-files:pins-move', (_event, data: unknown): Promise<AgentFileActionResult> => {
    userActivation.requireActivated()
    return agentPinnedFileService.move(data)
  })

  ipcHandle('agent-files:reveal',(_event, data: unknown): Promise<AgentFileActionResult> => {
    userActivation.requireActivated()
    return agentFileService.reveal(data)
  })
}
