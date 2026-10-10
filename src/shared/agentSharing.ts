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

import type { AutoAttachedCredential } from './serviceCredentials'
import type { CatalogAccessLevel, CatalogVisibility } from './catalogItems'

/** `cinna`: hosted by the signed-in Cinna instance. `external`: anything else. */
export type AgentRemoteKind = 'cinna' | 'external'

/**
 * A caller's access to a team agent — core's catalog levels: `use` (get it),
 * `edit` (share changes to it), `maintain` (who has access, delete). The UI
 * says Can use / Can edit / Maintainer.
 */
export type LibraryAccess = CatalogAccessLevel

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
  /**
   * The catalog id (`bundle_id`) this machine recorded in the agent's
   * `app-data/desktop.json` when it shared or got it; null when none was.
   * Shown, never asked.
   */
  bundleId: string | null
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
  /**
   * After a Get, an Update that brought changes, or Use the team's version:
   * the active account's credentials main attached because exactly one fitted
   * a slot. Empty after anything else.
   */
  autoAttached: AutoAttachedCredential[]
  /**
   * After those same actions: the page opens Finish setup. After a Get, when
   * any required credential is missing; after an Update or Use the team's
   * version, only when one is missing that was not before the action.
   */
  setupNeeded: boolean
}

/** A maintainer, as the library lists them. */
export interface LibraryMaintainer {
  userId: string
  displayName: string
}

/** A team agent's newest version, as the catalog numbers it. */
export interface LibraryVersionDto {
  /** "Version N". */
  number: number
  /** The publisher's own label (`1.2.0`), shown as `Version N (1.2.0)`; null when it has none. */
  label: string | null
  /** ISO 8601. */
  publishedAt: string
  /** Who shared it, when the catalog says. */
  publishedBy: string | null
  /** The notes the changes were shared with since the version before. */
  releaseNotes: string | null
}

/** One agent in the team library, as the catalog shows it. */
export interface LibraryAgentDto {
  /** The catalog item's uuid. */
  uuid: string
  /** The catalog id (`bundle_id`). */
  bundleId: string
  repoId: string
  slug: string
  name: string
  description: string
  cloneUrl: string
  /** '' before the first share. */
  headSha: string
  access: LibraryAccess
  visibility: CatalogVisibility
  /**
   * Whether the catalog lists it. Unlisted, only people who can edit or
   * maintain it can get it: core counts neither `public` nor a `use` grant.
   */
  isListed: boolean
  maintainers: LibraryMaintainer[]
  /** The engine the catalog names for it, when it does. */
  engine: string | null
  manifestId: string | null
  /** Null until the first share: only people who can edit see such an entry. */
  latest: LibraryVersionDto | null
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

/** A person given access when an agent is first shared with the team. */
export interface ShareWithTeamPerson {
  userId: string
  access: LibraryAccess
}

/**
 * What the Share with the team dialog sends. The description is not asked
 * for: main sends the manifest's. `people` may be empty — only the sharer
 * (as maintainer) can then get it; never "everyone" by default. `everyone`
 * makes the new entry `visibility: 'public'` (everyone's `use`); the people
 * named are granted as they are either way, so removing Everyone later in
 * People leaves them their access.
 */
export interface ShareWithTeamInput {
  name: string
  people: ShareWithTeamPerson[]
  everyone?: boolean
}

/**
 * Who a library grant is for: one account, or everyone with a role. `everyone`
 * — everyone on the instance — is not a grant on core: it is the item's
 * `visibility: 'public'`. Main reads and writes it as that, so the People list
 * keeps one shape.
 */
export type LibraryPrincipal =
  | { kind: 'user'; userId: string }
  | { kind: 'role'; role: string }
  | { kind: 'everyone' }

/** One grant on a library agent, as the Sharing tab's People list shows it. */
export interface LibraryPerson {
  principal: LibraryPrincipal
  access: LibraryAccess
  /** The person's name as the server gives it; '' when it gives none. */
  displayName: string
}

/** One grant as the renderer sends it back: the whole desired list replaces the server's. */
export interface LibraryGrantInput {
  principal: LibraryPrincipal
  access: LibraryAccess
}

/**
 * Who has access to a shared agent. `visible: false` when the server will not
 * say (the caller is not a maintainer): the tab then lists the maintainers
 * from the listing only.
 */
export interface AgentPeopleDto {
  visible: boolean
  people: LibraryPerson[]
  /**
   * The caller's own account id when it is in `people` (shown as "You", with
   * no remove). Null when it cannot be told.
   */
  selfUserId: string | null
}

/** What `sharing:set-people` answers: the action, and the list as the server now has it. */
export interface SetPeopleResult extends AgentShareResult {
  people: AgentPeopleDto | null
}

/** A person found by name or email, for the people picker. */
export interface PersonSearchResult {
  userId: string
  email: string
  name: string
}

/**
 * One version in a shared folder's history, newest first. No identifier is
 * carried: the Sharing tab lists versions, it never restores one.
 */
export interface AgentVersionDto {
  /** The version's note — its first line. */
  note: string
  author: string
  /** ISO 8601. */
  date: string
  /** Recorded here and not on the team version yet. */
  unsent: boolean
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
