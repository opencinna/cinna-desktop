import { clipboard, nativeImage } from 'electron'
import { clearPastedFiles, clipboardFilePaths } from '../../services/pastedFiles'
import { runtimeHost } from '../runtimeHost'
import { createLogger } from '../../logger/logger'
import { MAX_AGENT_FILE_COPY_BYTES } from '../../../shared/agentFiles'

const logger = createLogger('clipboard')

/**
 * The most text the renderer may put on the clipboard in one call — exactly
 * the **Copy contents** read cap (a UTF-8 file decodes to at most as many
 * characters as it has bytes), well short of anything that could stall main.
 */
export const MAX_CLIPBOARD_TEXT_LENGTH = MAX_AGENT_FILE_COPY_BYTES

/**
 * Write plain text to the system clipboard from main. The renderer's
 * `navigator.clipboard` needs a focused document, which a native dialog (the
 * file consent prompt) takes away; Electron's clipboard does not. Electron 44+
 * writes asynchronously; a rejected write is reported as data, like a refusal.
 */
export async function writeClipboardText(
  text: unknown,
  write: (text: string) => Promise<void> = (value) => clipboard.writeText(value)
): Promise<{ success: boolean }> {
  if (typeof text !== 'string' || text.length > MAX_CLIPBOARD_TEXT_LENGTH) return { success: false }
  try {
    await write(text)
    return { success: true }
  } catch {
    return { success: false }
  }
}

/** The part of Electron's (44+, W3C-shaped) clipboard a paste reads. */
export type ClipboardReader = Pick<Electron.Clipboard, 'read'>

/** The payload of the first clipboard item carrying `type`, or null. A read that throws counts as absent. */
async function readClipboardType(cb: ClipboardReader, type: string): Promise<Blob | null> {
  try {
    const item = (await cb.read()).find((entry) => entry.types.includes(type))
    if (!item) return null
    const payload: unknown = await item.getType(type)
    // A Blob for every MIME type but the bookmark one; duck-typed, since the
    // Blob Electron hands back need not be this realm's class.
    return payload && typeof (payload as Blob).arrayBuffer === 'function' ? (payload as Blob) : null
  } catch {
    return null
  }
}

/**
 * The clipboard's file references as a `text/uri-list` (`file://` URLs), for
 * `services/pastedFiles.ts` to parse. Electron maps each platform's native
 * file-reference format to this one type, so a Finder copy, a Linux file
 * manager copy and an Explorer copy all read the same.
 */
export async function readClipboardUriList(cb: ClipboardReader = clipboard): Promise<string | undefined> {
  const payload = await readClipboardType(cb, 'text/uri-list')
  if (!payload) return undefined
  try {
    return (await payload.text()) || undefined
  } catch {
    return undefined
  }
}

/** Turns an image of another type into PNG bytes; empty when it cannot be decoded. */
export type ImageToPng = (bytes: Buffer) => Buffer

const nativeImageToPng: ImageToPng = (bytes) => nativeImage.createFromBuffer(bytes).toPNG()

/**
 * The clipboard's image as PNG bytes, or null when it holds none. `image/png`
 * first; failing that, the first other `image/*` type converted through
 * `nativeImage` (JPEG, say, from a Linux app that offers only that). Probed on
 * Electron 45 macOS: a TIFF-only pasteboard (Preview's Copy) already reads as
 * `image/png`, and `nativeImage` cannot decode TIFF, so a TIFF reaching the
 * fallback yields nothing rather than an error.
 */
export async function readClipboardImagePng(
  cb: ClipboardReader = clipboard,
  toPng: ImageToPng = nativeImageToPng
): Promise<Buffer | null> {
  const bytesOf = async (payload: Blob | null): Promise<Buffer | null> => {
    if (!payload) return null
    try {
      const bytes = Buffer.from(await payload.arrayBuffer())
      return bytes.length > 0 ? bytes : null
    } catch {
      return null
    }
  }
  const png = await bytesOf(await readClipboardType(cb, 'image/png'))
  if (png) return png
  let other: string | undefined
  try {
    other = (await cb.read()).flatMap((entry) => entry.types).find((type) => type.startsWith('image/'))
  } catch {
    return null
  }
  if (!other) return null
  const bytes = await bytesOf(await readClipboardType(cb, other))
  if (!bytes) return null
  try {
    const converted = toPng(bytes)
    return converted.length > 0 ? converted : null
  } catch {
    return null
  }
}

/** Whether the clipboard references files — the composer asks when a paste carries both files and text. */
export async function clipboardHasFileRefs(cb: ClipboardReader = clipboard): Promise<boolean> {
  return clipboardFilePaths(await readClipboardUriList(cb)).length > 0
}

/** Remove last session's pasted images. From `startup()`, not awaited; a failure is logged. */
export function clearPastedFilesAtStart(): void {
  void clearPastedFiles(runtimeHost.getPath('userData')).catch((err) => {
    logger.warn('could not clear the pasted images', { error: err instanceof Error ? err.name : 'unknown' })
  })
}
