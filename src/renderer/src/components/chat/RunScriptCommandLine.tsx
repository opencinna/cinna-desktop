import { forwardRef, useRef } from 'react'

/** The command line's rows: one for a one-line command, up to this many for a block; more scrolls. */
export const COMMAND_LINE_MAX_ROWS = 6

/**
 * Rows for a command, decided once at open: nothing resizes while the user
 * types (ux_rules §1). With `charsPerLine` (the field's width in monospace
 * cells, measured at open) a long line counts the rows it soft-wraps to, so
 * its end is not hidden behind a scrollbar; without it, one per line.
 */
export function commandLineRows(command: string, charsPerLine: number | null = null): number {
  const lines = command.split('\n')
  const cells = charsPerLine !== null && Number.isFinite(charsPerLine) && charsPerLine >= 1 ? Math.floor(charsPerLine) : null
  let rows = 0
  for (const line of lines) {
    rows += cells === null ? 1 : wrappedRows(line, cells)
    if (rows >= COMMAND_LINE_MAX_ROWS) return COMMAND_LINE_MAX_ROWS
  }
  return Math.max(1, rows)
}

/** The rows a line soft-wraps to in a field `cells` wide: breaks after spaces, a longer word breaks anywhere. */
function wrappedRows(line: string, cells: number): number {
  if (line.length <= cells) return 1
  let rows = 1
  let col = 0
  for (const token of line.match(/\S+\s*|\s+/g) ?? []) {
    const word = token.trimEnd().length
    if (col > 0 && col + word > cells) { rows++; col = 0 }
    if (word > cells) {
      rows += Math.ceil(word / cells) - 1
      col = word % cells || cells
    } else {
      col += word
    }
    // Trailing spaces hang past the edge rather than wrap.
    col += token.length - word
  }
  return rows
}

/**
 * The command line's width in monospace cells, measured at open from the
 * field and a probe in its font; null where nothing is laid out.
 */
export function measureCharsPerLine(field: HTMLTextAreaElement | null): number | null {
  if (!field || !field.parentElement) return null
  const style = getComputedStyle(field)
  const width = field.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0)
  if (!(width > 0)) return null
  const probe = document.createElement('span')
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;'
  probe.style.font = style.font
  probe.textContent = 'M'.repeat(40)
  field.parentElement.appendChild(probe)
  const cell = probe.getBoundingClientRect().width / 40
  probe.remove()
  return cell > 0 ? Math.floor(width / cell) : null
}

/**
 * The Run Script window's command line: a monospace field after a `$`
 * prompt. It edits the command; it is not the run's stdin (stdin stays
 * closed).
 *
 * Keys: Enter runs a one-line command (in a multi-line one it is a new line),
 * ⌘↩ always runs, ⇧⌘↩ runs in the background. A held key's repeats run
 * nothing (the press that opened the window must not run it), nor does an
 * Enter that commits an IME composition. On a one-line command ↑ and ↓
 * walk `history` (the chat's earlier commands, most recent first) and back to
 * what was typed. Read-only while a run is going.
 */
export const RunScriptCommandLine = forwardRef<HTMLTextAreaElement, {
  value: string
  onChange: (value: string) => void
  rows: number
  /** The command was a multi-line block at open: Enter is a new line, ↑/↓ move the caret. */
  multiline: boolean
  readOnly: boolean
  history: readonly string[]
  onRun: (background: boolean) => void
}>(function RunScriptCommandLine({ value, onChange, rows, multiline, readOnly, history, onRun }, ref) {
  // -1 is the user's own text; 0.. index into `history`.
  const walk = useRef<{ at: number; draft: string }>({ at: -1, draft: '' })
  const recall = (direction: 1 | -1): boolean => {
    const state = walk.current
    let at = state.at
    // Skip entries equal to what is shown, so ↑ never looks like it did nothing.
    do { at += direction } while (at >= 0 && at < history.length && history[at] === value)
    if (at >= history.length) return false
    if (at < 0) {
      if (state.at === -1) return false
      state.at = -1
      onChange(state.draft)
      return true
    }
    if (state.at === -1) state.draft = value
    state.at = at
    onChange(history[at])
    return true
  }
  return (
    <div className="flex min-w-0 flex-1 items-start gap-2 font-mono text-[12px] leading-5">
      <span aria-hidden className="select-none pt-1.5 text-[var(--color-text-muted)]">$</span>
      <textarea
        ref={ref}
        aria-label="Command"
        value={value}
        rows={rows}
        readOnly={readOnly}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => {
          walk.current = { at: -1, draft: '' }
          onChange(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            if (event.nativeEvent.isComposing) return
            const mod = event.metaKey || event.ctrlKey
            const block = multiline || value.includes('\n')
            if (event.repeat) {
              // Held: a key that would run swallows its repeats; a new line in a block repeats as usual.
              if (mod || (!block && !event.shiftKey && !event.altKey)) event.preventDefault()
              return
            }
            if (mod) {
              event.preventDefault()
              if (!readOnly) onRun(event.shiftKey)
              return
            }
            // A multi-line command takes Enter as a new line; Shift+Enter always does.
            if (event.shiftKey || event.altKey || block) return
            event.preventDefault()
            if (!readOnly) onRun(false)
            return
          }
          if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !readOnly && !multiline && !value.includes('\n')
            && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
            if (recall(event.key === 'ArrowUp' ? 1 : -1)) event.preventDefault()
          }
        }}
        // Rows fixed at open, no resize: the window keeps its layout while the user types.
        // A field of several rows keeps half a line of bottom padding, so a scrolled
        // field shows the next line cut off and reads as more below; one row sits
        // centred on the buttons beside it.
        className={`block min-w-0 flex-1 resize-none overflow-y-auto bg-transparent pt-1.5 ${rows > 1 ? 'pb-2.5' : 'pb-1.5'} text-[var(--color-text)]
          placeholder:text-[var(--color-text-muted)] focus:outline-none read-only:text-[var(--color-text-secondary)]`}
      />
    </div>
  )
})
