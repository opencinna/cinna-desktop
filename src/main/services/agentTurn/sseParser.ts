/**
 * A minimal, incremental Server-Sent Events parser for the engine's
 * `GET /api/event` body.
 *
 * Written rather than pulled in because the two things it has to get right are
 * both things a naive `split('data: ')` gets wrong, and both were observed on
 * the real binary:
 *
 * - The body interleaves `data: {json}` lines with `: heartbeat` **comment**
 *   lines. Per the SSE spec a line beginning with `:` is a comment and must be
 *   ignored; splitting on `data: ` would silently glue a heartbeat onto the
 *   previous payload.
 * - Chunk boundaries fall wherever the socket decides. A single JSON object
 *   routinely arrives split across two `read()` results, so the parser has to
 *   hold a partial line between feeds.
 *
 * It deliberately implements only the subset the engine uses: `data:` fields
 * accumulated across a block, blocks terminated by a blank line, comments and
 * unknown fields dropped. `event:`, `id:` and `retry:` are parsed off the line
 * and discarded — the engine puts its own discriminator inside the JSON, so a
 * caller that branched on the SSE `event:` name would be reading a second,
 * weaker copy of the same information.
 */

/** One completed SSE block: the joined `data:` payload, ready to `JSON.parse`. */
export interface SseMessage {
  data: string
}

export class SseParser {
  /** Bytes seen since the last newline — a line split across two feeds. */
  private pending = ''
  /** `data:` values accumulated for the block currently being built. */
  private dataLines: string[] = []

  /**
   * Feed a chunk of the response body and get back every block it completed.
   *
   * A block completes on a blank line, so a chunk that ends mid-block yields
   * nothing and the parser keeps the partial state for the next feed.
   */
  feed(chunk: string): SseMessage[] {
    const out: SseMessage[] = []
    this.pending += chunk

    // `\r\n`, `\n` and a bare `\r` are all line terminators in SSE. Normalising
    // first is simpler than a three-way split and cannot merge two blank lines
    // into one, which would swallow a block boundary.
    const normalized = this.pending.replace(/\r\n?/g, '\n')
    const lines = normalized.split('\n')
    // The final element is whatever followed the last newline — an incomplete
    // line, or '' when the chunk ended exactly on a newline. Either way it is
    // not yet a line, so it goes back into `pending`.
    this.pending = lines.pop() ?? ''

    for (const line of lines) {
      if (line === '') {
        const message = this.flush()
        if (message) out.push(message)
        continue
      }
      // A comment. `: heartbeat` is the one the engine sends, but any line
      // starting with a colon is a comment and carries no field.
      //
      // **Honest note: this line is behaviourally redundant today and no test
      // pins it.** A comment line's colon is at index 0, so the field split
      // below yields `field === ''`, which is not `'data'` and is dropped
      // anyway — deleting this `continue` changes nothing observable, and a
      // test claiming to catch its removal would be decoration. It is kept as
      // an explicit statement of the SSE rule, and because it stops being
      // redundant the moment anyone changes the field split (e.g. to a
      // `split(':', 2)` that treats a leading colon as a missing field name).
      if (line.startsWith(':')) continue

      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      // "If value starts with a U+0020 SPACE, remove it" — exactly one space,
      // so a payload that legitimately begins with a space keeps the rest.
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)

      if (field === 'data') this.dataLines.push(value)
      // `event` / `id` / `retry` / anything unknown: dropped on purpose, see
      // the module comment.
    }

    return out
  }

  /**
   * Close out the block in progress, if any.
   *
   * The engine terminates every block with a blank line, so in practice this
   * only fires at end-of-stream on a truncated body — where returning the
   * partial block would hand the caller half a JSON document. It returns the
   * block only when at least one `data:` line was seen, which a truncated
   * block that never got its first `data:` has not.
   */
  private flush(): SseMessage | null {
    if (this.dataLines.length === 0) return null
    const data = this.dataLines.join('\n')
    this.dataLines = []
    return { data }
  }

  /**
   * Discard partial state. Called on reconnect so a half-line left over from
   * the dead socket cannot be glued onto the first line of the new one.
   */
  reset(): void {
    this.pending = ''
    this.dataLines = []
  }
}
