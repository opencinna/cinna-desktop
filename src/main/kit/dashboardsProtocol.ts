/**
 * The dashboards protocol (`cinna_protocol: dashboards/1`, kit contract 1.19).
 *
 * cinna-core owns it: `protocols/dashboards.schema.json` (whose
 * `$defs.component` is the `component.json` shape) and the page bridge
 * `protocols/dashboards-bridge.js`, both vendored into the bundled kit by
 * `make kit-sync`. The desktop has no JSON Schema validator, so the component
 * scanner applies the schema's rules by hand from the constants below;
 * `dashboardsProtocolParity.test.ts` holds each one equal to the bundled
 * schema. The bridge is read from the bundle at runtime
 * (`dashboardHelper.ts`) and injected byte for byte.
 */

/** The schema's path inside the bundled kit (`resources/cinna-agent-kit/`). */
export const DASHBOARDS_SCHEMA_KIT_PATH = 'protocols/dashboards.schema.json'

/** The same file from the repository root, where tests read it. */
export const DASHBOARDS_SCHEMA_REPO_PATH = `resources/cinna-agent-kit/${DASHBOARDS_SCHEMA_KIT_PATH}`

/** The page bridge (`window.cinna`) inside the bundled kit; every host injects it unchanged. */
export const DASHBOARDS_BRIDGE_KIT_PATH = 'protocols/dashboards-bridge.js'

/** The same file from the repository root, where tests read it. */
export const DASHBOARDS_BRIDGE_REPO_PATH = `resources/cinna-agent-kit/${DASHBOARDS_BRIDGE_KIT_PATH}`

/** The protocol a `component.json` follows. */
export const DASHBOARDS_PROTOCOL = 'dashboards/1'

/** The one `schema_version` this desktop reads. */
export const DASHBOARDS_SCHEMA_VERSION = 1

/** A component's folder name. */
export const COMPONENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** An endpoint's name, as core's webapp data API names them. */
export const ENDPOINT_NAME_PATTERN = /^[a-zA-Z0-9_]+$/

/** An endpoint script, relative to the component folder: no leading slash or drive, no `..` segment, no backslash, a lowercase runtime extension. */
export const ENDPOINT_SCRIPT_PATTERN = /^(?!\/)(?![A-Za-z]:)(?!.*(^|\/)\.\.(\/|$))[^\\]+\.(py|js|mjs|cjs)$/

/** The html entry, relative to the component folder. */
export const ENTRY_PATTERN = /^(?!\/)(?![A-Za-z]:)(?!.*(^|\/)\.\.(\/|$))[^\\]+\.html$/

/** A file source, agent-relative. */
export const SOURCE_FILE_PATTERN = /^(app-data|files)\/(?!.*(^|\/)\.\.(\/|$))[^\\]+\.(md|json|csv)$/

/** A param's name. */
export const PARAM_NAME_PATTERN = /^[a-zA-Z0-9_]+$/

/** `prompts[]` limits. */
export const MAX_PROMPTS = 10
export const MAX_PROMPT_LABEL = 60
export const MAX_PROMPT_TEXT = 1000

/** The runtime is picked by the script's extension alone (the schema's endpoint convention). */
export const ENDPOINT_RUNTIMES = { '.py': 'python', '.js': 'node', '.mjs': 'node', '.cjs': 'node' } as const
export type EndpointRuntime = (typeof ENDPOINT_RUNTIMES)[keyof typeof ENDPOINT_RUNTIMES]

export const PARAM_TYPES = ['enum', 'month', 'date', 'date_range', 'text', 'number', 'boolean'] as const

/** Endpoint timeouts, in seconds. */
export const ENDPOINT_TIMEOUT_DEFAULT_S = 60
export const ENDPOINT_TIMEOUT_MAX_S = 300

/** `while_open_every`, when set, is at least this. */
export const MIN_WHILE_OPEN_EVERY_MS = 60_000

/** File sources: these extensions, under these agent-relative folders. */
export const FILE_SOURCE_EXTENSIONS = ['.md', '.json', '.csv'] as const
export const FILE_SOURCE_ROOTS = ['app-data/', 'files/'] as const
