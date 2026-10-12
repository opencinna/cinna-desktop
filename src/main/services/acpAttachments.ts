import { randomUUID } from 'crypto'
import { constants } from 'fs'
import { copyFile, link, mkdir, readFile, stat, unlink, writeFile } from 'fs/promises'
import { extname, join } from 'path'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import type { RunInput } from '../agents/drivers/driver'
import type { AcpConnection } from '../agents/drivers/acp/types'
import type { MessageAttachment } from '../../shared/attachments'
import { attachmentToMediaPart, resolveFileStore } from './fileStore'
import { createLogger } from '../logger/logger'

const logger = createLogger('acp-attachments')

/** Inlining cap for the text path: past it a file is named, not sent. */
const MAX_INLINE_BYTES = 20 * 1024 * 1024

/**
 * Hand owned attachments to a local ACP engine.
 *
 * With an `uploadsDir`, the way cinna-core hands them to its agents: each file
 * is copied there and the prompt opens with an `Uploaded files:` list of their
 * paths, which the engine reads with its own tools. Images also go as native
 * image blocks when the engine negotiated `image`.
 *
 * Without one — a remote engine, or a chat runtime with no file tools — the
 * content goes in the prompt: images natively, anything else as extracted text.
 *
 * Never an embedded resource: both adapters advertise `embeddedContext`, but
 * the Claude adapter drops a `blob` resource and the Codex adapter pastes its
 * base64 into the prompt, so neither model ever saw a PDF that way.
 */
export async function buildAcpPrompt(userId: string, input: Pick<RunInput, 'wireContent' | 'attachments' | 'runScope'>, connection: AcpConnection, uploadsDir: string | null): Promise<ContentBlock[]> {
  const attachments = input.attachments ?? []
  if (!attachments.length) return [{ type: 'text', text: input.wireContent }]
  const nativeImages = !!connection.initialized.agentCapabilities?.promptCapabilities?.image
  const owner = input.runScope?.profileUserId ?? userId
  return uploadsDir ? uploadedPrompt(owner, input.wireContent, attachments, nativeImages, uploadsDir) : inlinePrompt(owner, input.wireContent, attachments, nativeImages)
}

async function uploadedPrompt(userId: string, wireContent: string, attachments: MessageAttachment[], nativeImages: boolean, uploadsDir: string): Promise<ContentBlock[]> {
  const listed: string[] = []
  const images: ContentBlock[] = []
  for (const attachment of attachments) {
    const file = await readAttachment(userId, attachment)
    const path = file && await placeUpload(uploadsDir, attachment.filename, file.bytes)
    if (!file || !path) {
      listed.push(`- ${attachment.filename} (could not be read by this runtime)`)
      continue
    }
    listed.push(`- ${path}`)
    if (nativeImages && file.mimeType.startsWith('image/') && file.bytes.length <= MAX_INLINE_BYTES) images.push({ type: 'image', data: file.bytes.toString('base64'), mimeType: file.mimeType })
  }
  return [{ type: 'text', text: `Uploaded files:\n${listed.join('\n')}\n---\n\n${wireContent}` }, ...images]
}

async function inlinePrompt(userId: string, wireContent: string, attachments: MessageAttachment[], nativeImages: boolean): Promise<ContentBlock[]> {
  const prompt: ContentBlock[] = [{ type: 'text', text: wireContent }]
  for (const attachment of attachments) {
    const native = nativeImages && attachment.mimeType.startsWith('image/')
    const media = await attachmentToMediaPart(attachment, {
      userId, acceptedMimeTypes: [attachment.mimeType], nativeMimeTypes: native ? [attachment.mimeType] : [], maxFileSizeBytes: MAX_INLINE_BYTES
    })
    if (media?.kind === 'image') prompt.push({ type: 'text', text: `[Attachment: ${attachment.filename}]` }, { type: 'image', data: media.bytes.toString('base64'), mimeType: media.mimeType })
    else if (media?.kind === 'text') prompt.push({ type: 'text', text: `[Attachment: ${attachment.filename}]\n${media.text}` })
    else prompt.push({ type: 'text', text: `[Attachment ${attachment.filename} could not be read by this runtime.]` })
  }
  return prompt
}

async function readAttachment(userId: string, attachment: MessageAttachment): Promise<{ bytes: Buffer; mimeType: string } | null> {
  try {
    return await resolveFileStore(attachment).read({ userId, attachment })
  } catch (err) {
    logger.warn('attachment unreadable', { id: attachment.id, source: attachment.source ?? 'cinna', error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/**
 * cinna-core's `sanitize_filename`, less its ASCII folding so a Cyrillic or CJK
 * name survives: no separators, reserved or control characters, spaces to
 * underscores, no leading dot.
 */
export function uploadName(filename: string): string {
  const ext = extname(filename)
  const clean = (value: string): string => value.normalize('NFC').replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '')
    .replace(/\s/g, '_').replace(/_+/g, '_')
  const stem = [...clean(filename.slice(0, filename.length - ext.length)).replace(/^[._]+/, '')].slice(0, 120).join('') || 'file'
  return `${stem}${[...clean(ext)].slice(0, 20).join('')}`
}

/**
 * Copy `bytes` to `<dir>/<name>` and return the absolute path.
 * A file already there with the same bytes is reused, so a resent or replayed
 * attachment keeps its path; a different one gets `_1`, `_2`… as on cinna-core.
 * The copy is linked into place, so two turns never see each other's half-written file.
 */
async function placeUpload(dir: string, filename: string, bytes: Buffer): Promise<string | null> {
  const name = uploadName(filename)
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  const temp = join(dir, `.${randomUUID()}.partial`)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(temp, bytes)
    for (let attempt = 0; attempt <= 100; attempt++) {
      const target = join(dir, attempt ? `${stem}_${attempt}${ext}` : name)
      try {
        await link(temp, target).catch((err: NodeJS.ErrnoException) => {
          // A volume without hard links (exFAT, some shares): an exclusive copy, which can tear but never overwrites.
          if (err.code === 'EPERM' || err.code === 'ENOTSUP' || err.code === 'ENOSYS') return copyFile(temp, target, constants.COPYFILE_EXCL)
          throw err
        })
        return target
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        const existing = (await stat(target).catch(() => null))?.size === bytes.length ? await readFile(target).catch(() => null) : null
        if (existing?.equals(bytes)) return target
      }
    }
    throw new Error('too many files with this name')
  } catch (err) {
    logger.warn('could not place an attachment for the engine', { dir, filename, error: err instanceof Error ? err.message : String(err) })
    return null
  } finally {
    await unlink(temp).catch(() => undefined)
  }
}
