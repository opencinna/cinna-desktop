import { userActivation } from '../auth/activation'
import { getProfileScopeUserId } from '../auth/scope'
import { ipcErrorShape } from '../errors'
import { agentFileService } from '../host/desktop/agentFiles'
import { artifactPreviewServer, htmlPreviewServer } from '../host/desktop/htmlPreview'
import { artifactService } from '../services/artifacts/artifactService'
import type { ArtifactPreviewOpenResult, ArtifactPreviewTextResult } from '../../shared/artifacts'
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

  /**
   * A published artifact's preview: core mints a view capability for the
   * active profile, which main keeps; the renderer gets a token whose
   * `cinna-preview://<token>/` serves the revision's files. Refusals are data.
   */
  ipcHandle('html-preview:open-artifact', async (_event, artifactId: unknown): Promise<ArtifactPreviewOpenResult> => {
    userActivation.requireActivated()
    // Read once: a profile switch during the call must not bind this view to the next profile.
    const profileUserId = getProfileScopeUserId()
    const outcome = await artifactService.view(artifactId, { profileUserId })
    if (!outcome.ok) return outcome
    const { token, baseUrl } = artifactPreviewServer.register(String(artifactId).toLowerCase(), outcome.view, profileUserId)
    const { entry, files, revision } = outcome.view
    return { ok: true, token, baseUrl, entry, files, revision }
  })

  /** One file's text from an open artifact preview, by its token; the capability stays in main. */
  ipcHandle(
    'html-preview:read-artifact-text',
    async (_event, token: unknown, path: unknown): Promise<ArtifactPreviewTextResult> => {
      userActivation.requireActivated()
      return artifactPreviewServer.readText(token, path)
    }
  )

  ipcHandle('html-preview:release', (_event, token: unknown): { success: true } => {
    htmlPreviewServer.release(token)
    artifactPreviewServer.release(token)
    return { success: true }
  })
}
