/**
 * TypeScript mirror of the kit contract's `schema/cinna-agent.schema.json`
 * (`resources/cinna-kit-contract/`). Shared between main (scaffolder, scanner,
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
  description?: string
  /** Prefix of the local `.env` variable names: `<env_prefix><FIELD>`. */
  env_prefix?: string
  fields?: string[]
  optional?: boolean
  [key: string]: unknown
}

export type ScheduleType = 'static_prompt' | 'script_trigger'

/** Unattended run. Declared locally, created on the platform at import time. */
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
 */
export interface AgentRuntimeRef {
  model?: string | null
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

/** Slug rule from the schema: folder name and cloud reference. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/

/** `env_prefix` rule from the schema. */
export const ENV_PREFIX_PATTERN = /^[A-Z][A-Z0-9_]*_$/

/** `/run:<name>` reference into `docs/CLI_COMMANDS.yaml`. */
export const RUN_REFERENCE_PATTERN = /^\/run:([A-Za-z0-9][A-Za-z0-9_-]*)$/

/** The one file in an agent folder Cinna Desktop owns. */
export const DESKTOP_STATE_FILE = 'app-data/desktop.json'

/** Manifest file name, at the agent folder root. */
export const MANIFEST_FILE = 'cinna-agent.json'
