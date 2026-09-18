import { useMemo } from 'react'
import {
  commaSeparatedItems,
  linkifySegments,
  splitFrontmatter,
  type FrontmatterValue,
  type MarkdownWithFrontmatter
} from '../../utils/frontmatter'

/**
 * Split `text`'s frontmatter off for display: the card to put above the
 * markdown (or `null`), and the body to hand to `<Markdown>`.
 */
export function useFrontmatter(
  text: string,
  className?: string
): { card: React.JSX.Element | null; body: string } {
  const { frontmatter, body } = useMemo(() => splitFrontmatter(text), [text])
  // Nothing below the card, nothing to space it from: a message that is only
  // frontmatter would otherwise sit on a margin its bubble's padding doubles.
  const spacing = body.trim() === '' ? '' : className
  return {
    card: frontmatter ? <FrontmatterTable frontmatter={frontmatter} className={spacing} /> : null,
    body
  }
}

/**
 * A markdown document's frontmatter as a key/value card above its body.
 *
 * Its own bordered, tinted box, so it reads as the document's metadata and not
 * as its first table. The tint is the text colour at low opacity rather than a
 * surface token, so it darkens whatever it sits on — a grey fill read as a
 * slab pasted onto the coloured user bubble. A `<dl>` grid rather than a `<table>`: chat bubbles and
 * notes render it inside `.markdown-body`, whose table, `pre` and `code` rules
 * would otherwise restyle it. `http(s)` URLs in values are links, opened
 * externally the way markdown links are.
 */
export function FrontmatterTable({
  frontmatter,
  className = 'mb-5'
}: {
  frontmatter: NonNullable<MarkdownWithFrontmatter['frontmatter']>
  className?: string
}): React.JSX.Element | null {
  const { entries } = frontmatter
  if (entries.length === 0) return null

  return (
    <div
      data-testid="frontmatter"
      className={`rounded-lg border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-text)_5%,transparent)]
        overflow-hidden text-xs leading-normal ${className}`}
    >
      <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)]">
        {entries.map((entry, index) => {
          const rule = index > 0 ? 'border-t border-[var(--color-border)]' : ''
          return (
            <div key={index} className="contents">
              <dt
                className={`px-3 py-1.5 font-mono whitespace-nowrap
                  text-[var(--color-text-secondary)] ${rule}`}
              >
                {entry.key}
              </dt>
              <dd className={`m-0 px-3 py-1.5 text-[var(--color-text)] [overflow-wrap:anywhere] ${rule}`}>
                <FrontmatterValueView value={entry.value} />
              </dd>
            </div>
          )
        })}
      </dl>
    </div>
  )
}

function FrontmatterValueView({ value }: { value: FrontmatterValue }): React.JSX.Element {
  if (value.kind === 'raw') return <RawBlock text={value.text} />
  const items = value.kind === 'list' ? value.items : commaSeparatedItems(value.text)
  if (items) {
    return (
      <span className="flex flex-wrap gap-1">
        {items.map((item, index) => (
          // Outlined, not filled: a filled mono pill is what a clickable
          // file reference looks like in an agent's chat.
          <span
            key={index}
            className="rounded border border-[var(--color-border)] px-1.5 font-mono text-[11px]"
          >
            <Linkified text={item} />
          </span>
        ))}
      </span>
    )
  }
  return (
    <span className="whitespace-pre-wrap">
      <Linkified text={value.kind === 'text' ? value.text : ''} />
    </span>
  )
}

function RawBlock({ text, className = '' }: { text: string; className?: string }): React.JSX.Element {
  return (
    <div className={`whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[11px] ${className}`}>
      <Linkified text={text} />
    </div>
  )
}

function Linkified({ text }: { text: string }): React.JSX.Element {
  return (
    <>
      {linkifySegments(text).map((segment, index) =>
        segment.href ? (
          // target="_blank" routes through setWindowOpenHandler in
          // src/main/index.ts, which opens http(s) with shell.openExternal.
          <a
            key={index}
            href={segment.href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[var(--color-accent)] underline underline-offset-2"
          >
            {segment.text}
          </a>
        ) : (
          <span key={index}>{segment.text}</span>
        )
      )}
    </>
  )
}
