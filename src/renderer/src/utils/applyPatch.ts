/**
 * Parser for the OpenCode / Codex `apply_patch` textual patch format. Pure
 * (no React / Electron) so it can be unit-tested in isolation and reused by
 * any renderer that wants to surface a patch as a structured diff.
 *
 * Format:
 *
 *   *** Begin Patch
 *   *** Add File: path/to/file
 *   +new line
 *   *** Update File: path/to/other
 *   *** Move to: path/to/renamed
 *   @@ context
 *    unchanged
 *   -removed
 *   +added
 *   *** Delete File: path/to/gone
 *   *** End Patch
 */

export type PatchOp = 'add' | 'update' | 'delete'

export type PatchLineType = 'add' | 'del' | 'context' | 'hunk'

export interface PatchLine {
  type: PatchLineType
  text: string
}

export interface PatchFile {
  op: PatchOp
  path: string
  moveTo?: string
  lines: PatchLine[]
  additions: number
  deletions: number
}

const ADD_FILE = /^\*\*\*\s+Add File:\s*(.+)$/
const UPDATE_FILE = /^\*\*\*\s+Update File:\s*(.+)$/
const DELETE_FILE = /^\*\*\*\s+Delete File:\s*(.+)$/
const MOVE_TO = /^\*\*\*\s+Move to:\s*(.+)$/
const END_OF_FILE = /^\*\*\*\s+End of File\s*$/
const BEGIN_OR_END = /^\*\*\*\s+(Begin|End) Patch\s*$/

/**
 * Parse a textual patch into structured file operations. Returns `null` when
 * the input doesn't look like an apply_patch payload (or yields no files) so
 * callers can use it as a single guard-and-data check and fall back to the
 * generic renderer when it returns null.
 */
export function parsePatch(raw: unknown): PatchFile[] | null {
  if (typeof raw !== 'string' || !raw.includes('*** ')) return null

  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  const files: PatchFile[] = []
  let current: PatchFile | null = null

  const push = (): void => {
    if (current) files.push(current)
  }

  for (const line of lines) {
    if (BEGIN_OR_END.test(line)) continue

    let m: RegExpMatchArray | null
    if ((m = line.match(ADD_FILE))) {
      push()
      current = { op: 'add', path: m[1].trim(), lines: [], additions: 0, deletions: 0 }
      continue
    }
    if ((m = line.match(UPDATE_FILE))) {
      push()
      current = { op: 'update', path: m[1].trim(), lines: [], additions: 0, deletions: 0 }
      continue
    }
    if ((m = line.match(DELETE_FILE))) {
      push()
      current = { op: 'delete', path: m[1].trim(), lines: [], additions: 0, deletions: 0 }
      continue
    }
    if ((m = line.match(MOVE_TO)) && current) {
      current.moveTo = m[1].trim()
      continue
    }
    if (END_OF_FILE.test(line)) continue
    if (!current) continue

    if (line.startsWith('@@')) {
      current.lines.push({ type: 'hunk', text: line.slice(2).trim() })
    } else if (line.startsWith('+')) {
      current.lines.push({ type: 'add', text: line.slice(1) })
      current.additions++
    } else if (line.startsWith('-')) {
      current.lines.push({ type: 'del', text: line.slice(1) })
      current.deletions++
    } else {
      current.lines.push({ type: 'context', text: line.startsWith(' ') ? line.slice(1) : line })
    }
  }
  push()

  return files.length > 0 ? files : null
}
