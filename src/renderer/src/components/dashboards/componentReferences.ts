import { parseSkillLink } from '../../../../shared/skillLink'
import { defaultUrlTransform } from 'react-markdown'
import { COMPONENT_REFERENCE_PREFIX, componentReferenceKey, parseComponentReference } from '../../../../shared/componentReference'

/**
 * Component references in chat markdown (README §5.5): a remark plugin that
 * turns references into one list of cards per message, and the
 * `urlTransform` that keeps `cinna://component/` hrefs (react-markdown's
 * default empties every protocol it does not know).
 *
 * What becomes a card:
 * - a line that is exactly one reference — bare text, an angle autolink, or
 *   `[text](cinna://component/…)` — inside a paragraph, a list item or a
 *   quote. The line is removed; a link's text becomes the card's subtitle;
 * - a reference link inside prose. The link stays where it is (as its text),
 *   and its card joins the list.
 *
 * Every card of a message is in one compact list, at the place of the first
 * reference, one card per component (`componentReferenceKey`). Code spans and
 * code blocks are leaf nodes here, so a reference inside one stays text.
 *
 * Rendering a card runs nothing (README D8): the list only names references.
 */

/** The element the plugin produces; `chatMarkdown` maps it to the card list. */
export const COMPONENT_REFS_TAG = 'cinna-component-refs'

/** One card the list draws. */
export interface ComponentRefItem {
  /** The reference as written. */
  reference: string
  /** A markdown link's text, the card's subtitle; null for a bare reference. */
  label: string | null
}

interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
  data?: Record<string, unknown>
}

/** Nodes whose content is never a reference. */
const LEAVES = new Set(['code', 'inlineCode', 'html', 'math', 'inlineMath'])
/** Containers whose emptied children leave nothing worth drawing. */
const DROPPABLE_WHEN_EMPTY = new Set(['listItem', 'list', 'blockquote'])

function plainText(node: MdNode): string {
  if (typeof node.value === 'string') return node.value
  return (node.children ?? []).map(plainText).join('')
}

function isBlank(node: MdNode): boolean {
  return node.type === 'text' && (node.value ?? '').trim() === ''
}

/** The reference a link names, or null. */
function linkReference(node: MdNode): ComponentRefItem | null {
  if (node.type !== 'link' || typeof node.url !== 'string') return null
  if (!parseComponentReference(node.url)) return null
  const text = plainText(node).trim()
  return { reference: node.url, label: text === '' || text === node.url ? null : text }
}

/** The reference a whole line is, or null. */
function lineReference(line: MdNode[]): ComponentRefItem | null {
  const content = line.filter((node) => !isBlank(node))
  if (content.length !== 1) return null
  const only = content[0]
  if (only.type === 'text') {
    const text = (only.value ?? '').trim()
    return parseComponentReference(text) ? { reference: text, label: null } : null
  }
  return linkReference(only)
}

interface Line {
  nodes: MdNode[]
  /** What ended the line: a `\n` text or a `break` node; null for the last. */
  end: MdNode | null
}

/** A paragraph's inline children, split at soft and hard line breaks. */
function splitLines(children: MdNode[]): Line[] {
  const lines: Line[] = []
  let current: MdNode[] = []
  for (const child of children) {
    if (child.type === 'break') {
      lines.push({ nodes: current, end: child })
      current = []
      continue
    }
    if (child.type === 'text' && (child.value ?? '').includes('\n')) {
      const parts = (child.value ?? '').split('\n')
      parts.forEach((part, index) => {
        if (part !== '') current.push({ type: 'text', value: part })
        if (index < parts.length - 1) {
          lines.push({ nodes: current, end: { type: 'text', value: '\n' } })
          current = []
        }
      })
      continue
    }
    current.push(child)
  }
  lines.push({ nodes: current, end: null })
  return lines
}

class Collector {
  readonly items: ComponentRefItem[] = []
  private readonly keys = new Map<string, number>()

  add(item: ComponentRefItem): void {
    const ref = parseComponentReference(item.reference)
    if (!ref) return
    const key = componentReferenceKey(ref)
    const at = this.keys.get(key)
    if (at === undefined) {
      this.keys.set(key, this.items.length)
      this.items.push(item)
    } else if (this.items[at].label === null && item.label !== null) {
      // The same component named again with link text: the text is the better subtitle.
      this.items[at] = { ...this.items[at], label: item.label }
    }
  }

  /** Reference links anywhere under `node` (they stay in the text). */
  links(node: MdNode): void {
    if (LEAVES.has(node.type)) return
    const item = linkReference(node)
    if (item) this.add(item)
    for (const child of node.children ?? []) this.links(child)
  }
}

/**
 * A paragraph without its reference lines: the paragraphs of the lines left
 * (none when every line was a reference). Unchanged when no line is one.
 */
function paragraph(node: MdNode, collect: Collector, isTail: (node: MdNode) => boolean): MdNode[] {
  const lines = splitLines(node.children ?? [])
  // While a reply streams, its last line may still grow (`deals` → `deals-pipeline`).
  const held = isTail(node) ? lines.length - 1 : -1
  const refs = lines.map((line, index) => (index === held ? null : lineReference(line.nodes)))
  if (refs.every((ref) => ref === null)) {
    collect.links(node)
    return [node]
  }
  const out: MdNode[] = []
  let group: Line[] = []
  const flush = (): void => {
    // Trailing blank lines (a reference was the last) are not content.
    while (group.length > 0 && group[group.length - 1].nodes.every(isBlank)) group.pop()
    while (group.length > 0 && group[0].nodes.every(isBlank)) group.shift()
    if (group.length > 0) {
      const children: MdNode[] = []
      group.forEach((line, index) => {
        children.push(...line.nodes)
        if (index < group.length - 1 && line.end) children.push(line.end)
      })
      const rebuilt: MdNode = { type: 'paragraph', children }
      collect.links(rebuilt)
      out.push(rebuilt)
    }
    group = []
  }
  lines.forEach((line, index) => {
    const ref = refs[index]
    if (ref) {
      flush()
      collect.add(ref)
    } else {
      group.push(line)
    }
  })
  flush()
  return out
}

/** `node` with its reference lines taken out, or [] when nothing is left of it. */
function block(node: MdNode, collect: Collector, isTail: (node: MdNode) => boolean): MdNode[] {
  if (LEAVES.has(node.type)) return [node]
  if (node.type === 'paragraph') return paragraph(node, collect, isTail)
  if (node.type === 'listItem' || node.type === 'list' || node.type === 'blockquote') {
    const before = node.children ?? []
    const children = before.flatMap((child) => block(child, collect, isTail))
    if (children.length === 0 && before.length > 0 && DROPPABLE_WHEN_EMPTY.has(node.type)) return []
    return [{ ...node, children }]
  }
  // Headings, tables, footnotes: a reference there is a link at most.
  collect.links(node)
  return [node]
}

export interface RemarkComponentReferencesOptions {
  /** The text is still streaming: its last line is left as text until it ends. */
  holdTail?: boolean
}

export function remarkComponentReferences(options: RemarkComponentReferencesOptions = {}) {
  return (tree: MdNode, file: { value?: unknown }): void => {
    const source = typeof file.value === 'string' ? file.value : String(file.value ?? '')
    const tailEnd = source.trimEnd().length
    const isTail = (node: MdNode): boolean =>
      options.holdTail === true && (node.position?.end.offset ?? -1) >= tailEnd
    const collect = new Collector()
    const children: MdNode[] = []
    let anchor = -1
    for (const child of tree.children ?? []) {
      const before = collect.items.length
      const kept = block(child, collect, isTail)
      if (anchor === -1 && collect.items.length > before) {
        // In place of a block that was only references, otherwise right after it.
        anchor = children.length + kept.length
      }
      children.push(...kept)
    }
    if (collect.items.length > 0) {
      children.splice(anchor, 0, {
        type: 'componentReferences',
        children: [],
        data: { hName: COMPONENT_REFS_TAG, hProperties: { dataRefs: JSON.stringify(collect.items) } }
      })
    }
    tree.children = children
  }
}

/** The list's items back from the element's `data-refs`. */
export function componentRefItems(value: unknown): ComponentRefItem[] {
  if (typeof value !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is ComponentRefItem => typeof item?.reference === 'string' && (item.label === null || typeof item.label === 'string'))
      : []
  } catch {
    return []
  }
}

/**
 * react-markdown's `urlTransform`, keeping component references and
 * `cinna://skill/…` links (its default empties `cinna:`). A skill link is kept
 * only when the grammar accepts it whole; anything else under `cinna:` is
 * emptied as before.
 */
export function chatUrlTransform(url: string): string {
  if (url.startsWith(COMPONENT_REFERENCE_PREFIX)) return url
  if (parseSkillLink(url)?.form === 'cinna') return url
  return defaultUrlTransform(url)
}
