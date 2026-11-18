import { Circle } from 'lucide-react'
import type { ClaudeAuthState } from '../../../../../shared/engine'
import { LABEL } from './fieldClasses'

/*
 * The Runs-with panel's third column — the Engine cell — shared by the folder
 * agent's panel (`RuntimePanel`) and a vault agent's (`VaultEnginePanel`), so
 * the two read alike and keep one height.
 */

/**
 * The third column's row: a dot, a word, and optionally one button.
 *
 * **Extracted because the panel's footprint depends on it.** Both engines
 * render into this slot, and switching between them must not change the panel's
 * height — the page's tab strip sits directly below and moving it out from
 * under the pointer that just used the select is what ux_rules rule 1 exists to
 * prevent. While the two branches each inlined their own `h-[26px]`, that
 * property held only because two independent literals happened to agree, and
 * nothing would have failed if one of them drifted.
 *
 * `dot` and `tone` are passed in rather than derived, because the two engines
 * report different things through the same row. They used to differ more: a
 * green dot on OpenCode meant *the shared process is running*, where Claude's
 * only knowable fact was that a binary had been found. Phase 3 gave both the
 * same shape — a binary, and where it came from — so both are muted now, and
 * the colours are still the caller's to pass because the *states* are not the
 * same set.
 */
export function EngineRow({
  label,
  dot,
  tone,
  text,
  title,
  action
}: {
  label: string
  dot: string
  tone: string
  text: string
  title: string
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <span className={LABEL}>{label}</span>
      <div className="flex h-[26px] items-center gap-2 text-xs">
        <Circle size={7} className={`shrink-0 fill-current ${dot}`} />
        <span className={`min-w-0 truncate ${tone}`} title={title}>
          {text}
        </span>
        {action}
      </div>
    </div>
  )
}

/**
 * The user's own Claude Code install, as a fact about their machine.
 *
 * Deliberately **not** a mirror of {@link EngineStatus}: there is no process
 * this app starts, nothing to report as running or stopped, and so no Start
 * button. What can be said is what was detected, and that is all that is said.
 *
 * "Claude Code" is the right words here even though the picker above says
 * "Claude Agent" — a product name is constrained for a third-party surface, but
 * naming the tool the user installed, at the path they installed it to, is a
 * statement about their machine and is what makes the line diagnosable.
 *
 * **The cell's text is about the install; only its dot knows about the login.**
 * Not because the login is unknowable — `claude auth status` answers it for
 * free, and the reserved line below says what it found — but because this
 * column is fixed at 219px and does not widen with the window, so the text
 * holds the shortest true thing and the line that can grow carries the
 * meaning. The dot is the exception, and `const dot` below says why.
 */
export function ClaudeStatus({
  label = 'Claude Code',
  tool,
  unknown,
  auth,
  hint,
  missingText = 'Not installed'
}: {
  label?: string
  tool?: { path: string | null; version: string | null }
  /**
   * What the cell says when there is no tool. "Not installed" is a statement
   * about a CLI the user installs; for one Cinna manages the only tool-less
   * state is an install that failed, and the sentence beside the cell and the
   * summary badge both already say *Install failed*.
   */
  missingText?: string
  /**
   * The tooltip when there is no path to show. Without it the fallback is "none
   * was found on this machine" — true for a CLI the user installs, false for
   * one Cinna manages and simply has not fetched yet.
   */
  hint?: string
  /** Detection is still in flight — say so rather than denying an install. */
  unknown?: boolean
  /** What the login probe found, or undefined while it is still asking. */
  auth?: ClaudeAuthState
}): React.JSX.Element {
  if (unknown) {
    return (
      <EngineRow
        label="Engine"
        dot="text-[var(--color-text-muted)]"
        tone="text-[var(--color-text-muted)]"
        text="Checking…"
        title={`Looking for ${label} on this machine`}
      />
    )
  }
  // **Short enough for the column that will never grow.** This cell is fixed at
  // 219px once the grid reaches three columns and does not widen with the
  // window — the panel's content caps at 729px — so the *wider* the window, the
  // more certain a long string clips. "No Claude Code found on this machine"
  // needs 232px and was therefore permanently truncated at every width from
  // 1200px up, which is where a default-sized window sits (ux_rules rule 7).
  // The reserved line below carries the explanation; this cell names the state.
  const text = tool ? `${label}${tool.version ? ` ${tool.version}` : ''}` : missingText
  /**
   * **Warning for a login this app knows is missing, and only for that.**
   *
   * The reserved line below turns red on a logged-out machine while this dot —
   * the one glanceable indicator in the row — stayed neutral grey, saying
   * nothing about a state the app had just gone and found out. The type scale's
   * Status Indicator Pattern assigns `--color-warning` to exactly this case
   * ("Awaiting auth"), which is also why it is not `--color-danger`: the
   * install is fine and one command fixes it.
   *
   * The rule this does **not** break is the one about green, and it is the
   * reason this dot is never the success colour whatever the login says: one
   * option away in this same select a green dot in this exact slot means *the
   * process is running*. Green in both would be one indicator, in one position,
   * meaning two things, and the weaker claim would be read as the stronger
   * (rule 9). `unknown` and in-flight stay muted too, because neither is
   * evidence of anything.
   */
  const dot = !tool
    ? 'text-[var(--color-danger)]'
    : auth === 'logged_out'
      ? 'text-[var(--color-warning)]'
      : 'text-[var(--color-text-muted)]'
  return (
    <EngineRow
      // The same label as the OpenCode branch, not a second name for one slot:
      // "Runs with" is the whole section's accessible name, and a control inside
      // it announcing those words would be two things with one name on one
      // surface (rule 10). On this path the engine *is* the user's Claude Code.
      label="Engine"
      dot={dot}
      tone={tool ? 'text-[var(--color-text-secondary)]' : 'text-[var(--color-danger)]'}
      text={text}
      title={tool?.path ?? hint ?? `No ${label} was found on this machine.`}
    />
  )
}
