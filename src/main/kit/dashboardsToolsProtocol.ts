/**
 * The dashboards tile tools' normative contract, `dashboards-tools.schema.json`
 * (kit contract 1.20.0).
 *
 * Written in cinna-core and vendored into the kit bundle by `make kit-sync`,
 * beside `tasks.schema.json` and `artifacts.schema.json`. The desktop registers
 * `dashboards_tiles` and `dashboards_update_tile` on its `cinna` MCP server for
 * a chat opened from a dashboard, and asserts them equal to this file
 * (`dashboardsToolsProtocolParity.test.ts`). Nothing at runtime reads it: the
 * tool schemas live in `dashboards/dashboardTileTools.ts`, and the parity test
 * keeps the two the same.
 */

/** The schema's path inside the bundled kit (`resources/cinna-agent-kit/`). */
export const DASHBOARDS_TOOLS_SCHEMA_KIT_PATH = 'protocols/dashboards-tools.schema.json'

/** The same file from the repository root, where tests read it. */
export const DASHBOARDS_TOOLS_SCHEMA_REPO_PATH = `resources/cinna-agent-kit/${DASHBOARDS_TOOLS_SCHEMA_KIT_PATH}`

/** The protocol version this desktop implements (`protocol_version` in the schema). */
export const DASHBOARDS_TOOLS_PROTOCOL_VERSION = 1
