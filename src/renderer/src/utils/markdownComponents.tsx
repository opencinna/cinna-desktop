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
