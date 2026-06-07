/**
 * `<cinna_attach>` tag handling shared between the A2A accumulator (main) and
 * the renderer.
 *
 * An agent declares a file attachment with a `<cinna_attach>/path</cinna_attach>`
 * tag embedded in its reply text. The Cinna backend strips the tag from its own
 * stored copy at finalize and delivers the file as a separate A2A `FilePart`,
 * but it streams the *raw* assistant tokens (tag included) over the wire — and
 * the desktop accumulates that live stream into its own persisted message. So
 * the desktop must strip the tag itself; otherwise the literal
 * `<cinna_attach>…</cinna_attach>` shows up in the assistant bubble.
 *
 * Pure, dependency-free — imported from both Electron processes.
 */

/** Complete `<cinna_attach>…</cinna_attach>` tag (non-greedy, multiline body). */
const COMPLETE_TAG_RE = /<cinna_attach>[\s\S]*?<\/cinna_attach>/g

const OPEN_TAG = '<cinna_attach>'

/**
 * Remove `<cinna_attach>` tags from agent reply text.
 *
 * - Always strips complete `<cinna_attach>…</cinna_attach>` tags.
 * - With `streaming: true`, also hides a tag that has opened but not yet closed
 *   (the body is still arriving) and a trailing partial prefix of the opening
 *   tag (e.g. `…<cinna_at`), so no fragment flashes mid-stream. These extra
 *   passes are streaming-only — on a finalized string a trailing `<c` is real
 *   text, not an incomplete tag.
 */
export function stripCinnaAttachTags(text: string, opts?: { streaming?: boolean }): string {
  let out = text.replace(COMPLETE_TAG_RE, '')
  if (!opts?.streaming) return out

  // Opened-but-not-closed tag — hide everything from the open tag onward.
  const openIdx = out.indexOf(OPEN_TAG)
  if (openIdx !== -1) return out.slice(0, openIdx)

  // Trailing partial prefix of the opening tag (`<`, `<c`, …, `<cinna_attach`).
  const maxPartial = Math.min(OPEN_TAG.length - 1, out.length)
  for (let i = maxPartial; i > 0; i--) {
    if (out.endsWith(OPEN_TAG.slice(0, i))) {
      out = out.slice(0, out.length - i)
      break
    }
  }
  return out
}
