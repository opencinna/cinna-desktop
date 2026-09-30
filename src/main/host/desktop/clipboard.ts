import { clipboard } from 'electron'
import { clearPastedFiles, clipboardFilePaths, type ClipboardFileSources } from '../../services/pastedFiles'
import { runtimeHost } from '../runtimeHost'
import { createLogger } from '../../logger/logger'

const logger = createLogger('clipboard')

/**
 * The most text the renderer may put on the clipboard in one call — above the
 * 4 MB whole-file read (a UTF-8 file decodes to at most as many characters as
 * it has bytes), well short of anything that could stall main.
 */
export const MAX_CLIPBOARD_TEXT_LENGTH = 8 * 1024 * 1024

/**
 * Write plain text to the system clipboard from main. The renderer's
 * `navigator.clipboard` needs a focused document, which a native dialog (the
 * file consent prompt) takes away; Electron's clipboard does not.
 */
export function writeClipboardText(
  text: unknown,
  write: (text: string) => void = (value) => clipboard.writeText(value)
): { success: boolean } {
  if (typeof text !== 'string' || text.length > MAX_CLIPBOARD_TEXT_LENGTH) return { success: false }
  try {
    write(text)
    return { success: true }
  } catch {
    return { success: false }
  }
}

/**
 * The file-reference formats on the system clipboard, raw, for
 * `services/pastedFiles.ts` to parse: macOS `public.file-url` and
 * `NSFilenamesPboardType`, Linux `text/uri-list`, Windows `FileNameW` (one
 * file only — a best effort). A read that throws counts as absent.
 */
export function readClipboardFileSources(
  platform: NodeJS.Platform = process.platform,
  cb: Pick<Electron.Clipboard, 'read' | 'readBuffer'> = clipboard
): ClipboardFileSources {
  const read = (format: string): string | undefined => {
    try {
      return cb.read(format) || undefined
    } catch {
      return undefined
    }
  }
  if (platform === 'darwin') {
    return { fileUrl: read('public.file-url'), filenamesPlist: read('NSFilenamesPboardType') }
  }
  if (platform === 'win32') {
    try {
      const fileNameW = cb.readBuffer('FileNameW')
      return fileNameW.length > 0 ? { fileNameW } : {}
    } catch {
      return {}
    }
  }
  return { uriList: read('text/uri-list') }
}

/** The clipboard's image as PNG bytes, or null when it holds none. */
export function readClipboardImagePng(cb: Pick<Electron.Clipboard, 'readImage'> = clipboard): Buffer | null {
  try {
    const image = cb.readImage()
    return image.isEmpty() ? null : image.toPNG()
  } catch {
    return null
  }
}

/** Whether the clipboard references files — the composer's paste asks before it lets text in. */
export function clipboardHasFileRefs(): boolean {
  return clipboardFilePaths(readClipboardFileSources()).length > 0
}

/** Remove last session's pasted images. From `startup()`, not awaited; a failure is logged. */
export function clearPastedFilesAtStart(): void {
  void clearPastedFiles(runtimeHost.getPath('userData')).catch((err) => {
    logger.warn('could not clear the pasted images', { error: err instanceof Error ? err.name : 'unknown' })
  })
}
