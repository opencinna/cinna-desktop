import type { JsonLine, JsonValue } from '../components/chat/JsonTree'

/** Records the table reads, as many as a CSV table shows. */
export const MAX_TABLE_RECORDS = 500
/** Columns past this are left out under a note: a record per line can carry thousands of paths. */
export const MAX_TABLE_COLUMNS = 200
/** Deeper than this a value is one cell of JSON instead of more columns. */
const MAX_PATH_DEPTH = 32

export interface JsonLinesTable {
  /** `#` (the record's line in the file), then each value path in first-seen order. */
  header: string[]
  rows: string[][]
  /** More records than {@link MAX_TABLE_RECORDS} in the file. */
  clippedRows: boolean
  /** Every path seen, of which the first {@link MAX_TABLE_COLUMNS} are columns. */
  totalColumns: number
  /** Lines that are not JSON, which have no row; a line cut at the preview cap is not counted. */
  skipped: number
}

/**
 * A JSON Lines file as a table: every value path in a record (`user.name`,
 * `tags.0`) is a column, so records with the same shape line up and differing
 * ones leave blanks. An empty object or array is its own cell (`{}`, `[]`), a
 * record that is not an object or array is one `value` column.
 */
export function jsonLinesTable(lines: JsonLine[]): JsonLinesTable {
  const columns = new Map<string, number>()
  const records: Array<{ line: number; cells: Map<string, string> }> = []
  let skipped = 0
  let clippedRows = false
  for (const entry of lines) {
    if (!('value' in entry)) {
      if (!entry.cut) skipped++
      continue
    }
    if (records.length === MAX_TABLE_RECORDS) {
      clippedRows = true
      continue
    }
    const cells = new Map<string, string>()
    flatten(entry.value, '', 0, cells)
    for (const path of cells.keys()) if (!columns.has(path)) columns.set(path, columns.size)
    records.push({ line: entry.line, cells })
  }
  const shown = [...columns.keys()].slice(0, MAX_TABLE_COLUMNS)
  return {
    header: ['#', ...shown],
    rows: records.map(({ line, cells }) => [String(line), ...shown.map((path) => cells.get(path) ?? '')]),
    clippedRows,
    totalColumns: columns.size,
    skipped
  }
}

/** Longest JSON a too-deep value's cell shows. */
const MAX_CELL_CHARS = 2000

/**
 * A too-deep value as one cell. `JSON.stringify` recurses, and `JSON.parse`
 * accepts nesting far deeper than it survives: a line of 20k nested arrays
 * threw out of render and blanked the window.
 */
function cellJson(value: JsonValue): string {
  try {
    const json = JSON.stringify(value)
    return json.length > MAX_CELL_CHARS ? `${json.slice(0, MAX_CELL_CHARS)}…` : json
  } catch {
    return Array.isArray(value) ? '[ … ]' : '{ … }'
  }
}

function flatten(value: JsonValue, path: string, depth: number, out: Map<string, string>): void {
  if (typeof value !== 'object' || value === null) {
    out.set(path || 'value', value === null ? 'null' : String(value))
    return
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value)
  if (entries.length === 0) {
    out.set(path || 'value', Array.isArray(value) ? '[]' : '{}')
    return
  }
  if (depth >= MAX_PATH_DEPTH) {
    out.set(path || 'value', cellJson(value))
    return
  }
  for (const [key, child] of entries) flatten(child, path ? `${path}.${key}` : key, depth + 1, out)
}
