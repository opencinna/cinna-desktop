/**
 * The artifacts protocol's normative tool contract, `artifacts.schema.json`.
 *
 * Written in cinna-core and vendored into the kit bundle by `make kit-sync`,
 * beside `tasks.schema.json`. The desktop registers `artifacts_publish` on its
 * `cinna` MCP server and asserts it equal to this file
 * (`artifactsProtocolParity.test.ts`). Nothing at runtime reads it: the tool
 * schema lives in `artifactToolProvider.ts`, and the parity test keeps the two
 * the same.
 */

/** The schema's path inside the bundled kit (`resources/cinna-agent-kit/`). */
export const ARTIFACTS_SCHEMA_KIT_PATH = 'protocols/artifacts.schema.json'

/** The same file from the repository root, where tests read it. */
export const ARTIFACTS_SCHEMA_REPO_PATH = `resources/cinna-agent-kit/${ARTIFACTS_SCHEMA_KIT_PATH}`

/** The protocol version this desktop implements (`protocol_version` in the schema). */
export const ARTIFACTS_PROTOCOL_VERSION = 1
