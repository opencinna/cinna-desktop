/**
 * Sharing an authored skill to the catalog (catalog U5, U8, U11; plan D5):
 * what the renderer may ask main, and the typed answers. Every answer is data
 * — a refusal is `{ok: false, code, message}` with main's sentence, never a
 * thrown error, because a thrown `DomainError`'s code does not survive IPC.
 *
 * Channels (`skillPublish.ipc.ts`): `skill-publish:preview`
 * {@link SkillPublishPreviewInput} → {@link SkillPublishPreviewOutcome}, and
 * `skill-publish:publish` {@link SkillPublishInput} → {@link SkillPublishOutcome}.
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
}

/**
 * Why a skill was not shared (or previewed).
 *
 * Before anything is sent: `no_account`, `not_found`, `not_kit_agent`,
 * `skill_invalid` (the skill has an error; the message is its sentence),
 * `has_link` / `special_file` (only files and folders travel), `secrets`
 * (a secret-looking file is in the folder), `unreadable`, `too_large`
 * (over 16 MB), `too_many_files` (over 2000 files and folders).
 *
 * From the catalog: `skill_archive_invalid`, `skill_contains_secrets`,
 * `invalid_publisher_credential`, `skill_name_mismatch`, `package_exists`,
 * `grants_require_users_visibility`, `invalid_grants`, `not_publisher`,
 * `package_not_found`, `reauth_required`, `failed` (anything else, with the
 * catalog's sentence where it gave one).
 */
export type SkillPublishRefusal =
  | 'no_account'
  | 'not_found'
  | 'not_kit_agent'
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

export type SkillPublishRefused = { ok: false; code: SkillPublishRefusal; message: string }

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
