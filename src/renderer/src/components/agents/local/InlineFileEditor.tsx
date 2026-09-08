import { useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AlertTriangle, Clock } from 'lucide-react'
import { markdownComponents } from '../../../utils/markdownComponents'
import type { AgentFileEditor } from '../../../hooks/useLocalAgents'

interface InlineFileEditorProps {
  editor: AgentFileEditor
  placeholder: string
  /** Render as markdown when not focused. Off for one-liners. */
  markdown?: boolean
  minRows?: number
  /**
   * Render the file, refuse the click that starts editing.
   *
   * Distinct from `!editor.canSave`, which means "the file is not there" and
   * says so. This one means "the file is there and this is not the place to
   * change it", so it shows the contents and nothing else.
   */
  readOnly?: boolean
  /**
   * What to say when the file is not in the folder.
   *
   * The default names the scaffolder, which is right for a kit agent and
   * nonsense for a bare one — that folder was never scaffolded and never will
   * be, so "run the agent's scaffold again" is an instruction the reader cannot
   * follow (ux_rules rule 7).
   */
  missingNote?: string
}

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
  readOnly = false,
  missingNote
}: InlineFileEditorProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const startEditing = (): void => {
    if (!editor.canSave || readOnly) return
    setEditing(true)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
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
          onClick={startEditing}
          className={`markdown-body text-xs leading-relaxed text-[var(--color-text)] ${
            readOnly ? '' : 'cursor-text'
          }`}
        >
          <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {editor.text}
          </Markdown>
        </div>
      ) : (
        <div
          onClick={startEditing}
          className={`whitespace-pre-wrap text-xs leading-relaxed text-[var(--color-text)] ${
            readOnly ? '' : 'cursor-text'
          }`}
        >
          {editor.text}
        </div>
      )}
    </div>
  )
}
