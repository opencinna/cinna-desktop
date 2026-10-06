import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TASKS_SCHEMA_REPO_PATH, TASKS_PROTOCOL_VERSION } from '../kit/tasksProtocol'
import { DelegationToolProvider, TASKS_TOOL_SCHEMAS } from './delegationToolProvider'

/**
 * The parity ratchet of the Cinna Task Protocol: the tools this desktop
 * registers on its `cinna` MCP server are exactly the tools `tasks.schema.json`
 * states — names and input schemas — as cinna-core's are. The schema arrives
 * in the kit bundle with `make kit-sync`; `CINNA_TASKS_SCHEMA` points a local
 * run at another copy (a draft, cinna-core's own). With neither, the test is
 * skipped rather than failed, so a tree before the sync stays green.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const override = process.env.CINNA_TASKS_SCHEMA
const schemaPath = override ? (isAbsolute(override) ? override : join(repoRoot, override)) : join(repoRoot, TASKS_SCHEMA_REPO_PATH)
const available = existsSync(schemaPath)

type Json = Record<string, unknown>

/** Write out every `#/$defs/<name>` reference, a local key beside it winning (a `description`, say). */
function inline(value: unknown, defs: Json): unknown {
  if (Array.isArray(value)) return value.map((item) => inline(item, defs))
  if (!value || typeof value !== 'object') return value
  const { $ref, ...rest } = value as Json
  const resolved: Json = {}
  if (typeof $ref === 'string') {
    const name = /^#\/\$defs\/(.+)$/.exec($ref)?.[1]
    if (!name || !(name in defs)) throw new Error(`Unresolvable $ref ${$ref}`)
    Object.assign(resolved, inline(defs[name], defs))
  }
  for (const [key, child] of Object.entries(rest)) resolved[key] = inline(child, defs)
  return resolved
}

describe.skipIf(!available)(`the cinna MCP tools match tasks.schema.json${available ? '' : ' (skipped: no schema yet — run make kit-sync, or set CINNA_TASKS_SCHEMA)'}`, () => {
  const schema = available ? JSON.parse(readFileSync(schemaPath, 'utf8')) as { protocol_version: number; server: string; $defs: Json; tools: Record<string, { inputSchema: Json }> } : null

  it('is the protocol version this desktop implements, on the server named cinna', () => {
    expect(schema!.protocol_version).toBe(TASKS_PROTOCOL_VERSION)
    expect(schema!.server).toBe('cinna')
  })

  it('registers exactly the schema’s tools, each with its input schema', () => {
    const session = { scope: { profileUserId: 'p', settingsUserId: 's' }, chatId: 'c', agentId: 'a' }
    const tools = new DelegationToolProvider(session).getTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(schema!.tools).sort())
    for (const tool of tools) {
      expect({ [tool.name]: tool.inputSchema }).toEqual({ [tool.name]: inline(schema!.tools[tool.name].inputSchema, schema!.$defs) })
    }
    expect(Object.keys(TASKS_TOOL_SCHEMAS).sort()).toEqual(Object.keys(schema!.tools).sort())
  })
})
