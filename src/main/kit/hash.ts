/**
 * The one content digest the kit layer uses.
 *
 * Two callers depend on it meaning the same thing in both places: `exportTree`
 * hashes what would travel to a Cinna instance, and `manifestIo` stamps the
 * bytes it read so a later write can tell whether someone else rewrote the file.
 * Both answer "are these the same bytes", and neither may answer it from
 * metadata — mtime and size are preserved by `cp -p`, `rsync -t` and several
 * editors, so a file can change without either moving.
 */

import { createHash } from 'node:crypto'

/** SHA-256 of exactly these bytes, lower-case hex. */
export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}
