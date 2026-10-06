/**
 * The Cinna Task Protocol's normative tool contract, `tasks.schema.json`.
 *
 * It is written in cinna-core and vendored into the kit bundle by
 * `make kit-sync`, beside the agent contract. Both hosts register the eight
 * `tasks_*` tools on their `cinna` MCP server and assert them equal to this
 * file (`tasksProtocolParity.test.ts` here). Nothing at runtime reads it: the
 * tool schemas live in `delegationToolProvider.ts`, and the parity test is
 * what keeps the two the same.
 */

/** The schema's path inside the bundled kit (`resources/cinna-agent-kit/`). */
export const TASKS_SCHEMA_KIT_PATH = 'protocols/tasks.schema.json'

/** The same file from the repository root, where tests read it. */
export const TASKS_SCHEMA_REPO_PATH = `resources/cinna-agent-kit/${TASKS_SCHEMA_KIT_PATH}`

/** The protocol version this desktop implements (`protocol_version` in the schema and in `tasks_targets`). */
export const TASKS_PROTOCOL_VERSION = 1
