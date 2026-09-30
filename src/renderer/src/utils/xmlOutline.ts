import type { MarkdownToc, TocEntry } from './markdownToc'
import { inlineText, type ParsedXml, type XmlElement } from './xmlDocument'

/**
 * The Contents panel of an XML file preview: the elements under the root down
 * to depth 4 (the root's children are depth 1; the root itself, one per file,
 * is not listed) that hold other elements — a leaf such as `<title>`,
 * `<price>` or an empty `<entry id="a"/>` is content, not a section — each
 * named by its tag and the first identifying value it has. An entry's `line` is the element's document-order id, which its row in
 * the tree carries as `data-heading-line`.
 */

/** Entries listed per parent before a "… N more" note stands for the rest. */
export const OUTLINE_PER_PARENT = 50
const MAX_DEPTH = 4
/** Longest label before it is cut with an ellipsis. */
const LABEL_MAX = 60
/** Attributes that name an element, in the order they are tried. */
const NAMING_ATTRS = ['id', 'name', 'key', 'title']
/** Child elements whose short text names their parent. */
const NAMING_CHILDREN = ['name', 'title']

function truncate(text: string): string {
  return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text
}

/** `item · Quarterly report`, or the bare tag when nothing names it. */
export function xmlElementLabel(el: XmlElement): string {
  let value: string | undefined
  for (const attr of NAMING_ATTRS) {
    value = el.attrs.find(([name]) => name === attr)?.[1].trim()
    if (value) break
  }
  if (!value) {
    for (const want of NAMING_CHILDREN) {
      const child = el.children.find((c): c is XmlElement => c.type === 'element' && c.name === want)
      value = child ? (inlineText(child) ?? undefined) : undefined
      if (value) break
    }
  }
  return truncate(value ? `${el.name} · ${value.replace(/\s+/g, ' ')}` : el.name)
}

function elementChildren(el: XmlElement): XmlElement[] {
  return el.children.filter((c): c is XmlElement => c.type === 'element')
}

/** An element that holds other elements: a section the panel lists. */
function isSection(el: XmlElement): boolean {
  return el.children.some((c) => c.type === 'element')
}

/** The outline of a parsed document; empty and not shown for `null`. */
export function xmlOutline(doc: ParsedXml | null): MarkdownToc {
  if (!doc) return { entries: [], show: false }
  const entries: TocEntry[] = []
  // Pre-order and iterative, so a deep document cannot overflow the stack.
  // A note is pushed under its parent's listed children, so it lands after
  // their subtrees.
  type Item = { el: XmlElement } | { note: TocEntry }
  const stack: Item[] = []
  const pushChildren = (parent: XmlElement): void => {
    if (parent.depth >= MAX_DEPTH) return
    const children = elementChildren(parent).filter(isSection)
    const listed = children.slice(0, OUTLINE_PER_PARENT)
    const rest = children.slice(OUTLINE_PER_PARENT)
    if (rest.length > 0) {
      const tags = new Set(rest.map((c) => c.name))
      stack.push({
        note: {
          depth: (parent.depth + 1) as TocEntry['depth'],
          text: `… ${rest.length} more`,
          // Unique and never an element id, which counts up from 0.
          line: -1 - parent.id,
          note: true,
          ...(tags.size === 1 ? { noteTag: rest[0].name } : {})
        }
      })
    }
    for (let i = listed.length - 1; i >= 0; i--) stack.push({ el: listed[i] })
  }
  pushChildren(doc.root)
  while (stack.length > 0) {
    const item = stack.pop() as Item
    if ('note' in item) {
      entries.push(item.note)
      continue
    }
    entries.push({ depth: item.el.depth as TocEntry['depth'], text: xmlElementLabel(item.el), line: item.el.id })
    pushChildren(item.el)
  }
  return { entries, show: entries.filter((entry) => !entry.note).length >= 2 }
}
