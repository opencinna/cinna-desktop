import { Component, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { linkifySegments } from '../../utils/frontmatter'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/**
 * Above this many values a file opens with only the root unfolded — one row
 * per top-level member: a 500 KB export fully expanded is tens of thousands
 * of rows the user scrolls past to find the one branch they came for, and each
 * is a React subtree. Folding from the second level instead still unfolded
 * every record of a top-level array.
 */
export const EXPAND_ALL_LIMIT = 2000
const FOLDED_DEPTH = 1
/**
 * Children a container shows before a "Show more" row. Folding alone does not
 * bound a document whose root is itself huge: a 512 KB array of numbers is a
 * quarter of a million rows with nothing to fold.
 */
export const CHILD_PAGE = 200
/** Deeper than this a container starts folded, whatever the document's size. */
const MAX_OPEN_DEPTH = 32

/**
 * A parsed JSON document as a collapsible tree, coloured with the code-block
 * palette (`.hljs-*` in main.css): keys as names — the red of an XML tag —
 * strings green, numbers and literals orange, punctuation secondary. Each object
 * or array folds on its chevron; Alt-click folds or unfolds the whole branch.
 *
 * The parent keys this by the file text, so another file starts from its own
 * default fold state rather than inheriting paths that meant something else.
 */
export function JsonTree({ value }: { value: JsonValue }): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => defaultCollapsed(value))
  const [shown, setShown] = useState<Map<string, number>>(() => new Map())
  const showMore = (path: string): void =>
    setShown((prev) => new Map(prev).set(path, (prev.get(path) ?? CHILD_PAGE) + CHILD_PAGE))
  const treeRef = useRef<HTMLDivElement>(null)
  const pending = useRef<{ anchor: HTMLElement; top: number; height: number; slack: number } | null>(null)

  // A fold must not move the row that was clicked. Folding near the end of a
  // scrolled preview shortened the content past the scroll position, the
  // browser pulled the scroll back, and every row above the fold — the
  // clicked chevron included — slid down under the pointer. So the tree keeps
  // just enough height that the scroll position survives, and any residual
  // shift is scrolled away before paint. The floor is recomputed on every
  // toggle, so unfolding again drops it.
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

  const toggle = (path: string, node: JsonValue, branch: boolean, anchor: HTMLElement): void => {
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
      const fold = !prev.has(path)
      const paths = branch ? containerPaths(node, path, 0, Infinity) : [path]
      for (const p of paths) {
        if (fold) next.add(p)
        else next.delete(p)
      }
      return next
    })
  }

  return (
    // Plain rows with disclosure buttons, not an ARIA tree: that pattern wants
    // focusable items and arrow-key navigation, and rows here hold buttons and
    // links of their own.
    <div
      ref={treeRef}
      data-testid="json-tree"
      className="font-mono text-xs leading-relaxed text-[var(--color-text)]"
    >
      <JsonNode
        value={value}
        path=""
        label="root"
        last
        collapsed={collapsed}
        onToggle={toggle}
        shown={shown}
        onShowMore={showMore}
      />
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

function isContainer(value: JsonValue): value is JsonValue[] | { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null
}

function childEntries(value: JsonValue[] | { [key: string]: JsonValue }): Array<[string, JsonValue]> {
  return Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value)
}

function childPath(path: string, key: string): string {
  return `${path}/${encodeURIComponent(key)}`
}

/**
 * Paths of every non-empty container in `value` between two depths below it.
 * Iterative: `JSON.parse` accepts nesting far deeper than a recursive walk
 * survives, and a stack overflow here would take the whole window down.
 */
function containerPaths(value: JsonValue, path: string, minDepth: number, maxDepth: number): string[] {
  const out: string[] = []
  const stack: Array<[JsonValue, string, number]> = [[value, path, 0]]
  while (stack.length > 0) {
    const [node, p, depth] = stack.pop() as [JsonValue, string, number]
    if (!isContainer(node)) continue
    const entries = childEntries(node)
    if (entries.length === 0) continue
    if (depth >= minDepth && depth <= maxDepth) out.push(p)
    for (const [key, child] of entries) stack.push([child, childPath(p, key), depth + 1])
  }
  return out
}

function countValues(value: JsonValue, limit: number): number {
  let count = 0
  const stack: JsonValue[] = [value]
  while (stack.length > 0 && count <= limit) {
    const node = stack.pop() as JsonValue
    count++
    if (isContainer(node)) for (const [, child] of childEntries(node)) stack.push(child)
  }
  return count
}

function defaultCollapsed(value: JsonValue): Set<string> {
  const from = countValues(value, EXPAND_ALL_LIMIT) <= EXPAND_ALL_LIMIT ? MAX_OPEN_DEPTH : FOLDED_DEPTH
  return new Set(containerPaths(value, '', from, Infinity))
}

interface JsonNodeProps {
  value: JsonValue
  path: string
  /** Last child of its parent: no trailing comma. */
  last: boolean
  /** The key (object member) or nothing (array item, root). */
  name?: string
  /** What the fold button names: the key, `item N`, or `root`. */
  label: string
  collapsed: Set<string>
  onToggle: (path: string, node: JsonValue, branch: boolean, anchor: HTMLElement) => void
  /** Children shown per container path, when more than `CHILD_PAGE`. */
  shown: Map<string, number>
  onShowMore: (path: string) => void
}

function JsonNode({
  value,
  path,
  last,
  name,
  label: foldLabel,
  collapsed,
  onToggle,
  shown,
  onShowMore
}: JsonNodeProps): React.JSX.Element {
  const comma = last ? null : <Punct>,</Punct>
  const label =
    name !== undefined ? (
      <>
        <span className="hljs-name">{JSON.stringify(name)}</span>
        <Punct>: </Punct>
      </>
    ) : null

  if (!isContainer(value)) {
    return (
      <div data-json-row className="flex">
        <Gutter />
        {/* Hanging indent: a long string's wrapped lines sit inside the row
            rather than at the key's edge, where they read as more rows. */}
        <span className="min-w-0 whitespace-pre-wrap pl-[2ch] [overflow-wrap:anywhere] [text-indent:-2ch]">
          {label}
          <Scalar value={value} />
          {comma}
        </span>
      </div>
    )
  }

  const isArray = Array.isArray(value)
  const [open, close] = isArray ? ['[', ']'] : ['{', '}']
  const entries = childEntries(value)
  if (entries.length === 0) {
    return (
      <div data-json-row className="flex">
        <Gutter />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {label}
          <Punct>{open + close}</Punct>
          {comma}
        </span>
      </div>
    )
  }

  const isCollapsed = collapsed.has(path)
  const limit = shown.get(path) ?? CHILD_PAGE
  const hidden = Math.max(0, entries.length - limit)
  // Anchor on the row, which survives the toggle; the `{ … }` button does not.
  const toggle = (e: React.MouseEvent<HTMLElement>): void =>
    onToggle(path, value, e.altKey, e.currentTarget.closest<HTMLElement>('[data-json-row]') ?? e.currentTarget)
  const count = `${entries.length} ${isArray ? (entries.length === 1 ? 'item' : 'items') : entries.length === 1 ? 'key' : 'keys'}`

  return (
    <div data-json-row>
      <div className="flex">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!isCollapsed}
          aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${foldLabel}`}
          title="Alt-click to fold or unfold the whole branch"
          className="flex h-[1.625em] w-4 shrink-0 items-center justify-center rounded
            text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          <ChevronRight size={11} className={`transition-transform ${isCollapsed ? '' : 'rotate-90'}`} />
        </button>
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {label}
          {isCollapsed ? (
            <>
              {/* A pointer shortcut for the chevron beside it, not a second tab stop. */}
              <button
                type="button"
                tabIndex={-1}
                aria-hidden
                onClick={toggle}
                className="rounded hover:bg-[var(--color-bg-hover)]"
              >
                <Punct>{`${open} … ${close}`}</Punct>
              </button>
              {comma}
              <span className="ml-2 text-[var(--color-text-secondary)] italic">{count}</span>
            </>
          ) : (
            <Punct>{open}</Punct>
          )}
        </span>
      </div>
      {!isCollapsed && (
        <>
          <div className="ml-[0.45rem] border-l border-[var(--color-border)] pl-2">
            {entries.slice(0, limit).map(([key, child], index) => (
              <JsonNode
                key={key}
                value={child}
                path={childPath(path, key)}
                last={index === entries.length - 1}
                name={isArray ? undefined : key}
                label={isArray ? `item ${key}` : key}
                collapsed={collapsed}
                onToggle={onToggle}
                shown={shown}
                onShowMore={onShowMore}
              />
            ))}
            {hidden > 0 && (
              <div className="flex">
                <Gutter />
                <button
                  type="button"
                  onClick={() => onShowMore(path)}
                  className="rounded px-1 font-sans text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]"
                >
                  Show {Math.min(CHILD_PAGE, hidden)} more of {hidden}
                </button>
              </div>
            )}
          </div>
          <div className="flex">
            <Gutter />
            <span>
              <Punct>{close}</Punct>
              {comma}
            </span>
          </div>
        </>
      )}
    </div>
  )
}

function Gutter(): React.JSX.Element {
  return <span className="w-4 shrink-0" aria-hidden />
}

function Punct({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="text-[var(--color-text-secondary)]">{children}</span>
}

function Scalar({ value }: { value: string | number | boolean | null }): React.JSX.Element {
  if (typeof value === 'string') {
    // `http(s)` URLs in strings open externally, like links in markdown.
    return (
      <span className="hljs-string">
        {linkifySegments(JSON.stringify(value)).map((segment, index) =>
          segment.href ? (
            <a
              key={index}
              href={segment.href}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2"
            >
              {segment.text}
            </a>
          ) : (
            <span key={index}>{segment.text}</span>
          )
        )}
      </span>
    )
  }
  if (typeof value === 'number') return <span className="hljs-number">{String(value)}</span>
  return <span className="hljs-literal">{String(value)}</span>
}

/**
 * Shows `fallback` if the tree throws. The walks are iterative and deep nodes
 * start folded, but Alt-unfolding a document thousands of levels deep still
 * builds a component tree as deep, and React's commit recurses through it. The
 * renderer has no error boundary of its own, so an overflow there would blank
 * the window instead of this preview.
 */
export class JsonTreeBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/** Parse for the tree, or `null` when the text is not JSON (show it as text). */
export function parseJsonForTree(text: string): { value: JsonValue } | null {
  try {
    return { value: JSON.parse(text) as JsonValue }
  } catch {
    return null
  }
}

/** Memoised `parseJsonForTree`. */
export function useParsedJson(text: string): { value: JsonValue } | null {
  return useMemo(() => parseJsonForTree(text), [text])
}
