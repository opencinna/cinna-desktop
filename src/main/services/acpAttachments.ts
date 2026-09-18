import type { ContentBlock } from '@agentclientprotocol/sdk'
import type { RunInput } from '../agents/drivers/driver'
import type { AcpConnection } from '../agents/drivers/acp/types'
import { attachmentToMediaPart } from './fileStore'

/** Translate owned attachments using the engine's negotiated prompt capabilities. */
export async function buildAcpPrompt(userId: string, input: Pick<RunInput, 'wireContent' | 'attachments' | 'runScope'>, connection: AcpConnection): Promise<ContentBlock[]> {
  const prompt: ContentBlock[] = [{ type: 'text', text: input.wireContent }]
  const capabilities = connection.initialized.agentCapabilities?.promptCapabilities
  for (const attachment of input.attachments ?? []) {
    const native = attachment.mimeType.startsWith('image/') ? !!capabilities?.image : !!capabilities?.embeddedContext
    const media = await attachmentToMediaPart(attachment, {
      userId: input.runScope?.profileUserId ?? userId,
      acceptedMimeTypes: [attachment.mimeType], nativeMimeTypes: native ? [attachment.mimeType] : [], maxFileSizeBytes: 20 * 1024 * 1024
    })
    if (!media) {
      prompt.push({ type: 'text', text: `[Attachment ${attachment.filename} could not be read by this runtime.]` })
    } else if (media.kind === 'image') {
      prompt.push({ type: 'image', data: media.bytes.toString('base64'), mimeType: media.mimeType })
    } else if (media.kind === 'document') {
      prompt.push({ type: 'resource', resource: { uri: `attachment:${encodeURIComponent(attachment.id)}`, mimeType: media.mimeType, blob: media.bytes.toString('base64') } })
    } else {
      prompt.push({ type: 'text', text: `[Attachment: ${attachment.filename}]\n${media.text}` })
    }
  }
  return prompt
}
