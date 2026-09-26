import type { MarkdownToc, TocEntry } from './markdownToc'

/**
 * The Contents panel of a Python file preview: top-level functions and classes
 * at depth 1, and each class's own methods at depth 2. Nested functions,
 * nested classes and assignments are left out.
 *
 * A line scan, not a parser: it skips triple-quoted strings so a `def` in a
 * docstring is not listed, and treats any other line at column 0 as the end of
 * the class above it. `line` is the 1-based line of the `def` / `class`
 * keyword (not its decorator), the key `CodePreview` marks in the body.
 */

const DEFINITION = /^([ \t]*)(?:async[ \t]+)?(def|class)[ \t]+([A-Za-z_]\w*)/
const TRIPLE_QUOTE = /"""|'''/g

export function pythonOutline(source: string): MarkdownToc {
  const entries: TocEntry[] = []
  const lines = source.split(/\r\n|\r|\n/)
  let openQuote: string | null = null
  // The class whose body is being read, and that body's indent once known.
  let inClass = false
  let memberIndent: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const startsInString = openQuote !== null
    for (const match of line.matchAll(TRIPLE_QUOTE)) {
      if (openQuote === null) openQuote = match[0]
      else if (openQuote === match[0]) openQuote = null
    }
    if (startsInString) continue

    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = line.slice(0, line.length - line.trimStart().length)

    if (indent === '') inClass = false
    else if (inClass && memberIndent === null) memberIndent = indent

    const def = DEFINITION.exec(line)
    if (!def) continue
    const [, defIndent, keyword, name] = def
    if (defIndent === '') {
      entries.push({ depth: 1, text: keyword === 'class' ? name : `${name}()`, line: i + 1 })
      if (keyword === 'class') {
        inClass = true
        memberIndent = null
      }
    } else if (inClass && keyword === 'def' && defIndent === memberIndent) {
      entries.push({ depth: 2, text: `${name}()`, line: i + 1 })
    }
  }

  return { entries, show: entries.length > 1 }
}
