/**
 * Tables written as text: a fenced block in a chat reply that is really a
 * table (psql or mysql output, a markdown table inside a fence, `a | b | c`
 * lines, a ```csv block), and CSV out of any rows. Pure, so the chat's
 * "Table actions" menu and its tests share one reading.
 */

import { detectCommand } from '../../../shared/commandRun'

/**
 * Parse delimited text into rows, honoring double-quoted fields that may
 * contain the delimiter, embedded newlines, and `""` escaped quotes
 * (RFC-4180-ish). A single pass over the whole text — not line-by-line — so a
 * quoted cell spanning multiple physical lines stays one cell instead of
 * splitting into bogus rows. Returns one array of cells per non-blank
 * record, and stops once it has more than `maxRows`.
 */
export function parseDelimited(text: string, delimiter: string, maxRows = Infinity): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      // A blank physical line parses to a single empty cell: not a row.
      if (!(row.length === 1 && row[0] === '')) rows.push(row)
      row = []
      field = ''
      if (rows.length > maxRows) return rows
    } else {
      field += ch
    }
  }
  // Flush a trailing partial record. A file ending in a newline already
  // pushed its last row and leaves nothing buffered, so this skips the empty
  // phantom row that would otherwise appear.
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/**
 * Languages whose block may be a pipe table: text-ish output, never code. A
 * shell block of two `a | grep b` pipelines is not a table.
 */
const PIPE_TABLE_LANGS = new Set([
  'text', 'txt', 'plain', 'plaintext', 'table', 'md', 'markdown',
  'sql', 'psql', 'mysql', 'log', 'output'
])

/**
 * A rule between rows: only border characters and spaces (ASCII, light,
 * rounded, double and dashed box drawing), with at least three dashes,
 * equals or box rules.
 */
const SEPARATOR_CHARS = /^[-=+:|─━┼├┤┌┐└┘┬┴│╋╭╮╰╯╒╓╕╖╘╙╛╜╞╟╡╢╤╥╧╨╪╫═║╔╗╚╝╠╣╦╩╬┆┊╎\s]+$/
const RULE_CHARS = /[-=─━═]/g

/** Cell delimiters: ASCII, light, dashed (polars) and double box rules. */
const DELIMITERS = new Set(['|', '│', '┆', '║'])

/** Code, not a table: a shell `||`, a template's `{{`. */
const CODE_MARKS = /\|\||\{\{/

/** polars prints `shape: (3, 2)` over its table: allowed once, first. */
const POLARS_SHAPE = /^shape: \(\d+, \d+\)$/

/** psql's `(3 rows)`, mysql's `3 rows in set (0.00 sec)`: one is allowed, last. */
const FOOTER = /^(\(\d+ rows?\)|\d+ rows? in set\b.*)$/i

function isSeparator(line: string): boolean {
  return SEPARATOR_CHARS.test(line) && (line.match(RULE_CHARS)?.length ?? 0) >= 3
}

function isDelimiter(ch: string): boolean {
  return DELIMITERS.has(ch)
}

/** One line's cells, `\|` a literal pipe, untrimmed and with any edge delimiters' empty cells kept. Null without a delimiter. */
function splitPipeLine(line: string): string[] | null {
  const cells: string[] = []
  let cell = ''
  let delimiters = 0
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '\\' && line[i + 1] === '|') {
      cell += '|'
      i++
    } else if (isDelimiter(ch)) {
      delimiters++
      cells.push(cell)
      cell = ''
    } else {
      cell += ch
    }
  }
  cells.push(cell)
  return delimiters === 0 ? null : cells
}

/**
 * Rows of `|`- or `│`-separated lines. Whether a line's edge delimiter is a
 * border (`| a | b |`) or follows an empty cell (psql's `   | b` for a null
 * first column) is read from the header: a table whose header has a leading
 * (trailing) delimiter drops one from every line that has it, and one whose
 * header has none keeps the empty cell.
 */
function parsePipeTable(text: string, labeled: boolean): string[][] | null {
  const lines = text.split(/\r\n|\r|\n/).map((line) => line.trim()).filter((line) => line !== '')
  // Only an unlabeled block can be code in disguise; a ```md table may hold a `{{ x }}` cell.
  if (!labeled && lines.some((line) => CODE_MARKS.test(line))) return null
  if (lines.length > 0 && FOOTER.test(lines[lines.length - 1])) lines.pop()
  const polars = lines.length > 0 && POLARS_SHAPE.test(lines[0])
  if (polars) lines.shift()
  /** Per row: whether a rule line came right before it. */
  const ruledBefore: boolean[] = []
  let ruled = false
  const rows: string[][] = []
  let leading: boolean | null = null
  let trailing = false
  let separated = false
  let edged = true
  for (const line of lines) {
    if (isSeparator(line)) {
      separated = true
      ruled = true
      continue
    }
    const cells = splitPipeLine(line)
    if (!cells) return null
    const starts = isDelimiter(line[0])
    const ends = isDelimiter(line[line.length - 1]) && !line.endsWith('\\|')
    edged &&= starts && ends
    if (leading === null) {
      leading = starts
      trailing = ends
    }
    if (leading && cells.length > 1 && cells[0] === '') cells.shift()
    if (trailing && cells.length > 1 && cells[cells.length - 1] === '') cells.pop()
    rows.push(cells.map((cell) => cell.trim()))
    ruledBefore.push(ruled)
    ruled = false
  }
  // polars puts the column types (`i64 ┆ str`) between the `---` rule and the `╞═` one: not data.
  if (polars && rows.length > 2 && ruledBefore[1] && ruledBefore[2]) rows.splice(1, 1)
  // Two bare `a | b` lines are as likely two pipelines: a table says so with
  // a rule, a frame, or a third row.
  if (!separated && !edged && rows.length < 3) return null
  return rows
}

/** Leading edge-delimiter cells off a header line, trimmed; null without a delimiter. */
function headerCells(line: string): string[] | null {
  const cells = splitPipeLine(line)
  if (!cells) return null
  if (isDelimiter(line[0]) && cells.length > 1 && cells[0].trim() === '') cells.shift()
  if (isDelimiter(line[line.length - 1]) && cells.length > 1 && cells[cells.length - 1].trim() === '') cells.pop()
  return cells.map((cell) => cell.trim())
}

/**
 * A `|`-separated header over rows aligned with spaces, the shape an agent
 * writes when it lays a table out by hand:
 *
 *     Odoo id | name | status | months
 *     35   Kay Schneider     inactive  01..10
 *     1279 Jurek Breunig     ACTIVE    01..10
 *
 * Columns are the gutters blank on every row — not runs of two spaces, since
 * a wide first column leaves one (`1279 Jurek`). The header says how many
 * there are: exactly that many gutters, or that many clearly more padded than
 * the rest; anything less certain is not a table. Tabs make alignment unknowable.
 */
function parseAlignedTable(text: string, labeled: boolean): string[][] | null {
  const lines = text.split(/\r\n|\r|\n/).map((line) => line.trimEnd()).filter((line) => line.trim() !== '')
  if (!labeled && lines.some((line) => CODE_MARKS.test(line))) return null
  if (lines.length > 0 && FOOTER.test(lines[lines.length - 1].trim())) lines.pop()
  if (lines.length < 3) return null
  const header = headerCells(lines[0].trim())
  if (!header || header.length < 2) return null
  const body = lines.slice(1).filter((line) => !isSeparator(line.trim()))
  if (body.length < 2 || body.some((line) => line.includes('\t') || splitPipeLine(line) !== null)) return null
  const indent = Math.min(...body.map((line) => line.length - line.trimStart().length))
  const rows = body.map((line) => line.slice(indent))
  const width = Math.max(...rows.map((row) => row.length))
  const blank = (i: number): boolean => rows.every((row) => (row[i] ?? ' ') === ' ')
  const gutters: { start: number; end: number }[] = []
  for (let i = 1; i < width; i++) {
    if (!blank(i)) continue
    let end = i
    while (end < width && blank(end)) end++
    if (end < width) gutters.push({ start: i, end })
    i = end
  }
  const needed = header.length - 1
  if (gutters.length < needed) return null
  let chosen = gutters
  if (gutters.length > needed) {
    // A column's gutter is padded on most rows (cells end ragged); a space
    // that lines up by chance inside a column (`#FTE -> x` over `(empty) -> y`)
    // is one space on every row. Score each by the space around it, row by row.
    const padding = (gutter: { start: number }): number =>
      rows.reduce((sum, row) => {
        let left = gutter.start
        while (left > 0 && (row[left - 1] ?? ' ') === ' ') left--
        let right = gutter.start
        while (right < width && (row[right] ?? ' ') === ' ') right++
        return sum + (right - left)
      }, 0)
    const scored = gutters.map((gutter) => ({ gutter, score: padding(gutter) })).sort((a, b) => b.score - a.score)
    if (scored[needed - 1].score <= scored[needed].score) return null
    chosen = scored.slice(0, needed).map((entry) => entry.gutter).sort((a, b) => a.start - b.start)
  }
  const cells = rows.map((row) => {
    const out: string[] = []
    let from = 0
    for (const gutter of chosen) {
      out.push(row.slice(from, gutter.start).trim())
      from = gutter.end
    }
    out.push(row.slice(from).trim())
    return out
  })
  // Two lines of prose under a piped line can line up by chance; a table's
  // first column is always filled and every column mostly is.
  if (cells.some((row) => row[0] === '')) return null
  for (let col = 1; col < header.length; col++) {
    if (cells.filter((row) => row[col] !== '').length * 2 < cells.length) return null
  }
  return [header, ...cells]
}

/** At least a header and one data row, at least two columns, every row as wide as the header. */
function wellFormed(rows: string[][] | null): rows is string[][] {
  if (!rows || rows.length < 2) return false
  const width = rows[0].length
  return width >= 2 && rows.every((row) => row.length === width)
}

/**
 * The rows of a fenced block that reads as a table (the first row its
 * header), or null. `lang` is the fence's language, lowercase, or null.
 */
export function parseTextTable(text: string, lang: string | null | undefined): string[][] | null {
  const language = (lang ?? '').trim().toLowerCase()
  if (language === 'csv' || language === 'tsv') {
    const rows = parseDelimited(text, language === 'csv' ? ',' : '\t')
    return wellFormed(rows) ? rows : null
  }
  if (language !== '' && !PIPE_TABLE_LANGS.has(language)) return null
  // A block the Run… detection reads as a command is one, whatever its pipes.
  if (detectCommand(text, { fenced: true, lang: language })) return null
  const rows = parsePipeTable(text, language !== '')
  if (wellFormed(rows)) return rows
  const aligned = parseAlignedTable(text, language !== '')
  return wellFormed(aligned) ? aligned : null
}

/** A cell that must be quoted: a comma, a quote, a line break, or whitespace at either end. */
const NEEDS_QUOTES = /[",\r\n]|^\s|\s$/

/** What a spreadsheet would run as a formula: `=`, `@`, a tab or CR first, or `+`/`-` before anything but a number. */
const FORMULA_START = /^[=@\t\r]/
const SIGNED = /^[+-]/
const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i

/** A cell made safe to open in a spreadsheet: a would-be formula gets a leading `'`. */
function defuse(cell: string): string {
  if (FORMULA_START.test(cell) || (SIGNED.test(cell) && !PLAIN_NUMBER.test(cell))) return `'${cell}`
  return cell
}

/** Rows as RFC 4180 CSV, CRLF between records, with formula-like cells defused. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows
    .map((row) =>
      row
        .map((raw) => {
          const cell = defuse(raw)
          return NEEDS_QUOTES.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell
        })
        .join(',')
    )
    .join('\r\n')
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** `table-YYYY-MM-DD-HHmm.csv`, in local time. */
export function csvFilename(date: Date = new Date()): string {
  return `table-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.csv`
}

/**
 * Save rows as a CSV file: Electron asks where. A UTF-8 byte-order mark
 * first, so Excel reads non-ASCII text as UTF-8.
 */
export function downloadCsv(rows: readonly (readonly string[])[], filename: string = csvFilename()): void {
  const blob = new Blob(['\uFEFF', toCsv(rows)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
