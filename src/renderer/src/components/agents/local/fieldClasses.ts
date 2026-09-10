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

/** The label above such a field. */
export const LABEL =
  'mb-1 block text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]'
