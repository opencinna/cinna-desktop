/**
 * TypeScript mirror of the kit contract's `schema/cinna-agent.schema.json`
 * (`resources/cinna-agent-kit/`). Shared between main (scaffolder, scanner,
 * validator, publish) and renderer (the agent page), so keep it type-only and
 * dependency-free.
 *
 * Every shape carries an index signature on purpose: the manifest is written by
 * three parties that ship on different schedules — this desktop, an assistant,
 * and cinna-core — so a key we do not know yet must survive a read/write round
 * trip untouched. `manifestIo` relies on that.
 */

/** Credential slot. Declares what the agent needs; never carries a value. */
export interface CredentialSlot {
  name: string
  /** A platform `CredentialType` value, e.g. `api_token`. */
  type: string
  /** Exact service slot when the name differs from the credential label. */
  service_uri?: string
  description?: string
  /** Prefix of the local `.env` variable names: `<env_prefix><FIELD>`. */
  env_prefix?: string
  fields?: string[]
  optional?: boolean
  [key: string]: unknown
}

export type ScheduleType = 'static_prompt' | 'script_trigger'

/** Unattended run declaration. Desktop execution requires separate local per-profile opt-in. */
export interface AgentSchedule {
  name: string
  /** Five-field cron expression. */
  cron_string: string
  timezone?: string | null
  schedule_type: ScheduleType
  /** Required for `static_prompt`. */
  prompt?: string | null
  /** Required for `script_trigger`. */
  command?: string | null
  enabled?: boolean
  [key: string]: unknown
}

/** Delegation to a sibling agent, by slug. */
export interface AgentHandover {
  target_slug: string
  /**
   * Optional host role, registered to this host (`x-scope: host:cinna-desktop`)
   * in core's contract 1.5.0. Only the exact coordinator pair grants desktop
   * handback.
   */
  target_kind?: string
  description?: string
  [key: string]: unknown
}

/** Paths, relative to the agent root, of the three document-backed prompts. */
export interface AgentPrompts {
  workflow?: string
  entrypoint?: string
  refiner?: string
}

/** Cloud-only capabilities the agent expects once imported. Ignored locally. */
export interface AgentFeatures {
  webapp?: boolean
  agent_api?: boolean
  [key: string]: unknown
}

/**
 * How the agent should be run, when the host offers a choice. `credential` is a
 * *reference* — a credential type, or the name of a credential configured in the
 * host — never a key. Absent means "the host's default runtime".
 *
 * `model` and `complexity` are two ways to say the same thing and are mutually
 * exclusive; `runtimeService.applyToManifest` refuses a manifest carrying both.
 * A tier is the portable half of the pair: this file is committed, read by an
 * assistant and uploaded to a Cinna instance, and a model id means something only
 * to the catalogue that lists it, while `medium` means the same thing everywhere.
 */
export interface AgentRuntimeRef {
  /**
   * Which engine the author *prefers*: `opencode` (the host-managed server),
   * `claude` (the Claude Agent SDK, driving the `claude` binary already
   * installed on the machine under its own login) or `codex` (the Codex CLI).
   *
   * Part of core's contract since 1.5.0 (the desktop shipped it earlier under
   * its own, now retired, 1.2.0). A preference, not an enum: absent means the
   * host default; a value this build does not recognise **runs on OpenCode**
   * (`effectiveEngine`) — it does not fail validation and does not brick the
   * folder, because a folder written by a newer tool must keep running.
   *
   * `engine: "claude"` and `credential` are not meaningful together: that path
   * has no credential. Writing both is refused; reading both ignores the
   * credential.
   */
  engine?: string | null
  model?: string | null
  /**
   * Work Complexity: `simple` | `medium` | `complex`. The host resolves it
   * against whatever the chosen credential lists — see `shared/modelFamilies.ts`.
   * Part of core's contract since 1.5.0 (the desktop shipped it earlier under
   * its own, now retired, 1.1.0); an older host ignores it and falls back to
   * `model`.
   */
  complexity?: string | null
  /**
   * Reasoning effort for {@link model} on a CLI runtime (Claude Code's `effort`,
   * Codex's `reasoning_effort`), a value that runtime offers. A desktop-side key
   * for now (the kit schema allows unknown `runtime` keys): meaningful only with
   * `model`, which is why the desktop writes it only beside one and the
   * validator warns about one without.
   */
  effort?: string | null
  credential?: string | null
  permissions?: Record<string, unknown>
  [key: string]: unknown
}

/** One Cinna instance this agent was published to. Written only at publish. */
export interface AgentPublication {
  platform_url: string
  agent_id: string
  /** Account workspace the CLI pushed from, e.g. `Cloud/acme.opencinna.io`. */
  workspace?: string | null
  imported_at?: string | null
  updated_at?: string | null
  contract_version?: string | null
  /** Hash of the exported tree at the last push; drift detection compares it. */
  content_hash?: string | null
  [key: string]: unknown
}

/**
 * One `catalog_skills[]` pin (contract 1.10.0): a skill from the platform's
 * catalog, referenced by package and revision. Its files never live under
 * `skills/`; a host downloads the pinned revision and checks it against
 * `archive_sha256`. `name` is the skill's name and must not be a folder under
 * `skills/`, a platform skill, or another pin's name.
 */
export interface CatalogSkillPin {
  package_id: string
  package_uuid: string
  name: string
  revision_number: number
  /** The pinned revision's version label, for display only. */
  version?: string | null
  archive_sha256: string
  [key: string]: unknown
}

/**
 * A skill from one of the platform's skills-format marketplaces, pinned by
 * content (contract 1.15.0): the marketplace entry and the digest of the
 * snapshot archive core serves for it. Shares one name space with `skills/`,
 * `catalog_skills[]` and the platform's own skills.
 */
export interface MarketplaceSkillPin {
  /** The marketplace entry's (plugin's) id on the instance it came from. */
  entry_uuid: string
  /** The marketplace's id; informational. */
  marketplace_uuid: string
  /** The marketplace's name when the pin was written, for display only. */
  marketplace_name: string
  name: string
  archive_sha256: string
  /** The repository commit the snapshot was read at, for display only. */
  commit_hash?: string | null
  /** The SKILL.md version label when the pin was written, for display only. */
  version?: string | null
  [key: string]: unknown
}

/** DEPRECATED predecessor of `publications[]`, still parsed. */
export interface AgentCloudStamp {
  platform_url?: string | null
  agent_id?: string | null
  imported_at?: string | null
  [key: string]: unknown
}

/** `cinna-agent.json` — the one file every tool that touches a folder agrees on. */
export interface CinnaAgentManifest {
  /** Compatibility gate. Semver of the contract the folder was scaffolded against. */
  contract_version?: string
  /** Stable identity (UUID), written once at scaffold, never rewritten. */
  id?: string
  /** Legacy integer version, tolerated but never branched on. */
  schema_version?: number
  /** Informational: which kit scaffolded this agent. */
  kit_version?: string | null
  created_at?: string | null
  name?: string
  slug?: string
  description?: string
  example_prompts?: string[]
  router_trigger_prompt?: string | null
  prompts?: AgentPrompts
  runtime?: AgentRuntimeRef | null
  /** Shell command, or a `/run:<name>` reference into `docs/CLI_COMMANDS.yaml`. */
  status_refresh_command?: string | null
  credentials?: CredentialSlot[]
  schedules?: AgentSchedule[]
  handovers?: AgentHandover[]
  features?: AgentFeatures
  /** Pinned catalog skills (1.10.0). Preserve on every rewrite; never copy one into `skills/`. */
  catalog_skills?: CatalogSkillPin[]
  /** Pinned marketplace skills (contract 1.15.0). */
  marketplace_skills?: MarketplaceSkillPin[]
  /** Legacy embedded history; new publishers write the sibling publications.json ledger. */
  publications?: AgentPublication[]
  cloud?: AgentCloudStamp
  [key: string]: unknown
}

/** Placeholders the scaffolder substitutes in `templates/agent/`. */
export const MANIFEST_TOKENS = [
  'SLUG',
  'NAME',
  'DESCRIPTION',
  'ID',
  'CONTRACT_VERSION',
  'KIT_VERSION',
  'CREATED_AT'
] as const

export type ManifestToken = (typeof MANIFEST_TOKENS)[number]

/**
 * Bounds the schema puts on `example_prompts`, declared beside the field rather
 * than inside either of the two places that enforce them.
 *
 * There are two enforcement points because reporting is not blocking.
 * `validator.ts` records a violation
 * (`manifest.example_prompts.too_many`, `manifest.example_prompts.item_too_long`)
 * and the scanner indexes the folder regardless, so
 * `synthesizeFolderAgentMetadata` applies the same bounds again to the row that
 * reaches the composer's `#` list and the agent-as-tool description an
 * orchestrating model reads. Neither can be dropped in favour of the other:
 * one tells the author, the other bounds what the model is sent.
 *
 * They live here because the bound is part of the manifest contract, not of the
 * code that happens to check it — and because this file is types and constants
 * with no runtime imports, so both enforcement points can read it without
 * either of them pulling in the other's dependencies.
 */
export const MAX_EXAMPLE_PROMPTS = 20
export const MAX_EXAMPLE_PROMPT_CHARS = 500

/** Slug rule from the schema: folder name and cloud reference. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/

/** `env_prefix` rule from the schema. */
export const ENV_PREFIX_PATTERN = /^[A-Z][A-Z0-9_]*_$/

/**
 * The prefix the kit's `scripts/cinna_credentials.py` (`derive_env_prefix`)
 * gives a slot that declares none: `Vendor Portal` → `VENDOR_PORTAL_`. Runs of
 * anything but ASCII letters and digits become `_`, the ends are stripped of
 * `_`, the rest upper-cased, `C_` put in front when it does not start with a
 * letter, and a `_` appended. Null where the script raises (nothing usable).
 */
export function deriveEnvPrefix(name: string): string | null {
  const cleaned = name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase()
  if (cleaned === '') return null
  return `${/^[A-Z]/.test(cleaned) ? '' : 'C_'}${cleaned}_`
}

/**
 * The prefix the kit reads a slot's `.env` names under (`_env_prefix`): the
 * declared `env_prefix` when it is a non-empty string, else the derived one.
 */
export function slotEnvPrefix(slot: { name?: unknown; env_prefix?: unknown }): string | null {
  if (typeof slot.env_prefix === 'string' && slot.env_prefix !== '') return slot.env_prefix
  return typeof slot.name === 'string' ? deriveEnvPrefix(slot.name) : null
}

/** `/run:<name>` reference into `docs/CLI_COMMANDS.yaml`. */
export const RUN_REFERENCE_PATTERN = /^\/run:([A-Za-z0-9][A-Za-z0-9_-]*)$/

/** The one file in an agent folder Cinna Desktop owns. */
export const DESKTOP_STATE_FILE = 'app-data/desktop.json'

/** Manifest file name, at the agent folder root. */
export const MANIFEST_FILE = 'cinna-agent.json'
