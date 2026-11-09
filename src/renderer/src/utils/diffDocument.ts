import type { TocEntry } from './markdownToc'

/**
 * A `.diff` / `.patch` file read for a person: which files changed, what was
 * removed and what took its place, and inside a replaced line, which words.
 *
 * Reads two shapes. A **unified diff** (`git diff`, `diff -u`, a `format-patch`
 * mail, `difflib.unified_diff`): files, hunks counted by their `@@` header, so a
 * removed line reading `-- x` is not taken for a file header. A **bare change
 * list**: every line starts `+`, `-` or a space, with no headers at all. Anything
 * else is `null`, and the preview shows the text as it is.
 *
 * **Flowing text.** Some tools diff the text nodes of a page rather than its
 * lines, so one sentence arrives as `+Traffic in 7 days: `, `+/sellers.json`,
 * `+ 7,404 hits, `. Read row by row that is unreadable, so a diff that plainly
 * looks like this gets its fragments joined back into sentences and its HTML
 * entities decoded. Indentation anywhere rules it out: that is code, whose
 * leading space means something. Copying the file still gets the bytes as written.
 */

/** A run of a replaced line, marked when it is what actually changed. */
export interface DiffSegment {
  text: string
  changed: boolean
}

export type DiffRow =
  | {
      kind: 'add' | 'del' | 'context'
      text: string
      /** The line in the new file (the old file for a removal); null where the diff does not say. */
      line: number | null
      /** Set on one side of a replaced line when the two are alike enough to compare. */
      segments?: DiffSegment[]
    }
  /** `\ No newline at end of file` and the like: said in words, not counted. */
  | { kind: 'note'; text: string }

export interface DiffHunk {
  /** Where this hunk starts in the new file; null where the diff does not say. */
  line: number | null
  /** The enclosing function or section the `@@` line names, when it names one. */
  section: string
  rows: DiffRow[]
}

export type DiffFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'binary' | 'mode'

export interface DiffFile {
  /** 1-based line of the file's header in the source: the key its Contents entry scrolls to. */
  sourceLine: number
  oldPath: string | null
  newPath: string | null
  status: DiffFileStatus
  additions: number
  deletions: number
  hunks: DiffHunk[]
  /** Text between the previous file and this one: the next commit's message in a patch series. */
  preamble: string[]
  /** Lines after this file's hunks that belong to no hunk (a mail signature): shown, never dropped. */
  trailing: string[]
}

export interface ParsedDiff {
  /** Text before the first file: a patch mail's message, the output of `git show`. */
  preamble: string[]
  files: DiffFile[]
  /** No file headers at all: one nameless file. */
  headerless: boolean
  /** Fragments were joined into sentences (see above): line numbers no longer mean anything. */
  flowing: boolean
  additions: number
  deletions: number
  /** Runs of change, a removal and what replaced it counting as one. */
  changes: number
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/
/** What may follow a real `diff --git` line. In a commit message that line is followed by prose. */
const GIT_EXTENDED = /^(?:index |old mode|new mode|new file|deleted file|similarity |dissimilarity |rename |copy |Binary |GIT binary|--- )/

/**
 * What an `@@` line with no numbers names, as agents and `apply_patch` write
 * them, or null when it is not one. By hand, as `GIT_HEADER` below: a regex
 * over a long run of spaces backtracks quadratically, and a 1 MB line of them
 * froze the window for most of an hour.
 */
function bareHunkSection(line: string): string | null {
  if (!line.startsWith('@@')) return null
  const rest = line.slice(2)
  if (rest !== '' && !/^\s/.test(rest)) return null
  const trimmed = rest.trim()
  return (trimmed.endsWith('@@') ? trimmed.slice(0, -2) : trimmed).trim()
}

/** The two paths of a `diff --git` line: `a/x b/x`, unprefixed `x x`, or the last ` b/` when they differ. */
function gitHeaderPaths(line: string): { oldPath: string; newPath: string } | null {
  const rest = line.slice('diff --git '.length).replace(/"/g, '')
  const half = (rest.length - 1) / 2
  if (rest.startsWith('a/') && rest.slice(half + 1, half + 3) === 'b/' && rest.slice(2, half) === rest.slice(half + 3)) {
    return { oldPath: rest.slice(2, half), newPath: rest.slice(half + 3) }
  }
  if (Number.isInteger(half) && rest[half] === ' ' && rest.slice(0, half) === rest.slice(half + 1)) {
    return { oldPath: rest.slice(0, half), newPath: rest.slice(half + 1) }
  }
  const split = rest.lastIndexOf(' b/')
  return rest.startsWith('a/') && split > 0 ? { oldPath: rest.slice(2, split), newPath: rest.slice(split + 3) } : null
}

function cleanPath(raw: string): string | null {
  // `--- a/x\t2024-01-01 10:00:00` carries a date after a tab; a quoted path is unquoted.
  const path = raw.split('\t')[0].trim().replace(/^"(.*)"$/, '$1')
  return path === '/dev/null' ? null : path
}

function stripPrefixes(file: DiffFile): void {
  const { oldPath, newPath } = file
  if ((oldPath === null || oldPath.startsWith('a/')) && (newPath === null || newPath.startsWith('b/'))) {
    file.oldPath = oldPath?.slice(2) ?? null
    file.newPath = newPath?.slice(2) ?? null
  }
}

function newFile(sourceLine: number): DiffFile {
  return {
    sourceLine,
    oldPath: null,
    newPath: null,
    status: 'modified',
    additions: 0,
    deletions: 0,
    hunks: [],
    preamble: [],
    trailing: []
  }
}

/** What to call a file: its path, or `old → new` when the diff compares two names. */
export function diffFileLabel(file: DiffFile): string {
  const { oldPath, newPath } = file
  if (oldPath && newPath && oldPath !== newPath) return `${oldPath} → ${newPath}`
  return newPath ?? oldPath ?? 'Changes'
}

function isFileHeader(lines: string[], i: number): boolean {
  const line = lines[i]
  const next = lines[i + 1] ?? ''
  if (line.startsWith('diff --git ')) return GIT_EXTENDED.test(next)
  if (!line.startsWith('--- ') || !next.startsWith('+++ ')) return false
  // Nothing after the pair: a file whose hunks are not there.
  if (i + 2 >= lines.length) return true
  // A hunk has rows: a quoted `---`, `+++`, `@@` in a commit message is followed
  // by prose. Empty counts as a row, since tools strip a blank context line's space.
  return lines[i + 2].startsWith('@@') && /^(?:[-+ \\]|$)/.test(lines[i + 3] ?? '')
}

function isUnified(lines: string[]): boolean {
  return lines.some((line, i) => isFileHeader(lines, i) || bareHunkSection(line) !== null || HUNK.test(line))
}

function parseUnified(lines: string[]): { preamble: string[]; files: DiffFile[] } {
  const preamble: string[] = []
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  /** The current file came from a `diff --git` line and its hunks have not begun. */
  let inGitHeader = false
  /** Free text since the last hunk: the next file's message, or this file's signature. */
  let loose: string[] = []

  const startFile = (at: number): DiffFile => {
    const file = newFile(at + 1)
    // The previous commit's signature comes before the next commit's message.
    if (loose[0] === '-- ' && current) {
      const end = loose.indexOf('')
      const signature = end < 0 ? loose : loose.slice(0, end)
      ;(current as DiffFile).trailing.push(...signature)
      loose = end < 0 ? [] : loose.slice(end + 1)
    }
    file.preamble = loose
    loose = []
    files.push(file)
    current = file
    return file
  }

  // Everything before the first real file header is the message, even a line
  // in it that looks like a hunk: a commit message may well quote one.
  const first = lines.findIndex((_, at) => isFileHeader(lines, at))
  if (first > 0) preamble.push(...lines.slice(0, first))
  let i = Math.max(first, 0)
  while (i < lines.length) {
    const line = lines[i]

    if (line.startsWith('diff --git ') && isFileHeader(lines, i)) {
      const file = startFile(i)
      const paths = gitHeaderPaths(line)
      if (paths) {
        file.oldPath = paths.oldPath
        file.newPath = paths.newPath
      }
      inGitHeader = true
      i++
      continue
    }

    if (isFileHeader(lines, i)) {
      // The `---`/`+++` of a `diff --git` file, or a file of its own.
      const file: DiffFile = inGitHeader && current ? current : startFile(i)
      const gitStatus = file.status
      file.oldPath = cleanPath(line.slice(4))
      file.newPath = cleanPath(lines[i + 1].slice(4))
      stripPrefixes(file)
      if (file.oldPath === null) file.status = 'added'
      else if (file.newPath === null) file.status = 'deleted'
      else if (gitStatus !== 'modified') file.status = gitStatus
      inGitHeader = false
      i += 2
      continue
    }

    const counted = HUNK.exec(line)
    const bare = counted ? null : bareHunkSection(line)
    if (counted || bare !== null) {
      const file: DiffFile = current ?? startFile(i)
      inGitHeader = false
      let oldLine = counted ? Number(counted[1]) : null
      let newLine = counted ? Number(counted[3]) : null
      let oldLeft = counted ? Number(counted[2] ?? 1) : Infinity
      let newLeft = counted ? Number(counted[4] ?? 1) : Infinity
      const hunk: DiffHunk = { line: newLine, section: (counted ? counted[5] : (bare ?? '')).trim(), rows: [] }
      file.hunks.push(hunk)
      i++
      while (i < lines.length && (oldLeft > 0 || newLeft > 0)) {
        const row = lines[i]
        // A hunk with no counts ends at whatever starts the next thing.
        if (!counted && (row.startsWith('@@') || isFileHeader(lines, i))) break
        // A count too high must not swallow the next file. The `@@` after the
        // pair is what tells it from a removal and an addition reading the same,
        // unless the pair is exactly what the hunk still has room for.
        if (counted && (oldLeft !== 1 || newLeft !== 1) && isFileHeader(lines, i) && HUNK.test(lines[i + 2] ?? '')) break
        // A mail signature: its last line, or the one before.
        if (!counted && row === '-- ' && i >= lines.length - 2) break
        const sign = row[0]
        if (sign === '+') {
          hunk.rows.push({ kind: 'add', text: row.slice(1), line: newLine })
          file.additions++
          if (newLine !== null) newLine++
          newLeft--
        } else if (sign === '-') {
          hunk.rows.push({ kind: 'del', text: row.slice(1), line: oldLine })
          file.deletions++
          if (oldLine !== null) oldLine++
          oldLeft--
        } else if (sign === '\\') {
          hunk.rows.push({ kind: 'note', text: row.slice(1).trim() })
        } else if (sign === ' ' || (row === '' && (counted || /^[-+ ]/.test(lines[i + 1] ?? '')))) {
          hunk.rows.push({ kind: 'context', text: row.slice(1), line: newLine })
          if (newLine !== null) newLine++
          if (oldLine !== null) oldLine++
          oldLeft--
          newLeft--
        } else {
          break
        }
        i++
      }
      // The note follows the last counted line.
      if (lines[i]?.startsWith('\\')) {
        hunk.rows.push({ kind: 'note', text: lines[i].slice(1).trim() })
        i++
      }
      continue
    }

    if (inGitHeader && current) {
      const file: DiffFile = current
      if (line.startsWith('new file mode')) file.status = 'added'
      else if (line.startsWith('deleted file mode')) file.status = 'deleted'
      else if (line.startsWith('rename from ') || line.startsWith('copy from ')) {
        file.oldPath = line.replace(/^(rename|copy) from /, '')
        file.status = line.startsWith('copy') ? 'copied' : 'renamed'
      } else if (line.startsWith('rename to ') || line.startsWith('copy to ')) {
        file.newPath = line.replace(/^(rename|copy) to /, '')
        file.status = line.startsWith('copy') ? 'copied' : 'renamed'
      } else if (line.startsWith('old mode') || line.startsWith('new mode')) {
        if (file.status === 'modified') file.status = 'mode'
      } else if (line.startsWith('Binary files ')) {
        file.status = 'binary'
      } else if (line.startsWith('GIT binary patch')) {
        file.status = 'binary'
        // The encoded payload is no use to a reader; it ends at a blank line
        // pair, and whatever follows it is shown as any other text.
        i++
        while (i < lines.length && !lines[i].startsWith('diff --git ') && lines[i] !== '-- ') i++
        inGitHeader = false
        continue
      } else if (!line.startsWith('index ') && !line.startsWith('similarity index') && !line.startsWith('dissimilarity index')) {
        loose.push(line)
        inGitHeader = false
      }
      i++
      continue
    }

    // Blank lines keep a message's paragraphs apart; leading ones mean nothing.
    if (line.trim() !== '' || loose.length > 0) loose.push(line)
    i++
  }
  // With no file after it, it was the last file's: a signature.
  const last = files[files.length - 1]
  if (last) last.trailing.push(...loose)
  return { preamble, files }
}

/** Every non-blank line starts `+`, `-` or a space, and at least one is a change. */
function parseBare(lines: string[]): DiffFile | null {
  const hunk: DiffHunk = { line: null, section: '', rows: [] }
  const file = newFile(1)
  file.hunks.push(hunk)
  for (const line of lines) {
    if (line.trim() === '') continue
    if (line[0] === '+') {
      hunk.rows.push({ kind: 'add', text: line.slice(1), line: null })
      file.additions++
    } else if (line[0] === '-') {
      hunk.rows.push({ kind: 'del', text: line.slice(1), line: null })
      file.deletions++
    } else if (line[0] === ' ') {
      hunk.rows.push({ kind: 'context', text: line.slice(1), line: null })
    } else {
      return null
    }
  }
  return file.additions + file.deletions > 0 ? file : null
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  rarr: '→',
  larr: '←',
  hellip: '…',
  middot: '·',
  bull: '•',
  times: '×',
  copy: '©',
  reg: '®',
  trade: '™',
  laquo: '«',
  raquo: '»',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”'
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] !== '#') return Object.hasOwn(ENTITIES, body) ? ENTITIES[body] : whole
    const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
    // Out of range, a surrogate or NUL: leave it as written rather than throw.
    if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole
    return String.fromCodePoint(code)
  })
}

/** Share of rows that must start or end in a space before a diff counts as fragments. */
const FRAGMENT_SHARE = 0.15

function looksFlowing(files: DiffFile[]): boolean {
  let total = 0
  let fragments = 0
  // A sentence's later pieces start with their space. Whole lines that merely
  // end in one must keep their line breaks and their entities as written.
  let leading = false
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const row of hunk.rows) {
        if (row.kind === 'note') continue
        // Indented: a code diff, where the leading space is the code's.
        if (/^(?: {2,}|\t)/.test(row.text)) return false
        total++
        if (/^\s/.test(row.text)) leading = true
        // One space at an end. Two or more at the end is a markdown hard break, on a whole line.
        if (/^\s|\S\s$/.test(row.text)) fragments++
      }
    }
  }
  if (total === 0 || !leading || fragments / total < FRAGMENT_SHARE) return false
  // Nothing to join, nothing gained: every row is a whole line that happens to end in a space.
  return files.some((file) =>
    file.hunks.some((hunk) =>
      hunk.rows.some((row, i) => {
        const prev = hunk.rows[i - 1]
        return row.kind !== 'note' && prev && prev.kind === row.kind && continues(prev.text, row.text)
      })
    )
  )
}

/** Whether `next` carries on the sentence `prev` was in. */
function continues(prev: string, next: string): boolean {
  return /\s$/.test(prev) || /^\s/.test(next) || /^[.,;:!?)\]]/.test(next) || /[([]$/.test(prev)
}

function joinFragments(hunk: DiffHunk): void {
  const out: DiffRow[] = []
  for (const row of hunk.rows) {
    const last = out[out.length - 1]
    if (row.kind !== 'note' && last && last.kind === row.kind && continues(last.text, row.text)) {
      last.text += row.text
    } else {
      out.push({ ...row })
    }
  }
  for (const row of out) {
    if (row.kind !== 'note') row.text = decodeEntities(row.text).trim()
  }
  hunk.rows = out
}

const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu
const WORD = /[\p{L}\p{N}_]/u

/** The most token pairs a replaced line is compared over: past it, no word marks. */
const MAX_COMPARED_PAIRS = 1_000_000
/** How many rows ahead a removal looks for what replaced it. */
const PAIR_WINDOW = 8
/** Share of the shorter side that must be common before marking words beats marking nothing. */
const MIN_ALIKE = 0.5

function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? []
}

function wordSet(text: string): Set<string> {
  return new Set(tokenize(text).filter((token) => WORD.test(token)))
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let common = 0
  for (const word of a) if (b.has(word)) common++
  return common / Math.min(a.size, b.size)
}

function toSegments(tokens: string[], keep: boolean[]): DiffSegment[] {
  // Space or a lone hyphen or dot between two changed words is part of the
  // change, or a replaced phrase or file name reads as a row of separate marks.
  const marks = tokens.map((token, i) => {
    if (keep[i] && !WORD.test(token) && i > 0 && i < tokens.length - 1 && !keep[i - 1] && !keep[i + 1]) return false
    return keep[i]
  })
  const segments: DiffSegment[] = []
  tokens.forEach((token, i) => {
    const changed = !marks[i]
    const last = segments[segments.length - 1]
    if (last && last.changed === changed) last.text += token
    else segments.push({ text: token, changed })
  })
  return segments
}

/** Word marks for a removed line and its replacement, or null when they are not alike enough to help. */
export function compareWords(before: string, after: string): { before: DiffSegment[]; after: DiffSegment[] } | null {
  const a = tokenize(before)
  const b = tokenize(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const n = endA - start
  const m = endB - start
  if (n * m > MAX_COMPARED_PAIRS) return null

  const keepA = a.map((_, i) => i < start || i >= endA)
  const keepB = b.map((_, i) => i < start || i >= endB)
  if (n > 0 && m > 0) {
    const width = m + 1
    const table = new Uint32Array((n + 1) * width)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * width + j] =
          a[start + i] === b[start + j]
            ? table[(i + 1) * width + j + 1] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        keepA[start + i] = true
        keepB[start + j] = true
        i++
        j++
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++
      else j++
    }
  }

  const kept = (tokens: string[], keep: boolean[]): number =>
    tokens.reduce((sum, token, i) => (keep[i] && WORD.test(token) ? sum + token.length : sum), 0)
  const size = (tokens: string[]): number =>
    tokens.reduce((sum, token) => (WORD.test(token) ? sum + token.length : sum), 0)
  const shorter = Math.min(size(a), size(b))
  if (shorter === 0 || Math.min(kept(a, keepA), kept(b, keepB)) / shorter < MIN_ALIKE) return null
  return { before: toSegments(a, keepA), after: toSegments(b, keepB) }
}

type ChangeRow = Exclude<DiffRow, { kind: 'note' }>

/** Marks the changed words of each removal paired with the addition that replaced it. */
function pairRun(removed: ChangeRow[], added: ChangeRow[]): void {
  const addedWords = added.map((row) => wordSet(row.text))
  let from = 0
  for (const row of removed) {
    const words = wordSet(row.text)
    for (let at = from; at < Math.min(added.length, from + PAIR_WINDOW); at++) {
      if (overlap(words, addedWords[at]) < MIN_ALIKE) continue
      const marks = compareWords(row.text, added[at].text)
      if (marks) {
        row.segments = marks.before
        added[at].segments = marks.after
        from = at + 1
      }
      break
    }
  }
}

/** Compares each run of removals with the additions right after it; returns how many runs there were. */
function markRuns(hunk: DiffHunk): number {
  let runs = 0
  let i = 0
  const { rows } = hunk
  while (i < rows.length) {
    if (rows[i].kind !== 'add' && rows[i].kind !== 'del') {
      i++
      continue
    }
    runs++
    const removed: ChangeRow[] = []
    const added: ChangeRow[] = []
    while (i < rows.length && rows[i].kind === 'del') removed.push(rows[i++] as ChangeRow)
    // `\\ No newline at end of file` sits between a last line and its replacement.
    while (i < rows.length && rows[i].kind === 'note' && removed.length > 0) i++
    while (i < rows.length && rows[i].kind === 'add') added.push(rows[i++] as ChangeRow)
    if (removed.length > 0 && added.length > 0) pairRun(removed, added)
  }
  return runs
}

/**
 * Reads a diff, or null when the text is neither shape. Empty text is a diff of
 * nothing, not a failure.
 */
export function parseDiff(text: string): ParsedDiff | null {
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  const empty = lines.every((line) => line.trim() === '')

  let preamble: string[] = []
  let files: DiffFile[] = []
  let headerless = false
  if (!empty) {
    if (isUnified(lines)) ({ preamble, files } = parseUnified(lines))
    else {
      const bare = parseBare(lines)
      if (!bare) return null
      files = [bare]
      headerless = true
    }
    // An `@@` in ordinary text is not a diff: no name, and nothing changed.
    if (files.every((file) => !file.oldPath && !file.newPath && file.additions + file.deletions === 0)) return null
  }

  const flowing = looksFlowing(files)
  let changes = 0
  let additions = 0
  let deletions = 0
  for (const file of files) {
    additions += file.additions
    deletions += file.deletions
    for (const hunk of file.hunks) {
      if (flowing) joinFragments(hunk)
      changes += markRuns(hunk)
    }
  }
  return { preamble, files, headerless, flowing, additions, deletions, changes }
}

/** Name first, folder after: under a long shared folder, whole paths all cut to the same words. */
function outlineLabel(file: DiffFile): string {
  const path = file.newPath ?? file.oldPath
  if (!path) return diffFileLabel(file)
  const slash = path.lastIndexOf('/')
  return slash < 0 ? path : `${path.slice(slash + 1)} · ${path.slice(0, slash)}`
}

/** The Contents panel of a diff: its files, when there is more than one to choose from. */
export function diffOutline(diff: ParsedDiff | null): { entries: TocEntry[]; show: boolean } {
  const files = diff?.files ?? []
  return {
    entries: files.map((file) => ({ depth: 1, text: outlineLabel(file), line: file.sourceLine })),
    show: files.length >= 2
  }
}
