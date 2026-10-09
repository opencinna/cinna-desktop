/**
 * Sharing a folder agent with a team, as the renderer sees it.
 *
 * A shared agent is an ordinary `Local/<slug>/` folder that is its **own** git
 * working tree with an `origin`. Nothing about the sharing is stored by the
 * desktop: the remote, its kind, and for a Cinna remote the repository id and
 * host are all read back from `origin`'s URL, so an agent a developer cloned by
 * hand is recognised the same way as one the app fetched. What only the team
 * library knows — the caller's access, the team's latest version — comes from
 * the cached library listing in main.
 *
 * Words matter here (README §S9 of the team-sharing plan): the renderer says
 * Team library, Get, Update, Share changes, "Up to date with the team", "N
 * changes you haven't shared", "The team changed this agent" — never branch,
 * commit, push, pull, merge, rebase, remote, repository, conflict or SHA. The
 * codes below are the contract; the sentences live in one renderer map so the
 * tests never assert on prose.
 */

/** `cinna`: hosted by the signed-in Cinna instance. `external`: anything else. */
export type AgentRemoteKind = 'cinna' | 'external'

/** A caller's grant on a team-library agent. */
export type LibraryAccess = 'read' | 'write' | 'maintain'

/** Where a shared agent's team version lives. Derived from `origin`, never stored. */
export interface AgentRemote {
  kind: AgentRemoteKind
  /** `origin`'s URL with any credential removed — safe to show, never shown raw. */
  url: string
  /** Cinna only: the library repository id, from `/git/<repo_id>.git`. */
  repoId: string | null
  /** Cinna only: the instance's origin, `https://host[:port]`. */
  host: string | null
  /** Cinna only, and only when the listing for that host is loaded. */
  access: LibraryAccess | null
}

/**
 * Why a sharing action did not happen. A code, so the renderer picks the
 * sentence.
 *
 * - `git_missing` — no usable git on this machine.
 * - `not_shared` — the folder has no team version (not its own repo, or no `origin`).
 * - `other_account` — a Cinna remote on an instance no active profile is signed in to.
 * - `reauth_required` — the Cinna session expired; the app-wide prompt handles it.
 * - `dirty` — Update refused: there are changes here that are not shared yet.
 * - `diverged_conflict` — the team's changes and these do not combine cleanly.
 * - `fetch_failed` — the team version could not be reached.
 * - `push_rejected` — the server refused the changes; `detail` carries its sentence.
 * - `no_access` — the caller may read but not change the team version.
 * - `nothing_to_share` — nothing differs from the team version.
 * - `remote_exists` — Share with the team on a folder that already has a team version.
 * - `exists` — Get into a slug, or with a manifest id, that is already here.
 * - `not_an_agent` — what came down has no `cinna-agent.json` at its root.
 * - `not_in_library` — the library no longer lists this repository.
 * - `turn_in_progress` — the agent is busy; nothing was changed.
 * - `unshared_changes` — Remove from this computer refused while changes are unshared.
 * - `secrets_tracked` — the folder already records a file that can hold a secret (a `.env`, `credentials.json`, `app-data/desktop.json`), so nothing was recorded or sent; `detail` names up to three.
 * - `failed` — anything else; `detail` says what.
 */
export type ShareRefusal =
  | 'git_missing'
  | 'not_shared'
  | 'other_account'
  | 'reauth_required'
  | 'dirty'
  | 'diverged_conflict'
  | 'fetch_failed'
  | 'push_rejected'
  | 'no_access'
  | 'nothing_to_share'
  | 'remote_exists'
  | 'exists'
  | 'not_an_agent'
  | 'not_in_library'
  | 'turn_in_progress'
  | 'unshared_changes'
  | 'secrets_tracked'
  | 'failed'

/**
 * The one state the status line shows, decided in main.
 *
 * Precedence, highest first: `other_account`, `removed`, `diverged`,
 * `behind`, `unshared`, `up_to_date`. `diverged` is both sides having moved;
 * Share changes is what tries to bring them together.
 */
export type AgentShareState =
  | 'up_to_date'
  | 'unshared'
  | 'behind'
  | 'diverged'
  | 'removed'
  | 'other_account'

/** A shared agent's state on this machine. */
export interface AgentShareStatus {
  agentId: string
  remote: AgentRemote
  state: AgentShareState
  /** Full local `HEAD`, or null in a folder with nothing recorded yet. */
  headSha: string | null
  /** The team's latest version as last seen: library listing (cinna) or last fetch (external). */
  remoteHeadSha: string | null
  /** Recorded locally, not yet with the team. */
  ahead: number
  /** The team has these and this folder does not. -1 when known only to be non-zero (listing said so, no fetch yet). */
  behind: number
  /**
   * Files that differ from the team version: edited, added (not ignored) or
   * removed, plus those in recorded-but-unshared versions. What "N changes you
   * haven't shared" counts.
   */
  changedFiles: number
  /** `ahead > 0 || changedFiles > 0`. */
  unshared: boolean
  /** True when the counts came from a fetch just now. */
  fetched: boolean
  /** Set when the status read itself failed (`fetch_failed`, `git_missing`, `reauth_required`). */
  refusal: ShareRefusal | null
}

/** What one sharing action did. */
export interface AgentShareResult {
  /** True when the action happened. */
  done: boolean
  refusal: ShareRefusal | null
  /**
   * A server's own sentence (`push_rejected`), or what failed (`failed`). On a
   * successful Use the team's version, the per-machine files that could not be
   * copied into it, when any. Never a token.
   */
  detail: string | null
  /** The status after the attempt, so the surface needs no refetch. Null when there is no shared agent to describe. */
  status: AgentShareStatus | null
  /**
   * The agent the action produced or moved to: the new row after Get, the
   * copy kept by Use the team's version.
   */
  agentId: string | null
}

/** A maintainer, as the library lists them. */
export interface LibraryMaintainer {
  userId: string
  displayName: string
}

/** One agent in the team library, as the catalog shows it. */
export interface LibraryAgentDto {
  repoId: string
  slug: string
  name: string
  description: string
  cloneUrl: string
  headSha: string
  updatedAt: string
  access: LibraryAccess
  maintainers: LibraryMaintainer[]
  /** The manifest's `runtime.engine`, when the manifest has one. */
  engine: string | null
  manifestId: string | null
  /**
   * This machine's copy: the local agent whose `origin` is this repository, or
   * whose manifest id matches it. Null when there is none.
   */
  localAgentId: string | null
  /** True when there is a local copy and the team has moved past it. */
  updateAvailable: boolean
}

/** The team library of the active Cinna profile. */
export interface LibraryListingDto {
  /** The instance the listing came from, `https://host[:port]`. */
  host: string
  agents: LibraryAgentDto[]
  /** When main fetched it. */
  fetchedAt: string
}

/** Pre-filled values for the Share with the team dialog. */
export interface ShareWithTeamDraft {
  name: string
  description: string
}

/**
 * Every sharing IPC resolves with this. Expected outcomes — refusals — travel
 * inside `value`; `success: false` is reserved for what the surface cannot
 * show as a state, and `code: 'reauth_required'` there is what lets `_wrap`
 * raise the app-wide re-auth prompt (the `CatalogOutcome` convention).
 */
export type SharingOutcome<T> =
  | { success: true; value: T }
  | { success: false; code: string; message: string }

/** Main → renderer: the library listing or a shared agent's state moved; refetch. */
export const SHARING_CHANGED_CHANNEL = 'sharing:changed'
