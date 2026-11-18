/**
 * The field shell the agent page's cards share.
 *
 * One definition, imported by the Runs-with panel and the Permissions card,
 * because two copies is exactly how the type scales drifted apart last time
 * (`ui_guidelines_llm.md`, the `AgentsRootGit` note): each copy was right on
 * the day it was written and nothing compared them afterwards. A select on one
 * card and a select on the card beside it are the same control, and this file
 * is what makes that a fact rather than a coincidence.
 */

/** A select or input on an agent-page card. */
export const FIELD =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs ' +
  'text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none ' +
  'disabled:cursor-not-allowed disabled:opacity-50'

/**
 * {@link FIELD} without its `w-full`, for the two selects that share the Model
 * column's row: `w-full` is emitted after `w-[4.75rem]` in the built CSS and
 * wins, so the effort select took the row and the model select shrank to its
 * chevron. Each of the two sets its own width instead.
 */
export const FIELD_IN_ROW = FIELD.replace(/(^|\s)w-full(\s|$)/, ' ').trim()

/** The label above such a field. */
export const LABEL =
  'mb-1 block text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]'

/**
 * One badge in the chat-mode summary row under the agent's header — the
 * runtime, the model, a setup issue, and the team-sharing state. Shared so the
 * sharing badge and its Update / Share changes buttons are the runtime badges'
 * height and shape, not a near copy of them.
 */
export const SUMMARY_BADGE =
  'max-w-full truncate rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]'

/**
 * A bordered button at the agent-page panels' scale, sized to their 16px
 * status slot (the Runs-with panel's Log in and Refresh, the vault engine
 * panel's Unlock and Change model…).
 *
 * Not `SettingsButton`: that is the Settings scale (13px, ~28px tall), and in
 * the reserved `h-4` line it would either overflow it or grow the panel and move
 * the tab strip below (ux_rules rules 1 and 12 — a component takes the scale of
 * the surface it renders into). Primary text colour and a border, so it reads
 * as a control beside the muted and red prose around it (rule 11).
 */
export const LINE_BUTTON =
  'inline-flex h-4 shrink-0 items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 ' +
  'text-[10px] font-medium leading-none text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)] ' +
  'aria-disabled:cursor-not-allowed aria-disabled:opacity-60'
