import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { ChevronRight } from 'lucide-react'
import { inlineText, isFoldable, type ParsedXml, type XmlElement, type XmlLeaf, type XmlNode } from '../../utils/xmlDocument'
import { CHILD_PAGE, EXPAND_ALL_LIMIT } from './JsonTree'

/** From this depth (the root is 0) a large document starts folded: one row per top-level child. */
const FOLDED_DEPTH = 1
/** Deeper than this an element starts folded, whatever the document's size. */
const MAX_OPEN_DEPTH = 32

/** Unfolds an element's ancestors and pages to it, so a Contents click finds its row. */
export type XmlReveal = (id: number) => void

/**
 * A parsed XML document as a collapsible tree, coloured with the code-block
 * palette (`.hljs-*` in main.css): tag names as names, attribute names as
 * attributes, values as strings, comments as comments; punctuation secondary.
 * Built like {@link JsonTree}: each element with children folds on its
 * chevron, Alt-click folds or unfolds the whole branch, a large document
 * opens with only the root's children listed, and long child lists page.
 *
 * Each element's first row carries `data-heading-line={id}`, the key the
 * Contents panel scrolls to and tracks. `revealRef` is set to a function that
 * unfolds and pages the way to an element, which the panel calls before it
 * scrolls. The parent keys this by the file text, as it does the JSON tree.
 */
export function XmlTree({
  doc,
  revealRef
}: {
  doc: ParsedXml
  revealRef?: RefObject<XmlReveal | null>
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<number>>(() => defaultCollapsed(doc))
  const [shown, setShown] = useState<Map<number, number>>(() => new Map())
  const showMore = (id: number): void =>
    setShown((prev) => new Map(prev).set(id, (prev.get(id) ?? CHILD_PAGE) + CHILD_PAGE))
  const treeRef = useRef<HTMLDivElement>(null)
  const pending = useRef<{ anchor: HTMLElement; top: number; height: number; slack: number } | null>(null)

  const reveal = useCallback<XmlReveal>(
    (id) => {
      const target = doc.elements[id]
      if (!target) return
      setCollapsed((prev) => {
        let next = prev
        for (let el = target.parent; el; el = el.parent) {
          if (!next.has(el.id)) continue
          if (next === prev) next = new Set(prev)
          next.delete(el.id)
        }
        return next
      })
      setShown((prev) => {
        let next = prev
        for (let child: XmlElement = target; child.parent; child = child.parent) {
          const parent = child.parent
          if (child.index < (next.get(parent.id) ?? CHILD_PAGE)) continue
          if (next === prev) next = new Map(prev)
          next.set(parent.id, Math.ceil((child.index + 1) / CHILD_PAGE) * CHILD_PAGE)
        }
        return next
      })
    },
    [doc]
  )
  useLayoutEffect(() => {
    if (!revealRef) return
    revealRef.current = reveal
    return () => {
      if (revealRef.current === reveal) revealRef.current = null
    }
  }, [revealRef, reveal])

  // A fold must not move the row that was clicked: the same floor and scroll
  // correction as the JSON tree (see there).
  useLayoutEffect(() => {
    const tree = treeRef.current
    const p = pending.current
    pending.current = null
    if (!tree || !p) return
    tree.style.minHeight = ''
    const required = p.height - p.slack
    if (tree.offsetHeight < required) tree.style.minHeight = `${required}px`
    const scroller = scrollParent(tree)
    if (!p.anchor.isConnected) return
    const shift = p.anchor.getBoundingClientRect().top - p.top
    if (scroller && shift !== 0) scroller.scrollTop += shift
  }, [collapsed])

  const toggle = (el: XmlElement, branch: boolean, anchor: HTMLElement): void => {
    const tree = treeRef.current
    const scroller = tree ? scrollParent(tree) : null
    if (tree) {
      pending.current = {
        anchor,
        top: anchor.getBoundingClientRect().top,
        height: tree.offsetHeight,
        slack: scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight : 0
      }
    }
    setCollapsed((prev) => {
      const next = new Set(prev)
      const fold = !prev.has(el.id)
      for (const id of branch ? foldableIds(el) : [el.id]) {
        if (fold) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  const ctx: TreeContext = { collapsed, onToggle: toggle, shown, onShowMore: showMore }
  return (
    // Plain rows with disclosure buttons, not an ARIA tree, as in the JSON tree.
    <div
      ref={treeRef}
      data-testid="xml-tree"
      className="font-mono text-xs leading-relaxed text-[var(--color-text)]"
    >
      {doc.nodes.map((node, index) => (
        <XmlNodeView key={node.type === 'element' ? `e${node.id}` : index} node={node} ctx={ctx} />
      ))}
    </div>
  )
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === 'auto' || overflowY === 'scroll') return node
  }
  return null
}

/** Ids of every foldable element in a branch, the branch's own included. Iterative. */
function foldableIds(el: XmlElement): number[] {
  const out: number[] = []
  const stack: XmlElement[] = [el]
  while (stack.length > 0) {
    const node = stack.pop() as XmlElement
    if (!isFoldable(node)) continue
    out.push(node.id)
    for (const child of node.children) if (child.type === 'element') stack.push(child)
  }
  return out
}

function defaultCollapsed(doc: ParsedXml): Set<number> {
  let count = doc.nodes.length
  for (const el of doc.elements) {
    count += el.children.length
    if (count > EXPAND_ALL_LIMIT) break
  }
  const from = count <= EXPAND_ALL_LIMIT ? MAX_OPEN_DEPTH : FOLDED_DEPTH
  return new Set(doc.elements.filter((el) => el.depth >= from && isFoldable(el)).map((el) => el.id))
}

interface TreeContext {
  collapsed: Set<number>
  onToggle: (el: XmlElement, branch: boolean, anchor: HTMLElement) => void
  /** Children shown per element id, when more than `CHILD_PAGE`. */
  shown: Map<number, number>
  onShowMore: (id: number) => void
}

function XmlNodeView({ node, ctx }: { node: XmlNode; ctx: TreeContext }): React.JSX.Element {
  return node.type === 'element' ? <ElementView el={node} ctx={ctx} /> : <LeafView leaf={node} />
}

/** A single-line row: a gutter where a chevron would be, then wrapping content. */
function Row({ children, id }: { children: React.ReactNode; id?: number }): React.JSX.Element {
  return (
    <div data-xml-row data-heading-line={id} className="flex">
      <Gutter />
      {/* Hanging indent: wrapped attributes and text sit inside the row. */}
      <span className="min-w-0 whitespace-pre-wrap pl-[2ch] [overflow-wrap:anywhere] [text-indent:-2ch]">
        {children}
      </span>
    </div>
  )
}

function ElementView({ el, ctx }: { el: XmlElement; ctx: TreeContext }): React.JSX.Element {
  if (el.children.length === 0) {
    return (
      <Row id={el.id}>
        <StartTag el={el} selfClosing />
      </Row>
    )
  }
  const inline = inlineText(el)
  if (inline !== null) {
    return (
      <Row id={el.id}>
        <StartTag el={el} />
        {inline}
        <EndTag name={el.name} />
      </Row>
    )
  }

  const isCollapsed = ctx.collapsed.has(el.id)
  const limit = ctx.shown.get(el.id) ?? CHILD_PAGE
  const hidden = Math.max(0, el.children.length - limit)
  const toggle = (e: React.MouseEvent<HTMLElement>): void =>
    ctx.onToggle(el, e.altKey, e.currentTarget.closest<HTMLElement>('[data-xml-row]') ?? e.currentTarget)
  const count = `${el.children.length} ${el.children.length === 1 ? 'child' : 'children'}`

  return (
    <div data-xml-row>
      <div data-heading-line={el.id} className="flex">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!isCollapsed}
          aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${el.name}`}
          title="Alt-click to fold or unfold the whole branch"
          className="flex h-[1.625em] w-4 shrink-0 items-center justify-center rounded
            text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          <ChevronRight size={11} className={`transition-transform ${isCollapsed ? '' : 'rotate-90'}`} />
        </button>
        <span className="min-w-0 whitespace-pre-wrap pl-[2ch] [overflow-wrap:anywhere] [text-indent:-2ch]">
          <StartTag el={el} />
          {isCollapsed && (
            <>
              {/* A pointer shortcut for the chevron beside it, not a second tab stop. */}
              <button
                type="button"
                tabIndex={-1}
                aria-hidden
                onClick={toggle}
                className="rounded [text-indent:0] hover:bg-[var(--color-bg-hover)]"
              >
                <Punct>…</Punct>
              </button>
              <EndTag name={el.name} />
              <span className="ml-2 text-[var(--color-text-secondary)] italic">{count}</span>
            </>
          )}
        </span>
      </div>
      {!isCollapsed && (
        <>
          <div className="ml-[0.45rem] border-l border-[var(--color-border)] pl-2">
            {el.children.slice(0, limit).map((child, index) => (
              <XmlNodeView key={child.type === 'element' ? `e${child.id}` : index} node={child} ctx={ctx} />
            ))}
            {hidden > 0 && (
              <div className="flex">
                <Gutter />
                <button
                  type="button"
                  onClick={() => ctx.onShowMore(el.id)}
                  className="rounded px-1 font-sans text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]"
                >
                  Show {Math.min(CHILD_PAGE, hidden)} more of {hidden}
                </button>
              </div>
            )}
          </div>
          <Row>
            <EndTag name={el.name} />
          </Row>
        </>
      )}
    </div>
  )
}

function LeafView({ leaf }: { leaf: XmlLeaf }): React.JSX.Element {
  switch (leaf.type) {
    case 'text':
      return <Row>{leaf.value}</Row>
    case 'comment':
      return (
        <Row>
          <span className="hljs-comment">{`<!--${leaf.value}-->`}</span>
        </Row>
      )
    case 'cdata':
      return (
        <Row>
          <Punct>{'<![CDATA['}</Punct>
          {leaf.value}
          <Punct>{']]>'}</Punct>
        </Row>
      )
    case 'pi':
      return (
        <Row>
          <span className="hljs-meta">{`<?${leaf.target}${leaf.value ? ` ${leaf.value}` : ''}?>`}</span>
        </Row>
      )
    case 'doctype':
      return (
        <Row>
          <span className="hljs-meta">{`<!DOCTYPE ${leaf.value}>`}</span>
        </Row>
      )
  }
}

function StartTag({ el, selfClosing = false }: { el: XmlElement; selfClosing?: boolean }): React.JSX.Element {
  return (
    <>
      <Punct>{'<'}</Punct>
      <span className="hljs-name">{el.name}</span>
      {el.attrs.map(([name, value], index) => (
        <span key={index}>
          {' '}
          <span className="hljs-attr">{name}</span>
          <Punct>=</Punct>
          <span className="hljs-string">{`"${value}"`}</span>
        </span>
      ))}
      <Punct>{selfClosing ? '/>' : '>'}</Punct>
    </>
  )
}

function EndTag({ name }: { name: string }): React.JSX.Element {
  return (
    <>
      <Punct>{'</'}</Punct>
      <span className="hljs-name">{name}</span>
      <Punct>{'>'}</Punct>
    </>
  )
}

function Gutter(): React.JSX.Element {
  return <span className="w-4 shrink-0" aria-hidden />
}

function Punct({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="text-[var(--color-text-secondary)]">{children}</span>
}
