import type { Components } from 'react-markdown'

// target="_blank" routes through setWindowOpenHandler in src/main/index.ts,
// which calls shell.openExternal and denies the in-app window open.
export const markdownComponents: Components = {
  a: ({ children, href, ...props }) => (
    <a {...props} href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  )
}

/**
 * The same, for a **document from a folder** rendered inside a card.
 *
 * A chat message is the only thing in its own region; a README or an `AGENT.md`
 * is not. Three differences follow, and each one is a bug that was live before
 * this map existed:
 *
 * - **Headings are demoted.** A README opening with `# Alpha` — the ordinary
 *   shape — emitted a second `<h1>` on a page whose title is already one, so
 *   the document outline claimed two top-level headings and a screen reader
 *   announced the folder's README title as the page. The page is `h1` and a
 *   card title is `h2`, so the document starts at `h3` and floors at `h6`.
 * - **Images render as their alt text.** The renderer's CSP is `img-src 'self'
 *   data:` and the card is not served from the agent's folder, so `![logo](…)`
 *   and shields.io badges — the two things a repository README opens with —
 *   could only ever be broken-image glyphs.
 * - **A link that goes nowhere is not a link.** `setWindowOpenHandler` opens
 *   `http(s)` externally and silently drops everything else, so a relative
 *   `[LICENSE](./LICENSE)` looked clickable and did nothing.
 */
export const documentMarkdownComponents: Components = {
  ...markdownComponents,
  h1: ({ children }) => <h3>{children}</h3>,
  h2: ({ children }) => <h4>{children}</h4>,
  h3: ({ children }) => <h5>{children}</h5>,
  h4: ({ children }) => <h6>{children}</h6>,
  h5: ({ children }) => <h6>{children}</h6>,
  h6: ({ children }) => <h6>{children}</h6>,
  img: ({ alt }) => (
    <span className="text-[var(--color-text-muted)] italic">{alt ? `[${alt}]` : '[image]'}</span>
  ),
  a: ({ children, href, ...props }) =>
    href && /^https?:\/\//i.test(href) ? (
      <a {...props} href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    ) : (
      <span title={href}>{children}</span>
    )
}

/** The document map, plus how `remarkHtmlCommentNotes` draws an author note. */
export const promptMarkdownComponents: Components = {
  ...documentMarkdownComponents,
  // A note, not a landmark: one `complementary` region per comment would
  // crowd a screen reader's landmark list with every scaffold hint.
  aside: ({ children }) => (
    <div
      role="note"
      aria-label="Author note"
      className="my-2 whitespace-pre-line border-l-2 border-[var(--color-border)] pl-2.5 italic text-[var(--color-text-muted)]"
    >
      {children}
    </div>
  )
}

/**
 * Drop raw HTML from a document before it is rendered.
 *
 * `react-markdown` neither runs nor hides raw HTML: with no `rehype-raw` it
 * **escapes** it, so an `AGENT.md` whose first line is
 * `<!-- generated; edit AGENT_SRC.md -->` showed that comment as its opening
 * sentence, and a README's centred `<p align="center"><img …></p>` badge block
 * arrived as a paragraph of visible markup. Every markdown viewer these files
 * are otherwise read in — the user's editor, the forge that hosts the folder —
 * hides both, so this matches them rather than inventing a third behaviour.
 *
 * A plain walk instead of `unist-util-visit`, which is not a declared
 * dependency here. `html` nodes exist only outside code: a fenced block's
 * contents are one `code` node, so nothing inside one is touched.
 */
interface MdastNode {
  type: string
  children?: MdastNode[]
}

export function remarkStripHtml() {
  const strip = (node: MdastNode): void => {
    if (!Array.isArray(node.children)) return
    node.children = node.children.filter((child) => child.type !== 'html')
    for (const child of node.children) strip(child)
  }
  return strip
}

interface MdastHtml extends MdastNode {
  value?: string
}

// One comment and nothing else: the body may not contain `-->`, so a line of
// two comments with markup between them is not read as one long note.
const COMMENT = /^\s*<!--((?:(?!-->)[\s\S])*)-->\s*$/

/**
 * `remarkStripHtml`, except that a block-level HTML comment survives as a
 * muted author note instead of disappearing.
 *
 * For the kit's prompt documents. Their scaffold opens with a comment telling
 * the author what to write — the one line that author most needs — and these
 * cards render the prompt rather than its source, so dropping comments the way
 * a README viewer does would hide it. A comment inside a sentence is still
 * dropped: a note is a block, and there is no block to put inside a paragraph.
 * Every other kind of raw HTML is dropped exactly as `remarkStripHtml` drops it.
 */
export function remarkHtmlCommentNotes() {
  const walk = (node: MdastNode): void => {
    if (!Array.isArray(node.children)) return
    const block = node.type === 'root' || node.type === 'blockquote' || node.type === 'listItem'
    node.children = node.children.flatMap((child): MdastNode[] => {
      if (child.type !== 'html') return [child]
      const comment = block ? COMMENT.exec((child as MdastHtml).value ?? '') : null
      // Reflowed: the comment's own line breaks are where its author's editor
      // wrapped, and kept they wrap a second time in a narrow card. Only a
      // blank line is a break the author meant.
      const text = comment?.[1].replace(/^[ \t]+/gm, '').trim().replace(/([^\n])\n(?!\n)/g, '$1 ')
      if (!text) return []
      return [{
        type: 'paragraph',
        data: { hName: 'aside' },
        children: [{ type: 'text', value: text } as MdastHtml]
      } as MdastNode]
    })
    for (const child of node.children) walk(child)
  }
  return walk
}
