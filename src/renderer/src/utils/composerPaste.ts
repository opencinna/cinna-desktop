/**
 * What a paste into a composer that takes files does, from the clipboard's
 * types alone — decided inside the paste event, so a text paste stays the
 * native one (undo, selection, input handling unchanged).
 *
 * - No `Files`: text.
 * - `Files` and no `text/plain`: files — a screenshot, an image copied in a
 *   browser, file references without a name.
 * - Both: `ask`. An Excel or Word copy (the text plus a picture of it) and a
 *   Finder copy (the file plus its name) look alike here, so main is asked
 *   whether the clipboard references files. Electron reads the clipboard
 *   asynchronously, so the composer holds the event's own text and awaits the
 *   answer: text wins over a picture of itself; file references always attach.
 */
export type PasteIntent = 'files' | 'text' | 'ask'

export function pasteIntent(types: readonly string[]): PasteIntent {
  if (!types.includes('Files')) return 'text'
  if (!types.includes('text/plain')) return 'files'
  return 'ask'
}

/**
 * Put `text` into the textarea at its caret (over its selection) as a typed
 * paste would: through `insertText`, so the textarea's own undo takes it back
 * and React's `onChange` fires. For a paste the composer had to hold while it
 * asked main, after the event's native paste was prevented. Where `insertText`
 * is unavailable (jsdom), the value is spliced and an `input` event dispatched,
 * which React still reads as a change. Returns whether it inserted: when the
 * textarea lost focus while main was asked, the user has moved on, and the
 * paste is dropped rather than focus taken back.
 */
export function insertPastedText(el: HTMLTextAreaElement, text: string): boolean {
  if (document.activeElement !== el) return false
  let inserted = false
  try {
    inserted = typeof document.execCommand === 'function' && document.execCommand('insertText', false, text)
  } catch {
    inserted = false
  }
  if (inserted) return true
  el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end')
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}

/** Why a paste of files attached nothing, in a chat that takes no files. */
export const PASTE_NOT_ACCEPTED = "Files can't be attached in this chat."
/** …and on the new-chat screen, where no destination exists yet (no AI provider, no Cinna account). */
export const PASTE_NEEDS_DESTINATION = 'Add an AI provider or sign in to attach files.'

/** …and on the new-chat screen while its first reply starts (the [+] menu's Attach files is disabled then too). */
export const PASTE_WHILE_STREAMING = 'Files can be attached once the reply finishes.'
/** The clipboard said files, but main found none it could attach. */
export const PASTE_NOTHING_USABLE = 'Nothing on the clipboard could be attached.'
/** A long text paste over `PASTE_MAX_CHARS` (shared/pastedText): refused rather than chipped. */
export const PASTE_TOO_LONG = 'This paste is too long to send as text — attach it as a file instead.'
