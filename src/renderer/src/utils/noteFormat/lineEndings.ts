// A textarea's value is newline-normalised: a body with CRLF (or lone CR) line
// endings reads back as LF on the first keystroke, so a note written by
// another client (Cinna Assistant's memory notes, a Windows editor) would have
// every line rewritten, frontmatter included, by an unrelated edit. The editor
// shows `toTextareaValue(body)` and folds each edit back with `keepLineEndings`,
// which changes only the region the user edited.

/** The body as a textarea holds it: every line ending as LF. */
export function toTextareaValue(body: string): string {
  return body.includes('\r') ? body.replace(/\r\n?/g, '\n') : body
}

/**
 * The textarea's new value `next` (LF only) spliced into the stored body
 * `prev`: everything outside the edited region stays byte-for-byte as stored,
 * and newlines typed into it take the body's CRLF when it has any.
 * `toTextareaValue(result) === next` always holds.
 */
export function keepLineEndings(prev: string, next: string): string {
  if (!prev.includes('\r')) return next
  const norm = toTextareaValue(prev)
  if (norm === next) return prev
  // start[k]: where normalised character k begins in `prev` (the `\r` of a CRLF).
  const start: number[] = []
  for (let i = 0; i < prev.length; i++) {
    start.push(i)
    if (prev[i] === '\r' && prev[i + 1] === '\n') i++
  }
  start.push(prev.length)
  const max = Math.min(norm.length, next.length)
  let p = 0
  while (p < max && norm[p] === next[p]) p++
  let s = 0
  while (s < max - p && norm[norm.length - 1 - s] === next[next.length - 1 - s]) s++
  const crlf = prev.includes('\r\n')
  for (;;) {
    const typed = next.slice(p, next.length - s)
    const inserted = crlf ? typed.replace(/\n/g, '\r\n') : typed
    const head = prev.slice(0, start[p])
    const rest = inserted + prev.slice(start[norm.length - s])
    // A kept lone `\r` directly before a `\n` would join it into one CRLF
    // (one line break where the textarea has two): widen the edit by one
    // character so that line break is written out again.
    if (p > 0 && head.endsWith('\r') && rest.startsWith('\n')) {
      p--
      continue
    }
    return head + rest
  }
}
