import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'

/**
 * The Contents panel of a markdown file preview: its headings, and whether the
 * file is long enough to want the panel at all.
 *
 * Parsed with the pipeline `react-markdown` renders the preview with, so a `#`
 * inside a code fence is not a heading and a setext (`===` / `---`) one is, and
 * a heading's line here is the line of the node the preview renders. Callers
 * pass exactly the string handed to `<Markdown>` — the body after the
 * frontmatter split — or the lines would not match.
 */

export interface TocEntry {
  depth: 1 | 2 | 3 | 4
  /** The heading as plain text, inline markup flattened. */
  text: string
  /** 1-based source line: the key the rendered heading carries in `data-heading-line`. */
  line: number
}

export interface MarkdownToc {
  entries: TocEntry[]
  /** Several H1s, or several H2s: the file is long enough for the panel. */
  show: boolean
}

interface MdNode {
  type: string
  depth?: number
  value?: string
  alt?: string | null
  children?: MdNode[]
  position?: { start: { line: number } }
}

const parser = unified().use(remarkParse).use(remarkGfm)

/**
 * A node's text with its markup gone: `*(mandatory)*` reads "(mandatory)".
 * An image contributes its alt text. (`mdast-util-to-string` is only a
 * transitive dependency here, so it is not imported.)
 */
export function flattenText(node: MdNode): string {
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? ''
  if (typeof node.value === 'string' && (node.type === 'text' || node.type === 'inlineCode')) return node.value
  if (!Array.isArray(node.children)) return ''
  return node.children.map(flattenText).join('')
}

function collectHeadings(node: MdNode, out: MdNode[]): void {
  if (node.type === 'heading') {
    out.push(node)
    return
  }
  if (Array.isArray(node.children)) for (const child of node.children) collectHeadings(child, out)
}

/**
 * H1–H4 in document order. A lone H1 is the document's title and is left out,
 * so its H2s are the top level; several H1s are all listed. The panel is
 * offered when there is more than one H1 or more than one H2 — the H2 count
 * holds whether or not an H1 comes first, since some files start at H2.
 */
export function markdownToc(markdown: string): MarkdownToc {
  const headings: MdNode[] = []
  collectHeadings(parser.parse(markdown) as MdNode, headings)
  const h1 = headings.filter((h) => h.depth === 1).length
  const h2 = headings.filter((h) => h.depth === 2).length
  const entries: TocEntry[] = []
  for (const heading of headings) {
    const depth = heading.depth ?? 0
    if (depth < 1 || depth > 4 || !heading.position) continue
    if (depth === 1 && h1 === 1) continue
    entries.push({
      depth: depth as TocEntry['depth'],
      text: flattenText(heading).replace(/\s+/g, ' ').trim(),
      line: heading.position.start.line
    })
  }
  return { entries, show: h1 > 1 || h2 > 1 }
}
