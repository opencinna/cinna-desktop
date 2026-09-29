import { useContext, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, ChevronRight, Terminal, Wrench } from 'lucide-react'
import { TranscriptVisibleContext, useTranscriptDisclosure } from './transcriptExpansion'
import { usePopover, type PopoverPlacement } from '../ui/usePopover'
import { HOVER_CLOSE_DELAY_MS } from '../ui/useHoverPopover'
import type { ToolStepPreview } from '../../utils/toolStepPairs'

export type CollapsibleStatus = 'pending' | 'done' | 'error'
/**
 * Only tool-ish steps fold into a dots group. Thinking is a standalone block
 * in every mode: folded in, a long agent turn read as one row of dots.
 */
export type CollapsibleKind = 'tool_narration' | 'tool_call' | 'tool_result'

export interface CollapsibleGroupItem {
  key: string
  /** A combined call/result still represents a compact step when alone. */
  groupWhenAlone?: boolean
  kind: CollapsibleKind
  status?: CollapsibleStatus
  isLive?: boolean
  /**
   * Shared by a call's dot and its output's dot (`pairToolSteps`), so hovering
   * either marks both. Unset for a dot that is a whole step on its own.
   */
  pairKey?: string
  /**
   * What hovering the dot shows, already cut to size. A function, called only
   * for the dot being previewed: items are rebuilt on every streaming chunk.
   */
  preview: () => ToolStepPreview
  node: React.ReactNode
}

interface CollapsibleGroupProps {
  items: CollapsibleGroupItem[]
}

function dotClass(item: CollapsibleGroupItem): string {
  if (item.status === 'pending') return 'bg-[var(--color-warning)]/45'
  if (item.status === 'error') return 'bg-[var(--color-danger)]/45'
  if (item.status === 'done') return 'bg-[var(--color-success)]/45'
  return 'bg-[var(--color-text-muted)]/50'
}

/** Hover this long on a dot before the first preview opens; after that, switching dots takes only {@link DOT_PREVIEW_SWITCH_DELAY_MS}. */
export const DOT_PREVIEW_OPEN_DELAY_MS = 300
/**
 * Once open, the pointer rests this long on another dot before the preview
 * switches to it: long enough that crossing dots on the way into the tooltip
 * leaves it alone, short enough that scrubbing still feels immediate.
 */
export const DOT_PREVIEW_SWITCH_DELAY_MS = 80
/** One width for every step, so scrubbing does not resize it sideways. */
const PREVIEW_WIDTH = 420
/** How far left of the hovered dot's centre the preview starts. */
const PREVIEW_NUDGE = 16
const PREVIEW_MAX_HEIGHT = 360
/** Below this much room above the row, the preview opens below it instead (if there is more room there). */
const PREVIEW_MIN_ROOM = 200
/** usePopover's gaps between the row and the preview, plus its window-edge margin. */
const ABOVE_GAP = 8
const BELOW_GAP = 4
const EDGE = 8

/**
 * The dots row's hover preview: one tooltip for the whole group, showing the
 * step under the pointer (or the one picked with the arrow keys).
 *
 * Not `useHoverPopover`: that is one trigger with one popover and a click that
 * pins it, and here there are many dots, the click belongs to expand/collapse,
 * and the content follows the dot. Placement is `usePopover`'s, anchored to the
 * row; the close delay is the hook's.
 *
 * - The first open waits {@link DOT_PREVIEW_OPEN_DELAY_MS} on a dot; once open,
 *   resting {@link DOT_PREVIEW_SWITCH_DELAY_MS} on another dot switches the
 *   content (scrubbing), and the preview follows that dot sideways.
 * - Leaving the dots and the tooltip closes it after `HOVER_CLOSE_DELAY_MS`,
 *   so the pointer can cross onto the tooltip to scroll or select output.
 *   Inside it only a real pointer move counts, as in `useHoverPopover`.
 * - It opens above the row when there is room, below it otherwise, anchored
 *   by the edge facing the row: output that streams in while it is open grows
 *   it away from the row, never over the dot under the pointer (`ux_rules.md` §1).
 * - Escape, expanding the group, and a scroll that moves the row close it.
 */
function useDotPreview(items: CollapsibleGroupItem[], expanded: boolean) {
  const [layout, setLayout] = useState<{ placement: PopoverPlacement; maxHeight: number }>({
    placement: 'above-left',
    maxHeight: PREVIEW_MAX_HEIGHT
  })
  const popover = usePopover<HTMLButtonElement, HTMLDivElement>(layout.placement)
  const { open, setOpen, triggerRef, popoverRef } = popover
  const [activeKey, setActiveKey] = useState<string | null>(null)
  /** The preview's left edge, beside the dot it shows; `usePopover` only knows the row. */
  const [anchorLeft, setAnchorLeft] = useState<number | null>(null)
  const openRef = useRef(open)
  openRef.current = open
  /** The dot under the pointer. */
  const hoverKey = useRef<string | null>(null)
  /** The pointer has moved inside the tooltip and not left it. */
  const inside = useRef(false)
  /** Opened with the arrow keys on the focused header. */
  const keyboard = useRef(false)
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  const switchTimer = useRef<number | null>(null)

  const clearTimer = (timer: React.RefObject<number | null>): void => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }

  /**
   * Preview `key`, placed at its dot: the pointer then reaches the preview by
   * moving straight off the dot, not across the rest of the row.
   */
  const activate = (key: string): void => {
    const dot = Array.from(triggerRef.current?.querySelectorAll<HTMLElement>('[data-step-dot]') ?? [])
      .find((el) => el.getAttribute('data-step-dot') === key)
    if (dot) {
      const r = dot.getBoundingClientRect()
      const width = Math.min(PREVIEW_WIDTH, window.innerWidth - 2 * EDGE)
      const left = r.left + r.width / 2 - PREVIEW_NUDGE
      setAnchorLeft(Math.max(EDGE, Math.min(left, window.innerWidth - width - EDGE)))
    }
    setActiveKey(key)
  }

  const close = (): void => {
    clearTimer(openTimer)
    clearTimer(closeTimer)
    clearTimer(switchTimer)
    hoverKey.current = null
    inside.current = false
    keyboard.current = false
    setActiveKey(null)
    setOpen(false)
  }

  const show = (key: string): void => {
    clearTimer(openTimer)
    clearTimer(closeTimer)
    if (!openRef.current) {
      // Where it fits is decided once, at opening: flipping sides while it
      // is open would be exactly the jump the anchoring is there to prevent.
      const r = triggerRef.current?.getBoundingClientRect()
      const vh = window.innerHeight
      const above = r ? r.top - ABOVE_GAP - EDGE : vh
      const below = r ? vh - r.bottom - BELOW_GAP - EDGE : 0
      const useAbove = above >= PREVIEW_MIN_ROOM || above >= below
      setLayout({
        placement: useAbove ? 'above-left' : 'below-left',
        maxHeight: Math.max(0, Math.min(PREVIEW_MAX_HEIGHT, useAbove ? above : below))
      })
    }
    activate(key)
    setOpen(true)
  }

  const closeSoon = (): void => {
    clearTimer(closeTimer)
    if (hoverKey.current !== null || inside.current || keyboard.current) return
    closeTimer.current = window.setTimeout(close, HOVER_CLOSE_DELAY_MS)
  }

  // However it closed (usePopover's outside click among them), start fresh.
  useEffect(() => {
    if (open) return
    inside.current = false
    keyboard.current = false
    setActiveKey(null)
  }, [open])

  const activeItem = activeKey !== null ? items.find((it) => it.key === activeKey) : undefined

  // The previewed step is gone (its key changed when the turn was saved): the
  // dot under the pointer went with it, without a mouseleave, so nothing else
  // would close it, and the Escape handler below would keep swallowing keys.
  useEffect(() => {
    if (open && activeKey !== null && !activeItem) close()
  }, [open, activeKey, activeItem])

  // Expanded, every step is on screen: nothing left to preview.
  useEffect(() => {
    if (expanded) close()
  }, [expanded])

  // Escape first, at document level, so the composer's Esc Esc does not see a
  // key press that meant "close this" (as in `useHoverPopover`).
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      close()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open])

  // Placed once, when it opened: a scroll of anything holding the row leaves
  // it beside nothing. A scroll inside the tooltip holds no row and is ignored.
  useEffect(() => {
    if (!open) return
    const onScroll = (event: Event): void => {
      if (event.target instanceof Node && !event.target.contains(triggerRef.current)) return
      close()
    }
    // A resize moves the centred transcript sideways; the preview's left edge
    // was measured from its dot and would be left behind.
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
    }
  }, [open, triggerRef])

  useEffect(() => () => {
    clearTimer(openTimer)
    clearTimer(closeTimer)
    clearTimer(switchTimer)
  }, [])

  const visible = open && !expanded && !!activeItem && !!popover.style

  return {
    triggerRef,
    popoverRef,
    activeItem: visible ? activeItem : undefined,
    style: popover.style && anchorLeft !== null ? { ...popover.style, left: anchorLeft } : popover.style,
    maxHeight: layout.maxHeight,
    dotProps: (key: string) => ({
      onMouseEnter: (): void => {
        if (expanded) return
        hoverKey.current = key
        clearTimer(closeTimer)
        if (openRef.current) {
          clearTimer(switchTimer)
          switchTimer.current = window.setTimeout(() => {
            switchTimer.current = null
            if (hoverKey.current === key) activate(key)
          }, DOT_PREVIEW_SWITCH_DELAY_MS)
          return
        }
        clearTimer(openTimer)
        openTimer.current = window.setTimeout(() => {
          openTimer.current = null
          if (hoverKey.current !== null) show(hoverKey.current)
        }, DOT_PREVIEW_OPEN_DELAY_MS)
      },
      onMouseLeave: (): void => {
        hoverKey.current = null
        clearTimer(openTimer)
        clearTimer(switchTimer)
        closeSoon()
      }
    }),
    headerProps: {
      onKeyDown: (event: React.KeyboardEvent): void => {
        if (expanded || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
        if (items.length === 0) return
        event.preventDefault()
        const at = activeItem && openRef.current ? items.indexOf(activeItem) : -1
        const next =
          at === -1
            ? event.key === 'ArrowRight' ? 0 : items.length - 1
            : Math.max(0, Math.min(items.length - 1, at + (event.key === 'ArrowRight' ? 1 : -1)))
        keyboard.current = true
        show(items[next].key)
      },
      onBlur: (): void => {
        keyboard.current = false
        closeSoon()
      }
    },
    popoverHandlers: {
      onPointerMove: (): void => {
        if (inside.current) return
        inside.current = true
        clearTimer(closeTimer)
      },
      onMouseLeave: (): void => {
        inside.current = false
        closeSoon()
      }
    }
  }
}

/** The step behind a dot: the call on top, its output under it. */
function DotPreviewCard({ preview }: { preview: ToolStepPreview }): React.JSX.Element {
  // A call always says what came back, "No output" included: a missing line
  // reads as if the preview were cut short.
  const hasOutput = preview.hasCall || preview.output !== undefined || !!preview.running
  const both = preview.hasCall && hasOutput
  // The half the hovered dot stands for is full strength; the other half is context.
  const dimCall = both && preview.focus === 'output'
  const dimOutput = both && preview.focus === 'call'
  const stderr = preview.outputStream === 'stderr'
  return (
    <>
      {preview.hasCall && (
        <div data-preview-section="call" data-dimmed={dimCall ? '' : undefined} className={dimCall ? 'opacity-60' : undefined}>
          <div className="flex items-center gap-1 text-[var(--color-text-secondary)]">
            <Wrench size={10} className="shrink-0" aria-hidden="true" />
            <span className="font-mono text-[var(--color-accent)] truncate">{preview.toolName ?? 'Tool'}</span>
          </div>
          {preview.input && (
            <pre className="mt-1 font-mono text-[11px] leading-snug whitespace-pre-wrap break-words text-[var(--color-text)]">
              {preview.input}
            </pre>
          )}
          {preview.narration && (
            <p className="mt-1 text-[10px] leading-snug line-clamp-3 break-words text-[var(--color-text-muted)]">
              {preview.narration}
            </p>
          )}
        </div>
      )}
      {hasOutput && (
        <div
          data-preview-section="output"
          data-dimmed={dimOutput ? '' : undefined}
          className={`${preview.hasCall ? 'mt-2 pt-2 border-t border-[var(--color-border)]' : ''} ${dimOutput ? 'opacity-60' : ''}`}
        >
          {/* Worded and drawn as the expanded ToolResultBlock is. */}
          <div className={`flex items-center gap-1 text-[10px] ${stderr ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'}`}>
            {stderr ? <AlertTriangle size={10} className="shrink-0" aria-hidden="true" /> : <Terminal size={10} className="shrink-0" aria-hidden="true" />}
            {stderr ? 'stderr' : 'Output'}
          </div>
          {preview.output ? (
            <>
              <pre
                className={`mt-1 font-mono text-[11px] leading-snug whitespace-pre-wrap break-words ${
                  stderr ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-secondary)]'
                }`}
              >
                {preview.output}
              </pre>
              {preview.outputMoreLines ? (
                <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">
                  … {preview.outputMoreLines} more {preview.outputMoreLines === 1 ? 'line' : 'lines'}
                </div>
              ) : null}
            </>
          ) : (
            <div className="mt-1 text-[11px] italic text-[var(--color-text-muted)]">
              {preview.running ? 'Running…' : 'No output'}
            </div>
          )}
        </div>
      )}
    </>
  )
}

export function CollapsibleGroup({ items }: CollapsibleGroupProps): React.JSX.Element {
  const [expanded, setExpanded] = useTranscriptDisclosure(false)
  const visible = useContext(TranscriptVisibleContext)
  const preview = useDotPreview(items, expanded)
  const tooltipId = useId()
  const active = preview.activeItem
  const isPreviewed = (it: CollapsibleGroupItem): boolean =>
    !!active && (it.key === active.key || (!!active.pairKey && it.pairKey === active.pairKey))

  return (
    <div className="rounded-lg">
      <button
        ref={preview.triggerRef}
        type="button"
        data-group-header
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={preview.headerProps.onKeyDown}
        onBlur={preview.headerProps.onBlur}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${items.length} ${items.length === 1 ? 'step' : 'steps'}`}
        aria-describedby={active ? tooltipId : undefined}
        className="inline-flex items-start gap-1.5 px-2 py-1 rounded-md max-w-full
          text-[var(--color-text-muted)]
          hover:text-[var(--color-text-secondary)]
          hover:bg-[var(--color-bg-secondary)]/60
          transition-colors"
      >
        <ChevronRight
          size={11}
          className={`shrink-0 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
        />
        {/* Dots wrap within the transcript width rather than scrolling it
            sideways. The 1.5px vertical padding makes each 8px row as tall as
            the 11px chevron, so the chevron sits level with the first row and
            a single row keeps its old height. */}
        <span className="flex flex-wrap items-center gap-1 min-w-0 py-[1.5px]">
          {items.map((it) => {
            const animate = it.status === 'pending' || it.isLive
            const previewed = isPreviewed(it)
            // A ring and an opacity: neither changes the dot's size, so the
            // row never reflows under the pointer while scrubbing.
            return (
              <span
                key={it.key}
                data-step-dot={it.key}
                data-previewed={previewed ? '' : undefined}
                {...preview.dotProps(it.key)}
                className={`relative inline-flex w-2 h-2 transition-opacity ${active && !previewed ? 'opacity-50' : ''}`}
              >
                {animate && (
                  <span
                    className={`absolute inset-0 rounded-full opacity-60 animate-ping ${dotClass(it)}`}
                  />
                )}
                <span
                  className={`relative inline-block w-2 h-2 rounded-full ${dotClass(it)} ${
                    previewed ? 'ring-1 ring-[var(--color-text-secondary)]' : ''
                  }`}
                />
              </span>
            )
          })}
        </span>
      </button>
      {active && preview.style &&
        createPortal(
          <div
            ref={preview.popoverRef}
            id={tooltipId}
            // Text to read, select and copy — no control inside, so a tooltip
            // rather than a dialog (`useHoverPopover` explains the difference).
            role="tooltip"
            data-dot-preview
            onPointerMove={preview.popoverHandlers.onPointerMove}
            onMouseLeave={preview.popoverHandlers.onMouseLeave}
            style={{ ...preview.style, maxHeight: preview.maxHeight }}
            className="z-50 w-[min(420px,calc(100vw-16px))] overflow-y-auto select-text
              rounded-lg border border-[var(--color-border)] bg-[var(--color-overlay-panel)] backdrop-blur-xl
              px-2.5 py-2 shadow-xl text-[11px]"
          >
            <DotPreviewCard preview={active.preview()} />
          </div>,
          document.body
        )}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-out"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
        aria-hidden={!expanded}
      >
        <div className="overflow-hidden">
          <div
            className={`space-y-2 mt-1.5 transition-opacity duration-200 ${
              expanded ? 'opacity-100' : 'opacity-0'
            }`}
          >
            <TranscriptVisibleContext.Provider value={visible && expanded}>
              {items.map((it) => (
                <div key={it.key}>{it.node}</div>
              ))}
            </TranscriptVisibleContext.Provider>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * A render slot: either a standalone block (`plain`) or a collapsible block
 * (`collapsible`) that {@link groupConsecutiveCollapsibles} may fold into a
 * dots group. Shared by the main transcript ({@link MessageStream}) and the
 * agent sub-thread ({@link AgentContribution}) so both collapse consecutive
 * auxiliary steps identically.
 */
export type RenderNode =
  | { slot: 'plain'; key: string; node: React.ReactNode }
  | { slot: 'collapsible'; item: CollapsibleGroupItem }

/** Group consecutive auxiliary nodes, plus combined steps that request grouping alone. */
export function groupConsecutiveCollapsibles(nodes: RenderNode[]): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let i = 0
  while (i < nodes.length) {
    const n = nodes[i]
    if (n.slot !== 'collapsible') {
      out.push(<div key={n.key}>{n.node}</div>)
      i++
      continue
    }
    let j = i
    while (j < nodes.length && nodes[j].slot === 'collapsible') j++
    const run = nodes.slice(i, j) as Extract<RenderNode, { slot: 'collapsible' }>[]
    if (run.length >= 2 || run[0].item.groupWhenAlone) {
      out.push(
        <CollapsibleGroup key={`group-${run[0].item.key}`} items={run.map((r) => r.item)} />
      )
    } else {
      out.push(<div key={run[0].item.key}>{run[0].item.node}</div>)
    }
    i = j
  }
  return out
}
