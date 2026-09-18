/**
 * A handover, in the user's words.
 *
 * `HandoverState`, `HandoverWarning` and the git check are vocabularies main
 * reasons in: `waiting_external`, `auto_not_allowed:tracked`, `not_ignored`.
 * They are precise and nobody reads them. One module turns each of them into a
 * sentence, so the task page and the agent card cannot describe the same row
 * two different ways — and so the strings are in one place when the UX review
 * changes them (`drafts/file_handovers` §5, `ux_rules.md` §7).
 *
 * Every function is total: an unknown value from a newer build still produces
 * something true rather than a blank row. That is the same rule the parsers in
 * `shared/handovers.ts` follow, for the same reason.
 */

import {
  HANDOVERS_DIR,
  HANDOVER_REPORT_FILE,
  handoverWarningKind,
  type HandoverDto,
  type HandoverIgnoreCheck,
  type HandoverState
} from '../../../shared/handovers'

/**
 * Where the handover is, as one phrase for the Details panel.
 *
 * **Every phrase fits one line in a 13rem column.** The panel polls every five
 * seconds and this row is what changes; "Blocked — needs an answer" wrapped to
 * two lines at 800px, so every state change moved the rows under it while the
 * user was reading them (`ux_rules.md` §1). Detail that does not fit belongs in
 * the Note row below, which may lengthen the panel and moves nothing.
 *
 * `refused` keeps its reason in the same line: "Refused" alone invites the user
 * to look for a cause the page then does not show (§6). {@link
 * handoverStateTitle} carries the long form on hover.
 */
export function handoverStateLabel(row: {
  state: HandoverState
  refusalReason?: string | null
  briefMissingAt?: number | null
}): string {
  switch (row.state) {
    case 'seen':
      return 'Recorded'
    case 'gated':
      return 'Waiting in the Inbox'
    case 'running':
      return 'Running'
    case 'waiting_external':
      return 'Outside the app'
    case 'blocked':
      return 'Needs an answer'
    case 'done':
      return 'Done'
    case 'failed':
      return 'Failed'
    // A user's Skip and a requester's withdrawal end in the same state and are
    // not the same event: one is a decision about work offered, the other is
    // the offer being taken back. The brief being gone is what tells them apart.
    case 'skipped':
      return row.briefMissingAt ? 'Withdrawn' : 'Skipped'
    case 'refused':
      return `Refused: ${refusalText(row.refusalReason ?? null)}`
  }
}

/**
 * The same fact at length, for the row's `title` — the short label says where
 * the handover is, this says what that means, for the reader who wondered.
 * Null where the label is already the whole sentence.
 */
export function handoverStateTitle(row: {
  state: HandoverState
  refusalReason?: string | null
  briefMissingAt?: number | null
}): string | null {
  switch (row.state) {
    case 'gated':
      return 'Waiting for you to answer in the Inbox'
    case 'waiting_external':
      return 'Somebody outside Cinna claimed this brief and is running it'
    case 'blocked':
      return 'The executor needs an answer before it can carry on'
    case 'skipped':
      return row.briefMissingAt
        ? 'The requester removed the brief, so the work was withdrawn'
        : null
    case 'refused':
      return row.refusalReason === 'depth_exceeded'
        ? 'Refused: this handover was handed on more times than Cinna allows'
        : null
    default:
      return null
  }
}

/**
 * Why the desktop declined outright. Only `depth_exceeded` exists today; a
 * reason this build has not heard of is shown as it arrived rather than
 * flattened to "unknown", because it came from *this* app and a support
 * conversation can use it.
 */
function refusalText(reason: string | null): string {
  if (reason === 'depth_exceeded') return 'too deep'
  return reason && reason.trim() !== '' ? reason : 'no reason recorded'
}

/**
 * What happened to a handover that carried on anyway.
 *
 * A warning is not a failure — the row it sits on is running or finished — so
 * every sentence says what is true now, not what to do about it.
 *
 * **Every kind in {@link HandoverWarning} has a sentence here.** Seven of the
 * sixteen did, and the `default` showed the rest as they arrived: a task page
 * read `report_missing` at the user. `HANDOVER_WARNING_KINDS` is the list a
 * test walks, so the next kind added to the union arrives here with it. The
 * suffixed kinds carry main's own reason after the colon; it is appended rather
 * than translated, because it is already a sentence written for a human.
 */
export function handoverWarningText(warning: string): string {
  const detail = warning.slice(handoverWarningKind(warning).length + 1)
  switch (handoverWarningKind(warning)) {
    case 'brief_edited':
      return 'The brief was edited after it was picked up; the task keeps the original'
    case 'auto_not_allowed':
      return `Automatic run was not allowed: ${autoRefusalText(detail)}`
    case 'origin_unresolved':
      return 'The requester could not be identified'
    case 'origin_parent_nested':
      return 'The requester’s task is already a subtask, so this one is not filed under it'
    case 'brief_removed_while_running':
      return 'The brief was deleted while the work was running'
    case 'report_unparseable':
      return `The ${HANDOVER_REPORT_FILE} file could not be read`
    case 'start_refused':
      return `The run could not be started: ${lowerFirst(detail)}`
    case 'report_missing':
      return `The run finished without writing ${HANDOVER_REPORT_FILE}; the outcome below is the agent’s reply`
    case 'run_lost':
      return 'The app closed while the run was in progress, so the run was lost'
    case 'wake_timed_out':
      return 'The requester’s chat stayed busy, so the result could not be delivered'
    case 'wake_failed':
    case 'wake_refused':
      return `The result could not be delivered to the requester: ${lowerFirst(detail)}`
    case 'revision_after_terminal':
      return 'A follow-up arrived after this was over; it is in the handover folder and needs a new brief'
    case 'revision_unparseable':
      return 'A follow-up file could not be read, so it and any after it are waiting'
    case 'revision_send_failed':
      return `A follow-up could not be delivered to the executor: ${lowerFirst(detail)}`
    case 'revision_send_timed_out':
      return 'The executor’s chat stayed busy, so a follow-up could not be delivered'
    default:
      return warning
  }
}

function autoRefusalText(reason: string): string {
  switch (reason) {
    case 'setting_ask':
      return 'this project asks first'
    case 'tracked':
      return `${HANDOVERS_DIR} is tracked by git`
    case 'not_ignored':
      return `${HANDOVERS_DIR} is not ignored by git`
    case 'unknown':
      return 'git could not be checked'
    default:
      return reason || 'no reason was recorded'
  }
}

/**
 * The detail after the colon, joined onto a sentence. Empty where a newer build
 * sent a suffixed kind with nothing after the colon — the sentence before it
 * still says what happened, which is the part that matters.
 */
function lowerFirst(text: string): string {
  const trimmed = text.trim()
  return trimmed === '' ? 'no reason recorded' : trimmed.charAt(0).toLowerCase() + trimmed.slice(1)
}

/**
 * The Note row: the one sentence under the panel that says what else happened.
 *
 * A warning first — it is the more specific fact — and otherwise the
 * withdrawal, which has no warning of its own because nothing went wrong: the
 * requester took the ask back. Null when there is nothing to say, so the row
 * renders only when it is filled (`ux_rules.md` §1).
 */
export function handoverNoteText(row: {
  state: HandoverState
  warning?: string | null
  briefMissingAt?: number | null
}): string | null {
  if (row.warning) return handoverWarningText(row.warning)
  if (row.briefMissingAt && row.state === 'skipped') {
    return 'The requester removed the brief, so the handover was withdrawn'
  }
  return null
}

/**
 * What git says about the folder, for the always-filled line under the
 * setting. It has something true to say in every state, which is what earns it
 * a reserved slot (`ux_rules.md` §1); the two states that forbid `auto` say so
 * in the same breath, because the disabled option is otherwise unexplained.
 */
export function handoverIgnoreText(check: HandoverIgnoreCheck | undefined): string {
  if (!check) return 'Checking git…'
  switch (check.result) {
    case 'ignored':
      return `${HANDOVERS_DIR} is ignored by git`
    case 'not_a_repo':
      return 'Not a git repository'
    case 'tracked':
      return `${HANDOVERS_DIR} is tracked by git — automatic runs are unavailable`
    case 'not_ignored':
      return `${HANDOVERS_DIR} is not in .gitignore — automatic runs are unavailable`
    default:
      return 'Could not check git — automatic runs are unavailable'
  }
}

/**
 * The same line when the folder is *set* to run automatically and git says it
 * may not.
 *
 * The select shows `ask`, because `ask` is what would happen — a control that
 * displays a value the app will not act on is the lie the review found. This
 * line is then the only place the stored setting still exists, so it says both
 * halves: the setting is there, and it is not in force. Short enough for one
 * line on an 800px card; the `title` carries it whole either way.
 */
export function handoverAutoOverriddenText(check: HandoverIgnoreCheck | undefined): string {
  return `Run automatically is set but not in force — ${overriddenReason(check)}`
}

function overriddenReason(check: HandoverIgnoreCheck | undefined): string {
  switch (check?.result) {
    case 'tracked':
      return `git tracks ${HANDOVERS_DIR}`
    case 'not_ignored':
      return `${HANDOVERS_DIR} is not ignored`
    default:
      return 'git could not be checked'
  }
}

/**
 * The handover's own directory, as a path the user can paste into a terminal.
 *
 * Built here rather than sent from main because main has no reason to compute a
 * display string — but the separator does have to survive the trip: a Windows
 * `folderPath` joined with `/` produces a path that is neither, and this row's
 * whole job is to be copyable.
 */
export function handoverFolderPath(
  row: Pick<HandoverDto, 'folderPath' | 'handoverId'>
): string {
  const sep = row.folderPath.includes('\\') ? '\\' : '/'
  const dir = HANDOVERS_DIR.split('/').join(sep)
  const base = row.folderPath.replace(/[\\/]+$/, '')
  return `${base}${sep}${dir}${sep}${row.handoverId}`
}

/**
 * The same path, short enough for one line of the Details panel.
 *
 * That column is about 13rem wide and the full path is routinely 90 characters,
 * so `break-all` put it on five lines and made the row beside it as tall
 * (`ux_rules.md` §1). The handover id is the part that identifies the folder
 * and it is never cut: what goes is the middle, and then the head, until what
 * is left fits. The whole path stays in the row's `title`, which is where it is
 * copied from.
 */
export function handoverFolderPathShort(
  row: Pick<HandoverDto, 'folderPath' | 'handoverId'>,
  max = 23
): string {
  const full = handoverFolderPath(row)
  if (full.length <= max) return full
  const sep = full.includes('\\') ? '\\' : '/'
  const tail = `${sep}${row.handoverId}`
  // No room even for `…/<id>`: the id alone, which is still the one part that
  // names this handover. An ellipsis before it would only cost a character.
  if (tail.length + 1 > max) return row.handoverId
  const head = max - tail.length - 1
  return `${full.slice(0, head)}…${tail}`
}
