import { useMemo } from 'react'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import { common, createLowlight } from 'lowlight'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import type { ElementContent, Root, RootContent } from 'hast'

/**
 * The grammars the preview highlights. lowlight is the engine behind
 * `rehype-highlight`, so a file is tokenised exactly like a fenced block of the
 * same language in chat, and coloured by the same `.hljs-*` palette in main.css.
 */
const lowlight = createLowlight({
  python: common.python,
  // HTML is `xml` to highlight.js; its <style> and <script> are coloured as
  // css and javascript only when those grammars are registered too.
  xml: common.xml,
  css: common.css,
  javascript: common.javascript
})

export type CodeLanguage = 'python' | 'xml'

/**
 * Above this many characters a file is shown as plain text, not highlighted:
 * highlighting builds a node per token in one synchronous pass, and a
 * multi-MB file stalled the window for seconds — tens of MB ran it out of
 * memory. Markdown shares the limit (its parse costs more still).
 */
export const MAX_HIGHLIGHT_CHARS = 1024 * 1024

/** A muted line above a preview body saying why it is shown the way it is. */
export function PreviewNote({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="mb-3 text-xs text-[var(--color-text-muted)]">{children}</div>
}

/** Why a file over {@link MAX_HIGHLIGHT_CHARS} is plain; markdown is formatted, not highlighted. */
export function plainTextNote(what: 'highlight' | 'format'): string {
  return `This file is too large to ${what}, so it is shown as plain text.`
}

/**
 * A source file as a highlighted, wrapped `<pre>`. Highlighting runs once per
 * text; a grammar failure falls back to the plain text rather than erroring,
 * so a truncated file still shows. Over {@link MAX_HIGHLIGHT_CHARS} the text
 * is plain from the start, under a note saying why, anchors kept. A caller
 * with its own reason passes `note`, shown instead, so one line explains.
 *
 * Each of `anchorLines` (1-based) starts with an empty `data-heading-line`
 * span: the marker the Contents panel scrolls to and tracks, as a markdown
 * heading carries it.
 */
export function CodePreview({
  text,
  language,
  anchorLines,
  note
}: {
  text: string
  language: CodeLanguage
  anchorLines?: readonly number[]
  note?: string
}): React.JSX.Element {
  const plain = text.length > MAX_HIGHLIGHT_CHARS
  const highlighted = useMemo(() => {
    if (plain) return anchorLines?.length ? plainWithAnchors(text, anchorLines) : text
    try {
      const tree = lowlight.highlight(language, text)
      if (anchorLines?.length) insertLineAnchors(tree, new Set(anchorLines))
      return toJsxRuntime(tree, { Fragment, jsx, jsxs })
    } catch {
      return text
    }
  }, [plain, text, language, anchorLines])

  return (
    <>
      {(note !== undefined || plain) && <PreviewNote>{note ?? plainTextNote('highlight')}</PreviewNote>}
      <pre
        data-testid="code-preview"
        className="text-xs font-mono whitespace-pre-wrap break-words
          text-[var(--color-text)]"
      >
        {highlighted}
      </pre>
    </>
  )
}

/**
 * `text` with an empty anchor span at the start of each wanted line, the rest
 * left as text. `anchorLines` is ascending, as an outline lists them; no
 * spread over it — a generated file can list more lines than a call takes.
 */
function plainWithAnchors(text: string, anchorLines: readonly number[]): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const lines = new Set(anchorLines)
  const last = anchorLines[anchorLines.length - 1]
  let from = 0
  let line = 1
  for (let at = 0; line <= last; ) {
    if (lines.has(line)) {
      if (at > from) out.push(text.slice(from, at))
      out.push(<span key={line} data-heading-line={line} />)
      from = at
    }
    const next = text.indexOf('\n', at)
    if (next === -1) break
    at = next + 1
    line++
  }
  out.push(text.slice(from))
  return out
}

function anchor(line: number): ElementContent {
  return { type: 'element', tagName: 'span', properties: { dataHeadingLine: line }, children: [] }
}

/**
 * Walks the highlighted tree in document order, counting newlines in its text,
 * and puts an anchor at the start of every wanted line. A text node that spans
 * a wanted line start is split there. Mutates `tree`.
 */
function insertLineAnchors(tree: Root, lines: ReadonlySet<number>): void {
  let line = 1
  const walk = (children: RootContent[]): RootContent[] => {
    const out: RootContent[] = []
    for (const child of children) {
      if (child.type === 'text') {
        const parts = child.value.split('\n')
        parts.forEach((part, i) => {
          if (i > 0) {
            out.push({ type: 'text', value: '\n' })
            line++
            if (lines.has(line)) out.push(anchor(line))
          }
          if (part) out.push({ type: 'text', value: part })
        })
      } else {
        if (child.type === 'element') child.children = walk(child.children) as ElementContent[]
        out.push(child)
      }
    }
    return out
  }
  tree.children = walk(tree.children)
  if (lines.has(1)) tree.children.unshift(anchor(1))
}
