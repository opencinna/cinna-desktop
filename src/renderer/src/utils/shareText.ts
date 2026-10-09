import type {
  AgentShareResult,
  AgentShareState,
  AgentShareStatus,
  LibraryAccess,
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

/**
 * The badge beside the runtime badges: a short form of each state. The full
 * sentence ({@link shareStatusSentence}) is its tooltip.
 */
export const SHARE_BADGE_TEXT: Record<AgentShareState, (status: AgentShareStatus) => string> = {
  up_to_date: () => 'Up to date with the team',
  unshared: (status) => {
    const count = unsharedCount(status)
    return count === 1 ? '1 change not shared' : `${count} changes not shared`
  },
  behind: () => 'The team changed this agent',
  diverged: () => 'You and the team both changed it',
  removed: () => 'No longer shared',
  other_account: () => 'Shared on another account'
}

/** The badge's words: a failed read's short form, else the state's. */
export function shareBadgeText(status: AgentShareStatus): string {
  if (status.refusal) return SHARE_UI_TEXT.badgeReadFailed
  return SHARE_BADGE_TEXT[status.state](status)
}

/** Whether the badge (and the Sharing tab's status) takes the warning tone. */
export function shareStatusWarns(status: AgentShareStatus): boolean {
  return status.refusal !== null || status.state === 'diverged' || status.state === 'removed'
}

/** A library grant, as the People list and the pickers name it. */
export const SHARE_ACCESS_TEXT: Record<LibraryAccess, string> = {
  read: 'Can use',
  write: 'Can edit',
  maintain: 'Maintainer'
}

/**
 * A refusal from a surface that talks to the team library itself (People,
 * Remove sharing): the server's own sentence when it gave one, since "try
 * again" in front of "another person has it" would say the wrong thing;
 * `no_access` as the sentence for what was being done.
 */
export function libraryRefusalSentence(
  result: Pick<AgentShareResult, 'refusal' | 'detail'>,
  noAccess: string
): string {
  const refusal = result.refusal ?? 'failed'
  if (refusal === 'no_access') return noAccess
  if (refusal === 'failed' && result.detail?.trim()) return result.detail.trim()
  return shareRefusalSentence(refusal, result.detail)
}

/** Labels, headings and fixed sentences of the sharing surfaces. */
export const SHARE_UI_TEXT = {
  badgeReadFailed: 'Couldn’t check with the team',
  openSharing: 'Open this agent’s sharing settings',
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
    'Put this agent in your Team library. Only you and the people you choose here can get it — you can add more people later.',
  nameLabel: 'Name',
  loadingDraft: 'Loading…',
  peopleLabel: 'People',
  peopleSearchLabel: 'Find a person',
  peopleSearchPlaceholder: 'Name or email',
  peopleSearchHint: 'Type at least two letters of a name or email.',
  peopleSearching: 'Searching…',
  peopleNoneFound: 'No one found.',
  peopleSearchFailed: 'People couldn’t be searched.',
  peopleSearchFailedBecause: (why: string) => `People couldn’t be searched: ${why}`,
  removePersonConfirm: (name: string) => `Remove ${name}’s access?`,
  removePersonAction: 'Remove',
  peopleOnlyMe: 'Only you, for now.',
  accessLabel: 'Access',
  addPerson: 'Add',
  removePerson: (name: string) => `Remove ${name}`,
  accessFor: (name: string) => `Access for ${name}`,
  // The Sharing tab.
  tabLabel: 'Sharing',
  whereShared: 'Where it’s shared',
  whereSharedInfo:
    'This agent’s folder is linked to a team version. Update brings the team’s changes in; Share changes sends yours. Nothing is sent until you choose to.',
  serverLabel: 'Server',
  ownServer: 'Your own server',
  libraryNameLabel: 'Name in the library',
  libraryFolderLabel: 'Folder name',
  yourAccessLabel: 'Your access',
  maintainersLabel: 'Maintainers',
  lastSharedLabel: 'Last shared',
  lastShared: (when: string) => when,
  lastSharedBy: (when: string, who: string) => `${when} by ${who}`,
  peopleSection: 'People',
  peopleInfo:
    'Only the people listed here can get this agent from the Team library. A maintainer can change who has access and what they may do.',
  peopleOnlyMaintainer: 'Only a maintainer can change who has access.',
  peopleNoAccess: 'Only a maintainer can change who has access to this agent.',
  peopleLoading: 'Loading…',
  peopleLoadFailed: 'Who has access couldn’t be read.',
  everyone: 'Everyone on this server',
  roleMembers: (role: string) => `Everyone with the ${role} role`,
  you: 'You',
  shareWithPerson: 'Share with a person…',
  shareWithPersonTitle: 'Share with a person',
  historySection: 'History',
  historyInfo:
    'The versions of this agent recorded in its folder, newest first. Each has the note it was shared with.',
  historyEmpty: 'Nothing recorded yet.',
  historyLoading: 'Loading…',
  historyFailed: 'The history couldn’t be read.',
  notSharedYet: 'Not shared yet',
  removeSharingSection: 'Remove sharing',
  removeSharingHint: 'Disconnect this folder from the team. It stays on this computer as an ordinary agent.',
  removeSharingMenu: 'Remove sharing…',
  removeSharingTitle: 'Remove sharing',
  removeSharingConfirm: 'Remove sharing',
  removingSharing: 'Removing…',
  removeSharingBody: (name: string) =>
    `Stop sharing ${name} with the team? Its folder, files and history stay on this computer, and it becomes an ordinary agent you can share again later. Teammates keep their own copies.`,
  alsoDeleteFromLibrary: 'Also delete it from the team library — teammates can no longer get it',
  deleteNoAccess: 'Only a maintainer can delete it from the team library.',
  noLongerSharedNote: (name: string) => `${name} is no longer shared with the team.`,
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
