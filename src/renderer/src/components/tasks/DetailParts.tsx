import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { markdownComponents } from '../../utils/markdownComponents'

/**
 * The pieces the task page's body is built from, shared with the job page so
 * the two read as one layout: a titled section, markdown prose, and the fact
 * rows of the Details panel.
 */

/** Classes for a Details value that opens something (§11: it must look like a control). */
export const DETAIL_LINK =
  'block max-w-full truncate text-right font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors'

/**
 * The box every page-header button shares — the job page's Run, Edit and ⋯ and
 * the task page's ⋯ — so they stand at one height whatever each holds: one
 * height, one border width, one line height. A filled button's border is its
 * own fill colour.
 */
export const HEADER_BUTTON =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-md border text-xs font-medium leading-4'

export function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section>
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">{title}</h2>
      {children}
    </section>
  )
}

export function Prose({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="text-xs text-[var(--color-text)] leading-relaxed markdown-body">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={markdownComponents}
      >
        {children}
      </Markdown>
    </div>
  )
}

/**
 * One fact: label on the left, value on the right. A fact with nothing to say
 * is **not rendered** rather than rendered with a dash: "Finished —" on a task
 * that is still running reads as an error where an absent row reads as what it
 * is — so callers leave the row out, and an empty value renders nothing too.
 */
export function Detail({
  label,
  children,
  wide = false
}: {
  label: string
  children: React.ReactNode
  /** The value takes the rest of the row, so a truncating child has a width to truncate against. */
  wide?: boolean
}): React.JSX.Element | null {
  if (children === null || children === undefined || children === '') return null
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3">
      <dt className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{label}</dt>
      <dd className={`m-0 min-w-0 break-words text-right text-xs text-[var(--color-text-secondary)] ${wide ? 'flex-1' : ''}`}>
        {children}
      </dd>
    </div>
  )
}
