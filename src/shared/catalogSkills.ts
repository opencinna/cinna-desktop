/**
 * Catalog skills in local agents (catalog U6, U7, U9): what the renderer may
 * ask main to do with a kit agent's `catalog_skills[]` pins, and the typed
 * answers. Every answer is data — a refusal is `{ok: false, code}`, never a
 * thrown error, because a thrown `DomainError`'s code does not survive IPC.
 *
 * Channels (`catalogSkills.ipc.ts`; literal, as `registration.test.ts` reads
 * them): `catalog-skills:add` {@link CatalogSkillAddInput},
 * `catalog-skills:update` and `catalog-skills:remove`
 * {@link CatalogSkillNameInput}, `catalog-skills:ensure`
 * {@link CatalogSkillEnsureInput}.
 */

/** Pin the latest revision of a catalog skill package into a kit agent. */
export interface CatalogSkillAddInput {
  agentId: string
  /** The skill package's catalog `uuid`. */
  packageUuid: string
}

/** Re-pin, fetch or drop one of an agent's catalog skills, named by its pin `name`. */
export interface CatalogSkillNameInput {
  agentId: string
  name: string
}

export interface CatalogSkillEnsureInput {
  agentId: string
}

/**
 * Why a catalog skill action did not happen.
 *
 * * `no_account` — the active profile is not signed in to a Cinna server.
 * * `not_found` — no such agent, or no pin of that name.
 * * `not_kit_agent` — a bare folder, or a manifest that cannot be read.
 * * `not_in_catalog` — the package is not in the cached catalog listing, or has no version.
 * * `read_only` — a shared agent where this person may only use it (U9): its skills change with the team's next version.
 * * `access_unknown` — a shared agent whose access the catalog listing does not say.
 * * `clash` — the name is an own skill under `skills/`, another pin's, or a platform skill's.
 * * `already_added` — the agent already pins this package.
 * * `download_failed` — the server refused or could not be reached (404 for a teammate whose copy is behind, U7).
 * * `hash_mismatch` — the bytes did not match the server's digest or the pin's `archive_sha256`; nothing was written.
 * * `invalid_archive` — the archive broke a safety rule (a link, a path outside its folder, the wrong folder name).
 * * `too_large` — over 16 MB to download, or 64 MB unpacked.
 * * `manifest_modified` — `cinna-agent.json` changed while the skill was downloading; nothing was written.
 * * `write_failed` — the manifest or the cache could not be written.
 * * `reauth_required` — the Cinna session has to be renewed.
 */
export type CatalogSkillRefusal =
  | 'no_account'
  | 'not_found'
  | 'not_kit_agent'
  | 'not_in_catalog'
  | 'read_only'
  | 'access_unknown'
  | 'clash'
  | 'already_added'
  | 'download_failed'
  | 'hash_mismatch'
  | 'invalid_archive'
  | 'too_large'
  | 'manifest_modified'
  | 'write_failed'
  | 'reauth_required'

export type CatalogSkillOutcome =
  | {
      ok: true
      /** The pin's name. */
      name: string
      /** The revision now pinned; for a remove, the one that was. */
      revisionNumber: number
    }
  | { ok: false; code: CatalogSkillRefusal; message: string }

/** One pin {@link CatalogSkillEnsureResult} could not bring to this computer. */
export interface CatalogSkillEnsureFailure {
  name: string
  code: CatalogSkillRefusal
  message: string
}

/**
 * What `ensure` did: every pinned revision missing from the cache was
 * fetched (`fetched`) or not (`failed`). A pin already cached is in neither.
 * Never a refusal for the agent as a whole except `not_found` / `not_kit_agent`.
 */
export type CatalogSkillEnsureResult =
  | { ok: true; fetched: string[]; failed: CatalogSkillEnsureFailure[] }
  | { ok: false; code: CatalogSkillRefusal; message: string }
