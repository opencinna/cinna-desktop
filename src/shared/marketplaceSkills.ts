/**
 * Marketplace skills in local agents: what the renderer may ask main to do
 * with a kit agent's `marketplace_skills[]` pins (contract 1.15.0), and the
 * typed answers. A marketplace skill is a skill folder of one of the
 * skills-format marketplaces an admin connected to cinna-core; core snapshots
 * it at sync and serves the archive, so the desktop never touches git.
 *
 * Every answer is data — a refusal is `{ok: false, code}`, never a thrown
 * error, because a thrown `DomainError`'s code does not survive IPC.
 *
 * Channels (`marketplaceSkills.ipc.ts`; literal, as `registration.test.ts`
 * reads them): `marketplace-skills:discover` (no input),
 * `marketplace-skills:add` {@link MarketplaceSkillAddInput},
 * `marketplace-skills:update` and `marketplace-skills:remove`
 * {@link MarketplaceSkillNameInput}, `marketplace-skills:ensure` and
 * `marketplace-skills:status` {@link MarketplaceSkillAgentInput}.
 */

/** One skill a marketplace offers, as `/llm-plugins/discover?plugin_type=skills` lists it. */
export interface MarketplaceSkillEntry {
  /** The marketplace entry's id: what a pin's `entry_uuid` names. */
  entryUuid: string
  /** The skill's name (its folder, and its SKILL.md `name`). */
  name: string
  description: string
  marketplaceUuid: string
  marketplaceName: string
  /** The marketplace's owner (name, else email), or null. */
  marketplaceOwner: string | null
  /** A browser-openable page for the source, or null. */
  repositoryUrl: string | null
  /** Whether it can be added at all: false for an entry core could not snapshot. */
  supported: boolean
  /** Core's code when not {@link supported}: `no_skill_md`, `unsafe_path`, `too_large`, … The sentence is the renderer's. */
  unsupportedReason: string | null
  /** The current snapshot's digest; null when there is none to add. */
  archiveSha256: string | null
  archiveSize: number | null
  /** The skill ships scripts (it runs code, not only instructions). */
  hasScripts: boolean
  commitHash: string | null
  /** SKILL.md's `version`, or null. */
  version: string | null
}

/** Pin the current snapshot of a marketplace skill into a kit agent. */
export interface MarketplaceSkillAddInput {
  agentId: string
  /** The marketplace entry's id. */
  entryUuid: string
}

/** Re-pin, or drop, one of an agent's marketplace skills, named by its pin `name`. */
export interface MarketplaceSkillNameInput {
  agentId: string
  name: string
}

export interface MarketplaceSkillAgentInput {
  agentId: string
}

/**
 * Why a marketplace skill action did not happen.
 *
 * * `no_account` — the active profile is not signed in to a Cinna server.
 * * `not_found` — no such agent, no pin of that name, or the entry is not visible to this person.
 * * `not_kit_agent` — a bare folder, or a manifest that cannot be read.
 * * `read_only` — a shared agent this person may only use: its skills change with the team's next version.
 * * `access_unknown` — a shared agent whose access the catalog listing does not say.
 * * `clash` — the name is an own skill under `skills/`, a catalog or marketplace pin's, or a platform skill's.
 * * `already_added` — the agent already pins this entry.
 * * `unsupported` — the entry has no snapshot to add (core could not read it as a skill).
 * * `snapshot_missing` — core no longer keeps the pinned snapshot.
 * * `download_failed` — the server refused or could not be reached during a download.
 * * `hash_mismatch` — the bytes did not match the server's digest or the pin's `archive_sha256`; nothing was written.
 * * `invalid_archive` — the archive broke a safety rule (a link, a path outside its folder, the wrong folder name).
 * * `too_large` — over 16 MB to download, or 64 MB unpacked.
 * * `manifest_modified` — `cinna-agent.json` changed while the skill was downloading; nothing was written.
 * * `write_failed` — the manifest or the cache could not be written.
 * * `reauth_required` — the Cinna session has to be renewed.
 * * `network` — the marketplace list could not be read from the server.
 */
export type MarketplaceSkillRefusal =
  | 'no_account'
  | 'not_found'
  | 'not_kit_agent'
  | 'read_only'
  | 'access_unknown'
  | 'clash'
  | 'already_added'
  | 'unsupported'
  | 'snapshot_missing'
  | 'download_failed'
  | 'hash_mismatch'
  | 'invalid_archive'
  | 'too_large'
  | 'manifest_modified'
  | 'write_failed'
  | 'reauth_required'
  | 'network'

export type MarketplaceSkillRefused = { ok: false; code: MarketplaceSkillRefusal; message: string }

/** What `discover` answers: every skill entry visible to this person, supported ones first. */
export type MarketplaceSkillDiscoverResult = { ok: true; entries: MarketplaceSkillEntry[] } | MarketplaceSkillRefused

/** What Add, Update and Remove answer. */
export type MarketplaceSkillOutcome =
  | {
      ok: true
      /** The pin's name. */
      name: string
      /** The snapshot now pinned; for a remove, the one that was. */
      archiveSha256: string
    }
  | MarketplaceSkillRefused

/** One pin {@link MarketplaceSkillEnsureResult} could not bring to this computer. */
export interface MarketplaceSkillEnsureFailure {
  name: string
  code: MarketplaceSkillRefusal
  message: string
}

/** What `ensure` did: every pinned snapshot missing from the cache was fetched or not. */
export type MarketplaceSkillEnsureResult =
  | { ok: true; fetched: string[]; failed: MarketplaceSkillEnsureFailure[] }
  | MarketplaceSkillRefused

/**
 * Where one pin stands against its marketplace (M7, M8):
 * * `current` — the entry's current snapshot is the pinned one;
 * * `update_available` — the entry moved to another snapshot ({@link latestSha256}, {@link latestVersion});
 * * `unavailable` — the entry is not visible to this person any more (removed, or its marketplace is not theirs to see). The cached copy keeps working.
 */
export interface MarketplaceSkillPinStatus {
  name: string
  entryUuid: string
  state: 'current' | 'update_available' | 'unavailable'
  latestSha256?: string
  latestVersion?: string | null
  /** The entry's source page, when it is still visible and names one: the Skills row's source link. */
  repositoryUrl?: string
}

/** What `status` answers: per pin, by name; a refusal (`no_account`, `reauth_required`, `network`) as data. */
export type MarketplaceSkillStatusResult = { ok: true; pins: MarketplaceSkillPinStatus[] } | MarketplaceSkillRefused
