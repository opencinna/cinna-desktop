/**
 * What a paste into a composer that takes files does, from the clipboard's types alone —
 * decided inside the paste event, so a text paste stays the native one (undo,
 * selection, input handling unchanged).
 *
 * - No `Files`: text.
 * - `Files` and no `text/plain`: files — a screenshot, an image copied in a
 *   browser, file references without a name.
 * - Both: an Excel or Word copy (the text plus a picture of it) and a Finder
 *   copy (the file plus its name) look alike here, so main is asked whether the
 *   clipboard references files. Text wins over a picture of itself; file
 *   references always attach.
 */
export type PasteIntent = 'files' | 'text'

export function pasteIntent(types: readonly string[], hasFileRefs: () => boolean): PasteIntent {
  if (!types.includes('Files')) return 'text'
  if (!types.includes('text/plain')) return 'files'
  return hasFileRefs() ? 'files' : 'text'
}

/** Why a paste of files attached nothing, in a chat that takes no files. */
export const PASTE_NOT_ACCEPTED = "Files can't be attached in this chat."
/** …and on the new-chat screen, where no destination exists yet (no AI provider, no Cinna account). */
export const PASTE_NEEDS_DESTINATION = 'Add an AI provider or sign in to attach files.'

/** …and while a reply is running (the [+] menu's Attach files is disabled then too). */
export const PASTE_WHILE_STREAMING = 'Files can be attached once the reply finishes.'
/** The clipboard said files, but main found none it could attach. */
export const PASTE_NOTHING_USABLE = 'Nothing on the clipboard could be attached.'
