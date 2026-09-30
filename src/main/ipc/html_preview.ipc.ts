import { userActivation } from '../auth/activation'
import { ipcErrorShape } from '../errors'
import { agentFileService } from '../host/desktop/agentFiles'
import { htmlPreviewServer } from '../host/desktop/htmlPreview'
import { assertFileScope } from '../services/fileService'
import { previewKindFor } from '../../shared/filePreview'
import type { HtmlPreviewOpenResult } from '../../shared/htmlPreview'
import { ipcHandle } from './_wrap'

/**
 * The HTML preview frame. Thin controllers: `open` checks the file as the
 * text preview's channels do — activation, the profile, the file scope, and
 * for an agent file the agent-file gate (containment or an approval already
 * given; this never asks) — then issues a token; `release` forgets it.
 * Failures are returned as data.
 */
export function registerHtmlPreviewHandlers(): void {
  ipcHandle('html-preview:open', async (_event, data: unknown): Promise<HtmlPreviewOpenResult> => {
    userActivation.requireActivated()
    if (!data || typeof data !== 'object') return { success: false, error: 'Nothing to preview.', code: 'invalid_input' }
    const input = data as Record<string, unknown>
    if (input.type === 'agentFile') {
      const { agentId, path } = input
      const access = await agentFileService.htmlDocumentAccess({ agentId, path })
      if (!access.success) return access
      const { token, url } = htmlPreviewServer.register({
        type: 'agentFile',
        agentId: agentId as string,
        path: path as string
      })
      return { success: true, token, url }
    }
    if (input.type === 'attachment') {
      const { fileId, filename, mimeType } = input
      const source = input.source ?? 'cinna'
      try {
        assertFileScope(source)
      } catch (err) {
        const e = ipcErrorShape(err)
        return { success: false, error: e.message, code: e.code }
      }
      if (
        typeof fileId !== 'string' ||
        fileId === '' ||
        typeof filename !== 'string' ||
        previewKindFor(filename, typeof mimeType === 'string' ? mimeType : undefined) !== 'html'
      ) {
        return { success: false, error: 'Nothing to preview.', code: 'invalid_input' }
      }
      const { token, url } = htmlPreviewServer.register({ type: 'attachment', attachmentId: fileId, source, filename })
      return { success: true, token, url }
    }
    return { success: false, error: 'Nothing to preview.', code: 'invalid_input' }
  })

  ipcHandle('html-preview:release', (_event, token: unknown): { success: true } => {
    htmlPreviewServer.release(token)
    return { success: true }
  })
}
