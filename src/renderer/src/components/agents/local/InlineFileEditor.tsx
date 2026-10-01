import { useLayoutEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AlertTriangle, Clock } from 'lucide-react'
import {
  documentMarkdownComponents,
  promptMarkdownComponents,
  remarkHtmlCommentNotes,
  remarkStripHtml
} from '../../../utils/markdownComponents'
import { useFrontmatter } from '../../ui/FrontmatterTable'
import type { AgentFileEditor } from '../../../hooks/useLocalAgents'

interface InlineFileEditorProps {
  editor: AgentFileEditor
  placeholder: string
  /** Render as markdown when not focused. Off for one-liners. */
  markdown?: boolean
  minRows?: number
  /**
   * What to say when the file is not in the folder.
   *
   * The default names the scaffolder, which is right for a kit agent and
   * nonsense for a bare one — that folder was never scaffolded and never will
   * be, so "run the agent's scaffold again" is an instruction the reader cannot
   * follow (ux_rules rule 7).
   */
  missingNote?: string
  /**
   * Keep block-level HTML comments as muted author notes instead of dropping
   * them — see `remarkHtmlCommentNotes`. Only meaningful with `markdown`.
   */
  commentNotes?: boolean
  /**
   * Show at most `CLIPPED_HEIGHT` of the rendered view. The parent owns the
   * toggle; this component reports whether there is anything to toggle.
   */
  clipped?: boolean
  /** Whether the rendered view is taller than `CLIPPED_HEIGHT`. */
  onOverflowChange?: (overflows: boolean) => void
  /** The click that starts editing — a clipped card opens up to be edited. */
  onEditStart?: () => void
  /**
   * The card's own title. A document that opens with exactly this as its `#`
   * heading (every kit prompt does) renders without it: the card already says
   * it, and on a clipped card it would spend a line of the ten saying nothing.
   * The textarea still shows the file's own bytes.
   */
  cardTitle?: string
}

/**
 * Where in the source the user clicked on its rendered form: the clicked text
 * node's text, found in the source, plus the offset into it. Null when the
 * click was not on text or the text is not in the source verbatim (markdown
 * escapes, a frontmatter cell) — the caller then falls back.
 */
function sourceOffsetAt(x: number, y: number, source: string): number | null {
  const range = document.caretRangeFromPoint?.(x, y)
  const node = range?.startContainer
  if (!range || !node || node.nodeType !== Node.TEXT_NODE) return null
  const text = node.textContent ?? ''
  if (text.trim() === '') return null
  const at = source.indexOf(text)
  return at < 0 ? null : at + range.startOffset
}

interface HeadingNode {
  type: string
  depth?: number
  value?: string
  children?: HeadingNode[]
}

const plainText = (node: HeadingNode): string =>
  node.value ?? (node.children ?? []).map(plainText).join('')

/** Drops a leading `# <title>` — see `cardTitle`. */
function remarkDropTitle(title: string | undefined) {
  return () => (tree: HeadingNode): void => {
    const first = tree.children?.[0]
    if (!title || !first || first.type !== 'heading' || first.depth !== 1) return
    if (plainText(first).trim().toLowerCase() === title.trim().toLowerCase()) tree.children!.shift()
  }
}

/**
 * Ten lines of the `text-xs leading-relaxed` body. Written as a multiple of the
 * leading, not a measured pixel count (ux_rules rule 12): 0.75rem × 1.625 × 10.
 */
export const CLIPPED_HEIGHT = '12.1875rem'

/**
 * The Notes inline-editor pattern, over a file in an agent folder: no edit
 * mode, no Save button, click to type, autosave on the pause and on blur.
 *
 * The one thing it adds is the reload prompt. The folder is shared with the
 * user's coding assistant, so a save can be refused because the file changed
 * underneath — and the right answer to that is never a retry. The banner keeps
 * the user's text visible, shows what the folder now holds, and makes taking
 * one or re-applying the other an explicit choice.
 */
export function InlineFileEditor({
  editor,
  placeholder,
  markdown = true,
  minRows = 6,
  missingNote,
  commentNotes = false,
  clipped = false,
  onOverflowChange,
  onEditStart,
  cardTitle
}: InlineFileEditorProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  /**
   * The rendered view, measured at the moment it is replaced.
   *
   * Rendered markdown and the raw source are different heights, so the click
   * that starts editing used to resize the card under the pointer (rule 1) —
   * invisible while both views were the same monospace text, and a visible jerk
   * as soon as `AGENT.md` began rendering. The floor holds the card at the
   * height the user clicked; a file whose source genuinely needs more lines
   * than its rendered form still grows, which is the one direction that cannot
   * be avoided without hiding text from the person editing it.
   */
  const renderedRef = useRef<HTMLDivElement>(null)
  const [floor, setFloor] = useState<number | undefined>(undefined)
  const rendered = useFrontmatter(editor.text, 'mb-3')
  const [overflows, setOverflows] = useState(false)
  const onOverflowRef = useRef(onOverflowChange)
  onOverflowRef.current = onOverflowChange
  // Measured against the clip whether or not it is applied, so an expanded
  // card still knows it has something to collapse. The inner node is measured,
  // not the clipping box: its height is the document's at any clip.
  const contentRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = contentRef.current
    if (!el || editing) return
    const limit = (): number => parseFloat(CLIPPED_HEIGHT) * parseFloat(getComputedStyle(document.documentElement).fontSize)
    const measure = (): void => {
      const next = el.getBoundingClientRect().height > limit() + 1
      setOverflows(next)
      onOverflowRef.current?.(next)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [editing, editor.text, markdown])

  const startEditing = (e?: React.MouseEvent): void => {
    // A link opens externally; it is not also a request to edit the file.
    if (e && (e.target as HTMLElement).closest('a')) return
    if (!editor.canSave) return
    const rendered = renderedRef.current
    setFloor(rendered ? rendered.getBoundingClientRect().height : undefined)
    // The caret goes where the user clicked. It used to go to the end, which
    // on a clipped card is a screen or more below the click: the textarea
    // opens at full height and the first keystroke scrolled the page there.
    // Without a usable click point, a clipped document starts at its top.
    const clickedAt = e ? sourceOffsetAt(e.clientX, e.clientY, editor.text) : null
    const caret = clickedAt ?? (clipped && overflows ? 0 : editor.text.length)
    setEditing(true)
    onEditStart?.()
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus({ preventScroll: true })
      el.setSelectionRange(caret, caret)
    })
  }

  const conflictBanner = editor.conflict ? (
    <div
      role="alert"
      className="mb-2 rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-2.5 py-2"
    >
      <div className="flex items-start gap-1.5 text-[10px] text-[var(--color-text-secondary)]">
        <AlertTriangle size={12} className="mt-px shrink-0 text-[var(--color-warning)]" />
        <div className="min-w-0 flex-1">
          <div className="text-[var(--color-text)]">
            {editor.conflict === 'refused'
              ? 'This file changed on disk, so your save was refused.'
              : 'This file changed on disk while you were editing it.'}
          </div>
          <div className="mt-0.5">
            Your text is still here and nothing was overwritten. Copy anything you want to keep,
            then reload to take what is on disk.
          </div>
          {editor.diskText !== null && (
            <details className="mt-1">
              <summary className="cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]">
                Show what the file says now
              </summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-[var(--color-bg)] p-2 font-mono text-[10px] text-[var(--color-text-secondary)]">
                {editor.diskText}
              </pre>
            </details>
          )}
        </div>
        <button
          type="button"
          onClick={editor.reload}
          className="shrink-0 rounded-md bg-[var(--color-bg-tertiary)] px-2 py-1 text-[10px] font-medium
            text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
        >
          Reload
        </button>
      </div>
    </div>
  ) : null

  const errorBanner = editor.error ? (
    <div role="alert" className="mb-2 text-[10px] text-[var(--color-danger)]">
      {editor.error}
    </div>
  ) : null

  // Not an error and not a conflict — a "not yet". The agent is running, the
  // desktop must not write into its folder mid-turn (Invariant 3), and the same
  // save goes out again on its own once the run ends. Said quietly, because
  // nothing is wrong and nothing is lost.
  const blockedNote =
    editor.blocked && !editor.conflict ? (
      <div className="mb-2 flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
        <Clock size={11} className="shrink-0" />
        This agent is running. Your changes are saved as soon as it finishes.
      </div>
    ) : null

  // The fade says "there is more" on the card itself; the parent's toggle is
  // the control that shows it.
  const clipStyle: React.CSSProperties | undefined =
    clipped && overflows
      ? {
          maxHeight: CLIPPED_HEIGHT,
          overflow: 'hidden',
          maskImage: 'linear-gradient(to bottom, black 70%, transparent)',
          WebkitMaskImage: 'linear-gradient(to bottom, black 70%, transparent)'
        }
      : undefined

  if (!editor.canSave) {
    return (
      <div className="text-[10px] text-[var(--color-text-muted)] italic">
        {missingNote ??
          "This file is not in the folder. Add it with your assistant, or run the agent's scaffold again."}
      </div>
    )
  }

  return (
    <div>
      {conflictBanner}
      {blockedNote}
      {errorBanner}
      {editing ? (
        <textarea
          ref={textareaRef}
          value={editor.text}
          onChange={(e) => editor.setText(e.target.value)}
          onBlur={() => {
            setEditing(false)
            editor.flushNow()
          }}
          placeholder={placeholder}
          rows={Math.max(minRows, editor.text.split('\n').length + 1)}
          style={floor === undefined ? undefined : { minHeight: floor }}
          className="w-full resize-none border-none bg-transparent font-mono text-xs leading-relaxed
            text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]"
        />
      ) : editor.text.trim() === '' ? (
        <div
          onClick={startEditing}
          className="cursor-text text-[10px] italic text-[var(--color-text-muted)]"
        >
          {placeholder}
        </div>
      ) : markdown ? (
        <div
          ref={renderedRef}
          onClick={startEditing}
          style={clipStyle}
          className="markdown-body cursor-text text-xs leading-relaxed text-[var(--color-text)]"
        >
          <div ref={contentRef}>
          {/*
            The document map, not the chat one: these are files, and a file that
            opens with `# Name` would otherwise put a second `h1` on a page that
            already has one. Raw HTML is dropped the way every other viewer of
            these files drops it — and the click that starts editing puts the
            file's own bytes, comments and all, in the textarea.
          */}
          {rendered.card}
          <Markdown
            remarkPlugins={[remarkGfm, commentNotes ? remarkHtmlCommentNotes : remarkStripHtml, remarkDropTitle(cardTitle)]}
            components={commentNotes ? promptMarkdownComponents : documentMarkdownComponents}
          >
            {rendered.body}
          </Markdown>
          </div>
        </div>
      ) : (
        <div
          ref={renderedRef}
          onClick={startEditing}
          style={clipStyle}
          className="cursor-text whitespace-pre-wrap text-xs leading-relaxed text-[var(--color-text)]"
        >
          <div ref={contentRef}>{editor.text}</div>
        </div>
      )}
    </div>
  )
}
