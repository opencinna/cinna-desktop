import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { Components, ExtraProps } from 'react-markdown'
import { markdownComponents } from '../../utils/markdownComponents'
import type { TocEntry } from '../../utils/markdownToc'

/** The Contents panel's width, in px: what the card grows by when it opens. */
export const CONTENTS_PANEL_WIDTH = 240

/** The DOM id of the panel, for the Contents button's `aria-controls`. */
export const CONTENTS_PANEL_ID = 'file-preview-contents'

/**
 * How far below the body's top edge a heading still counts as the current
 * section. A clicked heading lands {@link HEADING_SCROLL_MARGIN} below it.
 */
const ACTIVE_OFFSET = 16
const HEADING_SCROLL_MARGIN = 8

/**
 * How long the pointer rests on a cut-off entry before its full text shows.
 * A native `title` waits about a second and cannot be made faster.
 */
export const FULL_TITLE_DELAY_MS = 250

type HeadingTag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'

function anchoredHeading(Tag: HeadingTag) {
  return function Heading({ node, ...props }: React.JSX.IntrinsicElements[HeadingTag] & ExtraProps) {
    return <Tag {...props} data-heading-line={node?.position?.start.line} />
  }
}

/**
 * The preview's markdown components: the chat's, with every heading carrying
 * its source line in `data-heading-line` — the key the Contents panel scrolls
 * to. Lines rather than slugs, because headings repeat ("Edge Cases" under
 * every section) and a line cannot. The tags are the ones `markdownComponents`
 * renders, unchanged. Chat rendering does not use this map.
 */
export const previewMarkdownComponents: Components = {
  ...markdownComponents,
  h1: anchoredHeading('h1'),
  h2: anchoredHeading('h2'),
  h3: anchoredHeading('h3'),
  h4: anchoredHeading('h4'),
  h5: anchoredHeading('h5'),
  h6: anchoredHeading('h6')
}

interface FilePreviewContentsProps {
  entries: TocEntry[]
  /** The scrolling body the headings live in. */
  bodyRef: RefObject<HTMLDivElement | null>
  /** Laid over the body's right edge, when the window is too narrow to widen the card. */
  overlay: boolean
  /**
   * Side by side: the panel's left edge, just right of the body. The widening
   * card uncovers it, so it never slides over the body while the width
   * animates.
   */
  left: number
}

/**
 * The Contents panel of a long markdown preview: one button per heading,
 * indented by depth, the current section in the accent colour.
 *
 * It fills its column at the body's full height and scrolls on its own. Only
 * the body is ever scrolled by a click — never the window, and never through
 * `scrollIntoView`, which would scroll every scrollable ancestor. The current
 * section is the last listed heading at or above the body's top edge (the
 * first when none is), recomputed once a frame while the body scrolls. A
 * clicked entry holds the highlight until the user scrolls by hand, so a
 * heading too near the end to reach the top still reads as where they went.
 */
export function FilePreviewContents({ entries, bodyRef, overlay, left }: FilePreviewContentsProps): React.JSX.Element {
  const navRef = useRef<HTMLElement>(null)
  const [active, setActive] = useState<number | null>(entries[0]?.line ?? null)
  /** The entry the user clicked, held until they scroll themselves. */
  const pinned = useRef<number | null>(null)
  const listed = useMemo(() => new Set(entries.map((entry) => entry.line)), [entries])
  const minDepth = useMemo(() => Math.min(...entries.map((entry) => entry.depth)), [entries])

  const compute = useCallback((): void => {
    const body = bodyRef.current
    if (!body || pinned.current !== null) return
    const edge = body.getBoundingClientRect().top + ACTIVE_OFFSET
    let current: number | null = null
    for (const heading of body.querySelectorAll<HTMLElement>('[data-heading-line]')) {
      const line = Number(heading.dataset.headingLine)
      if (!listed.has(line)) continue
      if (heading.getBoundingClientRect().top > edge) break
      current = line
    }
    setActive(current ?? entries[0]?.line ?? null)
  }, [bodyRef, listed, entries])

  useLayoutEffect(() => {
    pinned.current = null
    compute()
  }, [compute])

  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    let frame = 0
    const onScroll = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        compute()
      })
    }
    // Input that scrolls by hand releases a clicked entry's hold.
    const release = (): void => {
      pinned.current = null
    }
    const inputs = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const
    body.addEventListener('scroll', onScroll, { passive: true })
    for (const input of inputs) body.addEventListener(input, release, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      body.removeEventListener('scroll', onScroll)
      for (const input of inputs) body.removeEventListener(input, release)
    }
  }, [bodyRef, compute])

  // Keep the current entry visible in the panel, scrolling the panel only.
  useEffect(() => {
    const nav = navRef.current
    const item = active === null ? null : nav?.querySelector<HTMLElement>(`[data-toc-line="${active}"]`)
    if (!nav || !item) return
    const box = nav.getBoundingClientRect()
    const rect = item.getBoundingClientRect()
    if (rect.top < box.top) nav.scrollTop -= box.top - rect.top + 4
    else if (rect.bottom > box.bottom) nav.scrollTop += rect.bottom - box.bottom + 4
  }, [active])

  // The full text of a cut-off entry, under it, after a short rest.
  const [fullTitle, setFullTitle] = useState<{ text: string; top: number; right: number } | null>(null)
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideFullTitle = useCallback((): void => {
    clearTimeout(titleTimer.current ?? undefined)
    titleTimer.current = null
    setFullTitle(null)
  }, [])
  useEffect(() => hideFullTitle, [hideFullTitle])
  const showFullTitleSoon = (button: HTMLElement, text: string): void => {
    hideFullTitle()
    if (button.scrollWidth <= button.clientWidth) return
    titleTimer.current = setTimeout(() => {
      const rect = button.getBoundingClientRect()
      setFullTitle({ text, top: rect.bottom + 4, right: window.innerWidth - rect.right })
    }, FULL_TITLE_DELAY_MS)
  }

  const go = (line: number): void => {
    const body = bodyRef.current
    const heading = body?.querySelector<HTMLElement>(`[data-heading-line="${line}"]`)
    if (!body || !heading) return
    pinned.current = line
    setActive(line)
    const top =
      heading.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - HEADING_SCROLL_MARGIN
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    body.scrollTo({ top: Math.max(0, top), behavior: reduceMotion ? 'auto' : 'smooth' })
  }

  return (
    <nav
      ref={navRef}
      id={CONTENTS_PANEL_ID}
      aria-label="Contents"
      onScroll={hideFullTitle}
      style={overlay ? { width: CONTENTS_PANEL_WIDTH } : { width: CONTENTS_PANEL_WIDTH, left }}
      className={
        'absolute top-0 bottom-0 overflow-auto' +
        (overlay ? ' right-0' : '') +
        ' rounded-br-xl border-l border-[var(--color-border)] ' +
        'bg-[var(--color-bg-secondary)] px-2 py-3' +
        (overlay ? ' shadow-[-8px_0_16px_-4px_rgb(0_0_0/0.18)]' : '')
      }
    >
      <ul className="space-y-px">
        {entries.map((entry) => {
          const current = entry.line === active
          return (
            <li key={entry.line}>
              <button
                type="button"
                data-toc-line={entry.line}
                aria-current={current ? 'location' : undefined}
                onMouseEnter={(event) => showFullTitleSoon(event.currentTarget, entry.text)}
                onMouseLeave={hideFullTitle}
                onClick={() => go(entry.line)}
                style={{ paddingLeft: 8 + (entry.depth - minDepth) * 12 }}
                className={
                  'block w-full truncate rounded-md py-1 pr-2 text-left text-xs transition-colors ' +
                  'hover:bg-[var(--color-bg-hover)] ' +
                  (current
                    ? 'text-[var(--color-accent)] font-medium'
                    : entry.depth === minDepth
                      ? 'text-[var(--color-text)]'
                      : 'text-[var(--color-text-secondary)]')
                }
              >
                {entry.text}
              </button>
            </li>
          )
        })}
      </ul>
      {/* The button's own text already carries the full title for assistive
          technology; this is the sighted pointer's copy of it. */}
      {fullTitle &&
        createPortal(
          <div
            aria-hidden
            data-toc-full-title
            style={{ top: fullTitle.top, right: fullTitle.right }}
            className="pointer-events-none fixed z-[60] max-w-[420px] rounded-md border border-[var(--color-border)]
              bg-[var(--color-bg-tertiary)] px-2 py-1 text-xs text-[var(--color-text)] shadow-sm"
          >
            {fullTitle.text}
          </div>,
          document.body
        )}
    </nav>
  )
}
