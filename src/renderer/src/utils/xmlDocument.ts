/**
 * An XML file preview's parsed document: the renderer's `DOMParser` turned,
 * once, into a small plain model the tree and the Contents outline both read.
 *
 * Chromium's XML parser does not fetch external entities or DTDs, so a
 * previewed file cannot reach the network or the disk through it; no other
 * parser is used.
 */

export interface XmlElement {
  type: 'element'
  /** Document-order index: the tree's fold key and the Contents entry's `line`. */
  id: number
  /** The qualified name as written, `ns:tag` included. */
  name: string
  /** Attributes as written, namespace declarations included. */
  attrs: Array<[string, string]>
  children: XmlNode[]
  parent: XmlElement | null
  /** Position among the parent's `children`, for paging the tree to it. */
  index: number
  /** 0 for the root element. */
  depth: number
}

export interface XmlLeaf {
  type: 'text' | 'comment' | 'cdata' | 'pi' | 'doctype'
  /** Text (trimmed), comment or CDATA content, PI data, or the whole doctype. */
  value: string
  /** A processing instruction's target. */
  target?: string
}

export type XmlNode = XmlElement | XmlLeaf

export interface ParsedXml {
  /** The document's own children in order: declaration, doctype, comments, PIs, the root. */
  nodes: XmlNode[]
  root: XmlElement
  /** Every element, indexed by `id`. */
  elements: XmlElement[]
}

/** The namespaces Chromium (XHTML) and jsdom (Mozilla's) put a `<parsererror>` in. */
const PARSER_ERROR_NS = ['http://www.w3.org/1999/xhtml', 'http://www.mozilla.org/newlayout/xml/parsererror.xml']

/** The XML declaration, which the DOM does not keep as a node. */
const DECLARATION = /^﻿?\s*<\?xml(\s[^?]*)?\?>/

/**
 * Parse `text` as XML, or `null` when it is not well-formed — malformed, or
 * cut off by the preview's byte cap — and should be shown as source.
 */
export function parseXml(text: string): ParsedXml | null {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(text, 'application/xml')
  } catch {
    return null
  }
  for (const ns of PARSER_ERROR_NS) if (doc.getElementsByTagNameNS(ns, 'parsererror').length > 0) return null
  const rootElement = doc.documentElement
  if (!rootElement) return null

  const elements: XmlElement[] = []
  const nodes: XmlNode[] = []
  const declaration = DECLARATION.exec(text)
  if (declaration) nodes.push({ type: 'pi', target: 'xml', value: (declaration[1] ?? '').trim() })

  let root: XmlElement | null = null
  // Iterative: a recursive walk would overflow on a deeply nested document.
  const stack: Array<{ dom: Node; parent: XmlElement | null }> = []
  const pushChildren = (dom: Node, parent: XmlElement | null): void => {
    for (let i = dom.childNodes.length - 1; i >= 0; i--) stack.push({ dom: dom.childNodes[i], parent })
  }
  pushChildren(doc, null)
  while (stack.length > 0) {
    const { dom, parent } = stack.pop() as { dom: Node; parent: XmlElement | null }
    const siblings = parent ? parent.children : nodes
    const node = toNode(dom, parent, siblings.length, elements.length)
    if (!node) continue
    siblings.push(node)
    if (node.type === 'element') {
      elements.push(node)
      if (!parent) root = node
      pushChildren(dom, node)
    }
  }
  return root ? { nodes, root, elements } : null
}

function toNode(dom: Node, parent: XmlElement | null, index: number, id: number): XmlNode | null {
  switch (dom.nodeType) {
    case Node.ELEMENT_NODE: {
      const el = dom as Element
      return {
        type: 'element',
        id,
        name: el.nodeName,
        attrs: Array.from(el.attributes, (attr) => [attr.name, attr.value] as [string, string]),
        children: [],
        parent,
        index,
        depth: parent ? parent.depth + 1 : 0
      }
    }
    case Node.TEXT_NODE: {
      const value = (dom.nodeValue ?? '').trim()
      return value ? { type: 'text', value } : null
    }
    case Node.CDATA_SECTION_NODE:
      return { type: 'cdata', value: dom.nodeValue ?? '' }
    case Node.COMMENT_NODE:
      return { type: 'comment', value: dom.nodeValue ?? '' }
    case Node.PROCESSING_INSTRUCTION_NODE: {
      const pi = dom as ProcessingInstruction
      return { type: 'pi', target: pi.target, value: pi.data }
    }
    case Node.DOCUMENT_TYPE_NODE: {
      const dt = dom as DocumentType
      const id = dt.publicId
        ? ` PUBLIC "${dt.publicId}"${dt.systemId ? ` "${dt.systemId}"` : ''}`
        : dt.systemId
          ? ` SYSTEM "${dt.systemId}"`
          : ''
      return { type: 'doctype', value: `${dt.name}${id}` }
    }
    default:
      return null
  }
}

/** Longest text an element may hold and still render on one line, `<a>text</a>`. */
export const INLINE_TEXT_MAX = 80

/** An element whose only child is a short single-line text: rendered inline. */
export function inlineText(el: XmlElement): string | null {
  if (el.children.length !== 1) return null
  const only = el.children[0]
  if (only.type !== 'text' || only.value.length > INLINE_TEXT_MAX || only.value.includes('\n')) return null
  return only.value
}

/** Whether an element gets a chevron: it has children and is not inline. */
export function isFoldable(el: XmlElement): boolean {
  return el.children.length > 0 && inlineText(el) === null
}
