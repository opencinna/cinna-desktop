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
const lowlight = createLowlight({ python: common.python })

export type CodeLanguage = 'python'

/**
 * A source file as a highlighted, wrapped `<pre>`. Highlighting runs once per
 * text; a grammar failure falls back to the plain text rather than erroring,
 * so a truncated file still shows.
 *
 * Each of `anchorLines` (1-based) starts with an empty `data-heading-line`
 * span: the marker the Contents panel scrolls to and tracks, as a markdown
 * heading carries it.
 */
export function CodePreview({
  text,
  language,
  anchorLines
}: {
  text: string
  language: CodeLanguage
  anchorLines?: readonly number[]
}): React.JSX.Element {
  const highlighted = useMemo(() => {
    try {
      const tree = lowlight.highlight(language, text)
      if (anchorLines?.length) insertLineAnchors(tree, new Set(anchorLines))
      return toJsxRuntime(tree, { Fragment, jsx, jsxs })
    } catch {
      return text
    }
  }, [text, language, anchorLines])

  return (
    <pre
      data-testid="code-preview"
      className="text-xs font-mono whitespace-pre-wrap break-words
        text-[var(--color-text)]"
    >
      {highlighted}
    </pre>
  )
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
