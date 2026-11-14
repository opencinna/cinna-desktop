import { BrowserWindow } from 'electron'
import { userActivation } from '../auth/activation'
import { agentFileService, nativeConsentPrompt } from '../host/desktop/agentFiles'
import { agentPinnedFileService } from '../services/agentFiles/agentPinnedFiles'
import { ipcHandle } from './_wrap'
import type {
  AgentFileActionResult,
  AuthorizeAgentFileResult,
  DownloadAgentFileResult,
  ListPinnedAgentFilesResult,
  ReadAgentFileImageResult,
  ReadAgentFilePreviewResult,
  ReadAgentFileTextResult,
  ResolveAgentFileRefsResult,
  SetPinnedAgentFileResult
} from '../../shared/agentFiles'

/**
 * Inline file references in an agent's chat (a folder here, or a vault). Thin controllers: gate,
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

  /** An image as a `data:` URL, for a source that previews images (a vault). Kept in memory only. */
  ipcHandle('agent-files:read-image', (_event, data: unknown): Promise<ReadAgentFileImageResult> => {
    userActivation.requireActivated()
    return agentFileService.readImage(data)
  })

  /** Download: a copy saved outside, behind the source's own gate (a vault's prompt, then the save dialog). */
  ipcHandle('agent-files:download', (_event, data: unknown): Promise<DownloadAgentFileResult> => {
    userActivation.requireActivated()
    return agentFileService.download(data)
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
