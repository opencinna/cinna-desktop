import type {
  AgentShareState,
  AgentShareStatus,
  ShareRefusal
} from '../../../shared/agentSharing'

/**
 * Every sentence the team-sharing surfaces show, in one place.
 *
 * The vocabulary is a contract (team-sharing plan, S9): the user reads Team
 * library, Get, Update, Share changes, "Up to date with the team", "N changes
 * you haven't shared", "The team changed this agent" — and never the git words
 * underneath (`FORBIDDEN_SHARE_WORDS`). Keeping the prose here is what lets one
 * test read all of it, and lets the component tests assert on a code's entry
 * rather than on wording that will be tuned.
 *
 * Each sentence leads with what the user can do; a status line fits one line.
 */

/** Why a sharing action did not happen, as the user reads it. */
export const SHARE_REFUSAL_TEXT: Record<ShareRefusal, string> = {
  git_missing: 'Install Git to share agents — this computer doesn’t have it.',
  not_shared: 'Share this agent with the team first — it isn’t shared yet.',
  other_account: 'Switch to the account this agent was shared from to update it.',
  reauth_required: 'Sign in to Cinna again, then try once more.',
  dirty: 'Share your changes first — Share changes brings in the team’s version too.',
  diverged_conflict: 'Choose which version to keep — the team changed this agent too.',
  fetch_failed: 'Check your connection and try again — the team’s version couldn’t be reached.',
  push_rejected: 'Fix what the team library refused, then share again.',
  no_access: 'Ask a maintainer for edit access — you can use this agent but not change it for the team.',
  nothing_to_share: 'Nothing to share — this agent matches the team’s version.',
  remote_exists: 'Use Share changes instead — this agent is already shared.',
  exists: 'Open the copy you already have — this agent is already on this computer.',
  not_an_agent: 'Ask the maintainer to check it — what was shared isn’t an agent.',
  not_in_library: 'Refresh the Team library — this agent is no longer in it.',
  turn_in_progress: 'Wait for the agent to finish its turn, then try again — nothing was changed.',
  unshared_changes: 'Share your changes first — removing this agent would lose them.',
  // A non-developer cannot take a file out of the team's version; the
  // maintainer can. `detail` names up to three of the files.
  secrets_tracked:
    'A file that can hold a secret is already in the team’s version. Ask whoever maintains this agent to remove it before sharing.',
  failed: 'Try again — that didn’t work.'
}

/**
 * A refusal with what main added to it. `detail` is the server's own sentence
 * (`push_rejected`), the agent already here (`exists`), or what failed
 * (`failed`); it is never shown for a code whose sentence is complete.
 */
export function shareRefusalSentence(refusal: ShareRefusal, detail: string | null = null): string {
  const base = SHARE_REFUSAL_TEXT[refusal]
  const extra = detail?.trim()
  if (!extra) return base
  if (refusal === 'secrets_tracked') {
    return `A file that can hold a secret is already in the team’s version (${extra}). Ask whoever maintains this agent to remove it before sharing.`
  }
  if (refusal === 'exists') return `Open ${extra} instead — this agent is already on this computer.`
  if (refusal === 'push_rejected' || refusal === 'failed') return `${base} ${extra}`
  return base
}

/** How many changes a status counts as unshared. */
export function unsharedCount(status: AgentShareStatus): number {
  return status.changedFiles > 0 ? status.changedFiles : status.ahead
}

/** The one state a shared agent's status line shows. */
export const SHARE_STATE_TEXT: Record<AgentShareState, (status: AgentShareStatus) => string> = {
  up_to_date: () => 'Up to date with the team',
  unshared: (status) => {
    const count = unsharedCount(status)
    return count === 1 ? '1 change you haven’t shared' : `${count} changes you haven’t shared`
  },
  // `behind: -1` is the listing saying the team moved, with no fetch to count
  // by; a count would only restate it, so the sentence is the same either way.
  behind: () => 'The team changed this agent',
  diverged: () => 'Share changes to combine yours with the team’s — you both changed this agent',
  removed: () => 'This agent is no longer shared',
  other_account: () => 'Shared on another account'
}

/** The status line's sentence: a failed read's refusal, else the state. */
export function shareStatusSentence(status: AgentShareStatus): string {
  if (status.refusal) return SHARE_REFUSAL_TEXT[status.refusal]
  return SHARE_STATE_TEXT[status.state](status)
}

/** Labels, headings and fixed sentences of the sharing surfaces. */
export const SHARE_UI_TEXT = {
  sharedGlyph: 'Shared with the team',
  unsharedDot: 'Has changes to share or update',
  update: 'Update',
  updating: 'Updating…',
  shareChanges: 'Share changes…',
  share: 'Share',
  sharing: 'Sharing…',
  cancel: 'Cancel',
  shareChangesTitle: 'Share changes',
  shareChangesLabel: 'What changed',
  shareChangesPlaceholder: 'Writing a summary…',
  shareChangesEmptyPlaceholder: 'Say what you changed, so the team knows.',
  conflictTitle: 'The team changed this agent too',
  conflictBody:
    'Your changes and the team’s don’t fit together. Pick one to carry on with — nothing is lost either way.',
  useTeamVersion: 'Use the team’s version (keep mine as a copy)',
  usingTeamVersion: 'Switching…',
  keepMine: 'Keep working on mine (share later)',
  keptCopy: (name: string) => `Your version is kept as ${name}.`,
  keptCopyUnnamed: 'Your version is kept as a copy beside this agent.',
  notCarried: (files: string) => `Some of this computer’s files didn’t come across: ${files}.`,
  shareWithTeam: 'Share with the team…',
  shareWithTeamTitle: 'Share with the team',
  shareWithTeamBody:
    'Put this agent in your Team library, so teammates can Get it and you can share changes with them.',
  nameLabel: 'Name',
  descriptionLabel: 'Description',
  loadingDraft: 'Loading…',
  removeFromComputer: 'Remove from this computer',
  removeFromComputerMenu: 'Remove from this computer…',
  removeFromComputerBody: (name: string) =>
    `Remove ${name} from this computer? Its folder goes to the Trash and can be put back from there. The team’s version stays in the Team library, untouched — you can Get it again any time.`,
  bundlesSource: 'Cinna bundles',
  librarySource: 'Team library',
  get: 'Get',
  getting: 'Getting…',
  getFromLibrary: (name: string) => `Get ${name} from the team library`,
  installed: 'Installed',
  open: 'Open',
  updateAvailable: 'Update available',
  libraryEmpty: 'Nothing has been shared with the team yet.',
  libraryLoading: 'Loading the Team library…',
  libraryError: 'The Team library couldn’t be loaded.',
  maintainedBy: (names: string) => `Maintained by ${names}`,
  teamChangedLead: 'The team changed',
  teamChanged: (name: string) => `The team changed ${name}`,
  teamChangedBy: (who: string) => `by ${who}`,
  updated: 'Updated. This agent now has the team’s latest version.'
} as const

/**
 * Words the sharing surfaces never show (team-sharing plan, S9). Matched as
 * whole words, case-insensitively, by the test that reads every string above.
 */
export const FORBIDDEN_SHARE_WORDS = [
  'branch',
  'commit',
  'push',
  'pull',
  'merge',
  'rebase',
  'remote',
  'repository',
  'conflict',
  'sha'
] as const
