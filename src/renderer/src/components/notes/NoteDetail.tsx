import { useEffect, useRef, useState } from 'react'
import Markdown, { type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { useUIStore } from '../../stores/ui.store'
import { FALLBACK_TITLE, useAutosaveNote, useNote } from '../../hooks/useNotes'
import { markdownComponents } from '../../utils/markdownComponents'
import { remarkNoteFormat } from '../../utils/noteFormat/remarkNoteFormat'
import { keepLineEndings, toTextareaValue } from '../../utils/noteFormat/lineEndings'
import { useFrontmatter } from '../ui/FrontmatterTable'

type PluggableList = NonNullable<Options['remarkPlugins']>

// `#tag` pills here are links to the sidebar's tag filter.
const REMARK_PLUGINS: PluggableList = [remarkGfm, [remarkNoteFormat, { tagLinks: true }]]

/**
 * Inline editor — no edit-mode toggle, no Save button. Title is an always-on
 * heading-styled input; body shows rendered markdown by default and swaps to
 * a focused textarea on click, blurring back to rendered. Autosave + the
 * cross-note flush live in `useAutosaveNote` so the component can stay
 * focused on layout and the edit/render mode swap.
 */
export function NoteDetail(): React.JSX.Element {
  const activeNoteId = useUIStore((s) => s.activeNoteId)
  const setNotesTagFilter = useUIStore((s) => s.setNotesTagFilter)
  const setSidebarTab = useUIStore((s) => s.setSidebarTab)
  const { data: note, isLoading } = useNote(activeNoteId)
  const { title, body, setTitle, setBody, flushNow } = useAutosaveNote(note)
  const [editingBody, setEditingBody] = useState(false)
  const bodyTextareaRef = useRef<HTMLTextAreaElement>(null)
  const rendered = useFrontmatter(body, 'mb-4')
  // Visually blank the title input on first focus when it still holds the
  // placeholder default, so the user can type their title without first
  // deleting "Untitled note". Tracked per-note: reset when the active note
  // changes, and as soon as the user actually edits the title.
  const [hideDefaultTitle, setHideDefaultTitle] = useState(false)
  useEffect(() => {
    setHideDefaultTitle(false)
  }, [activeNoteId])

  if (!activeNoteId) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-[var(--color-text-muted)]">
        Select a note to view.
      </div>
    )
  }

  if (isLoading || !note) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-[var(--color-text-muted)]">
        Loading…
      </div>
    )
  }

  /** A `#tag` pill shows the notes carrying that tag in the sidebar. */
  const openTag = (target: EventTarget): boolean => {
    const key = (target as HTMLElement).closest<HTMLElement>('[data-note-tag]')?.dataset.noteTag
    if (!key) return false
    setNotesTagFilter(key)
    setSidebarTab('notes')
    useUIStore.getState().revealSidebar()
    return true
  }

  const handleBodyKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    if (openTag(e.target)) e.preventDefault()
  }

  const handleBodyClick = (e: React.MouseEvent): void => {
    // A link opens externally and a tag pill filters the list; neither is
    // also a request to edit the note.
    if ((e.target as HTMLElement).closest('a')) return
    if (openTag(e.target)) return
    setEditingBody(true)
    requestAnimationFrame(() => {
      const el = bodyTextareaRef.current
      if (el) {
        el.focus()
        const len = el.value.length
        el.setSelectionRange(len, len)
      }
    })
  }

  const handleBodyBlur = (): void => {
    setEditingBody(false)
    flushNow()
  }

  return (
    <div className="flex-1 overflow-y-auto pt-[var(--topbar-h)]">
      <div data-sidebar-band-limit className="max-w-2xl mx-auto px-6 py-6 space-y-4">
        <input
          type="text"
          value={hideDefaultTitle ? '' : title}
          onChange={(e) => {
            setHideDefaultTitle(false)
            setTitle(e.target.value)
          }}
          onFocus={() => {
            if (title === FALLBACK_TITLE) setHideDefaultTitle(true)
          }}
          onBlur={() => {
            setHideDefaultTitle(false)
            flushNow()
          }}
          placeholder="Untitled note"
          className="w-full bg-transparent text-[var(--color-text)] text-2xl font-semibold
            outline-none border-none placeholder:text-[var(--color-text-muted)]"
        />

        {editingBody ? (
          <textarea
            ref={bodyTextareaRef}
            // A textarea reads CRLF back as LF: show LF, and fold each edit
            // back into the stored body so lines the user did not touch (a
            // memory note's frontmatter) keep their bytes.
            value={toTextareaValue(body)}
            onChange={(e) => setBody(keepLineEndings(body, e.target.value))}
            onBlur={handleBodyBlur}
            placeholder={'Write in markdown.\n\n# Heading\n**bold** _italic_ [link](https://example.com)\n- bullet'}
            rows={Math.max(12, body.split('\n').length + 2)}
            className="w-full bg-transparent text-[var(--color-text)] text-sm leading-relaxed
              outline-none border-none resize-none font-mono"
          />
        ) : body.trim() ? (
          <div
            onClick={handleBodyClick}
            onKeyDown={handleBodyKeyDown}
            className="markdown-body text-sm text-[var(--color-text)] leading-relaxed
              cursor-text min-h-[12rem]"
          >
            {rendered.card}
            <Markdown
              remarkPlugins={REMARK_PLUGINS}
              rehypePlugins={[rehypeHighlight]}
              components={markdownComponents}
            >
              {rendered.body}
            </Markdown>
          </div>
        ) : (
          <div
            onClick={handleBodyClick}
            className="text-sm text-[var(--color-text-muted)] italic cursor-text min-h-[12rem]"
          >
            Click to start writing…
          </div>
        )}
      </div>
    </div>
  )
}
