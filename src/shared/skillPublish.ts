/**
 * Sharing an authored skill to the catalog (catalog U5, U8, U11; plan D5):
 * what the renderer may ask main, and the typed answers. Every answer is data
 * — a refusal is `{ok: false, code, message}` with main's sentence, never a
 * thrown error, because a thrown `DomainError`'s code does not survive IPC.
 *
 * Channels (`skillPublish.ipc.ts`): `skill-publish:preview`
 * {@link SkillPublishPreviewInput} → {@link SkillPublishPreviewOutcome},
 * `skill-publish:publish` {@link SkillPublishInput} → {@link SkillPublishOutcome},
 * and `skill-publish:get-latest` {@link SkillGetLatestInput} →
 * {@link SkillGetLatestOutcome}.
 */

import type { LibraryAccess } from './agentSharing'

/** The skill to preview: an authored skill (`skills/<name>/`) of a kit agent. */
export interface SkillPublishPreviewInput {
  agentId: string
  name: string
}

/** One of the person's own credentials core would accept for a slot. */
export interface SkillPublishCandidate {
  id: string
  name: string
  type: string
  /** How it may be offered: `publisher` (shared) or `template` (copied without its secret). */
  canProvideAs: ('publisher' | 'template')[]
}

/** A credential slot the skill declares, with the person's credentials that could fill it for everyone. */
export interface SkillPublishSlot {
  slot: string
  type: string
  description: string | null
  candidates: SkillPublishCandidate[]
  /**
   * The candidate that provided this slot in the latest version, preselected
   * for a later one — core keeps only the slots a publish names, so an
   * unnamed slot becomes each person's own. Null when each person connected
   * their own, or the credential is no longer one of the candidates.
   */
  current: string | null
}

/** A newer version of the package than the folder's copy: what a stale share is refused with (S5). */
export interface SkillStaleBase {
  /** The package's latest `Version N`. */
  latestRevision: number
  /** Its label, e.g. `1.0.1`, or null. */
  version: string | null
  /** The display name of who shared it, or null. */
  publishedBy: string | null
}

/**
 * A package of this skill's name that somebody else publishes and the person
 * may edit (core's `EditableCandidate`): a first share can be its next
 * version instead of a separate skill (S6).
 */
export interface SkillEditableCandidate {
  packageUuid: string
  packageId: string
  /** The publisher's display name, or null. */
  publisher: string | null
  access: string
  /** The candidate's latest `Version N`; null when it has none. */
  latestRevisionNumber: number | null
  latestVersion: string | null
}

/** What sharing the skill now would produce — core's `SkillPublishPreview`. */
export interface SkillPublishPreviewDto {
  name: string
  /** The version this share would publish as, e.g. `1.0.0`. */
  version: string
  /** The catalog package id it would use, e.g. `io.example.skill.erp-lookup`. */
  packageId: string
  /** The plain id was taken, so the person's own suffix was added. */
  packageIdDisambiguated: boolean
  /** The package behind it, when there is one already. */
  packageUuid: string | null
  /** A later version of a package that exists. */
  isRepublish: boolean
  /** The `Version N` this share would become. */
  nextRevisionNumber: number
  credentials: SkillPublishSlot[]
  /**
   * Whether this person may provide a slot with their own credential: on a
   * new package, or as the person who first shared it (core refuses
   * `publisher_credentials` from anyone else). True when that cannot be told.
   */
  canProvide: boolean
  /**
   * Whether every slot the latest version had provided is preselected in
   * `current`. True on a new package; false when the latest version is not in
   * the listing, or a slot was provided as a template or by a credential that
   * is no longer offered — the dialog then says those are not kept.
   */
  providersCarried: boolean
  /**
   * First share only (no package recorded): packages of this name the person
   * may edit, each offered as "New version of …" beside "A separate skill".
   */
  editablePackages: SkillEditableCandidate[]
  /**
   * A recorded package whose latest version is past the folder's recorded
   * one: core would refuse the share (`stale`). Null when not stale or not asked.
   */
  stale: SkillStaleBase | null
}

/** Someone the first share gives access to. */
export interface SkillPublishPerson {
  userId: string
  access: LibraryAccess
}

/** A slot the person provides with one of their own credentials; unnamed slots are each person's own. */
export interface SkillPublisherCredential {
  slot: string
  credentialId: string
}

export interface SkillPublishInput {
  agentId: string
  name: string
  /** What changed, shown with the version in the catalog. */
  releaseNotes?: string
  /** First share only: who may use or change it. Ignored for a later version. */
  people?: SkillPublishPerson[]
  /** First share only: everyone on the server may use it. */
  everyone?: boolean
  publisherCredentials?: SkillPublisherCredential[]
  /**
   * First share only: share as the next version of this editable package
   * (one of the preview's `editablePackages`) instead of a new one. Who can
   * use it and provided credentials are left as that package has them.
   */
  packageUuid?: string
  /** With {@link packageUuid}: the candidate's latest `Version N`, the base core checks the share against. */
  baseRevisionNumber?: number
  /** First share only: a separate skill even though an editable package of this name exists. */
  newPackage?: boolean
}

/** Get Version N: bring the linked package's latest version into `skills/<name>/`. */
export interface SkillGetLatestInput {
  agentId: string
  name: string
  /** Replace a folder with unshared changes; they are moved to a backup folder first. */
  replace?: boolean
}

/**
 * Why a skill was not shared (or previewed).
 *
 * Before anything is sent: `no_account`, `not_found`, `not_kit_agent`,
 * `read_only` (a team agent shared with this person to use only) and
 * `access_unknown` (a team agent the cached listing does not give an access
 * for) — the rule `shareable` is drawn by —
 * `skill_invalid` (the skill has an error; the message is its sentence),
 * `has_link` / `special_file` (only files and folders travel), `secrets`
 * (a secret-looking file is in the folder), `unreadable`, `too_large`
 * (over 16 MB), `too_many_files` (over 2000 files and folders).
 *
 * From the catalog: `skill_archive_invalid`, `skill_contains_secrets`,
 * `invalid_publisher_credential`, `skill_name_mismatch`, `package_exists`,
 * `grants_require_users_visibility`, `invalid_grants`, `not_publisher`,
 * `package_not_found`, `reauth_required`, `failed` (anything else, with the
 * catalog's sentence where it gave one), `stale` (a newer version was shared
 * since the folder's copy; {@link SkillPublishRefused.stale} says which) and
 * `editable_package_exists` (a first share while a package of this name the
 * person may edit exists; {@link SkillPublishRefused.candidates}).
 *
 * Get Version N only: `not_linked` (no record for this server),
 * `up_to_date` (the folder holds the latest), `has_changes` (unshared edits,
 * without `replace`), `download_failed`, `download_mismatch` (the copy does
 * not hash to the version's content hash; nothing was changed) and
 * `write_failed` (the folder could not be swapped; it was put back).
 */
export type SkillPublishRefusal =
  | 'no_account'
  | 'not_found'
  | 'not_kit_agent'
  | 'read_only'
  | 'access_unknown'
  | 'skill_invalid'
  | 'has_link'
  | 'special_file'
  | 'secrets'
  | 'unreadable'
  | 'too_large'
  | 'too_many_files'
  | 'skill_archive_invalid'
  | 'skill_contains_secrets'
  | 'invalid_publisher_credential'
  | 'skill_name_mismatch'
  | 'package_exists'
  | 'grants_require_users_visibility'
  | 'invalid_grants'
  | 'not_publisher'
  | 'package_not_found'
  | 'reauth_required'
  | 'failed'
  | 'stale'
  | 'editable_package_exists'
  | 'not_linked'
  | 'up_to_date'
  | 'has_changes'
  | 'download_failed'
  | 'download_mismatch'
  | 'write_failed'

export type SkillPublishRefused = {
  ok: false
  code: SkillPublishRefusal
  message: string
  /** `stale` only: the version shared since the folder's copy. */
  stale?: SkillStaleBase
  /** `editable_package_exists` only: the packages the share could be a version of. */
  candidates?: SkillEditableCandidate[]
}

export type SkillPublishPreviewOutcome = { ok: true; preview: SkillPublishPreviewDto } | SkillPublishRefused

export type SkillPublishOutcome =
  | {
      ok: true
      name: string
      /** The `Version N` created. */
      revisionNumber: number
      /** The version label it was published as, now in `SKILL.md`. */
      version: string | null
      packageUuid: string
      packageId: string
      /**
       * False when the skill was published but `SKILL.md` or `publications.json`
       * could not be written; a later share then finds the package again itself.
       */
      recorded: boolean
    }
  | SkillPublishRefused

export type SkillGetLatestOutcome =
  | {
      ok: true
      name: string
      /** The `Version N` the folder now holds. */
      revisionNumber: number
      version: string | null
      /** Where the replaced folder was kept (`replace`), or null. */
      backupPath: string | null
    }
  | SkillPublishRefused
