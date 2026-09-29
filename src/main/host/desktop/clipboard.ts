import { clipboard } from 'electron'

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
