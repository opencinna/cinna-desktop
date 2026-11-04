import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DASHBOARDS_TOOLS_SCHEMA_REPO_PATH, DASHBOARDS_TOOLS_PROTOCOL_VERSION } from '../kit/dashboardsToolsProtocol'
import { DashboardTileToolProvider, DASHBOARD_TOOL_ERROR_CODES, DASHBOARDS_TOOL_SCHEMAS } from './dashboards/dashboardTileTools'

/**
 * The parity ratchet of the dashboards tile tools: the tools this desktop
 * registers on its `cinna` MCP server for a dashboard chat are exactly what
 * `dashboards-tools.schema.json` states — names, descriptions and input
 * schemas, `$ref`s written out. The schema arrives in the kit bundle with
 * `make kit-sync`; without it the test is skipped rather than failed.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const schemaPath = join(repoRoot, DASHBOARDS_TOOLS_SCHEMA_REPO_PATH)
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

describe.skipIf(!available)('the cinna MCP dashboard tile tools match dashboards-tools.schema.json', () => {
  const schema = available
    ? JSON.parse(readFileSync(schemaPath, 'utf8')) as { protocol_version: number; server: string; $defs: Json; tools: Record<string, { description: string; inputSchema: Json }> }
    : null

  it('is the protocol version this desktop implements, on the server named cinna', () => {
    expect(schema!.protocol_version).toBe(DASHBOARDS_TOOLS_PROTOCOL_VERSION)
    expect(schema!.server).toBe('cinna')
  })

  it('registers exactly the schema’s tools, each with its description and input schema', () => {
    const tools = new DashboardTileToolProvider({ profileUserId: 'p', chatId: 'c', agentId: 'a' }, {} as never).getTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(schema!.tools).sort())
    for (const tool of tools) {
      expect({ [tool.name]: tool.inputSchema }).toEqual({ [tool.name]: inline(schema!.tools[tool.name].inputSchema, schema!.$defs) })
      expect(tool.description).toBe(schema!.tools[tool.name].description)
    }
    expect(Object.keys(DASHBOARDS_TOOL_SCHEMAS).sort()).toEqual(Object.keys(schema!.tools).sort())
  })

  it('answers errors only with the schema’s codes', () => {
    const codes = (schema!.$defs.error as { properties: { error: { properties: { code: { enum: string[] } } } } }).properties.error.properties.code.enum
    expect([...codes].sort()).toEqual([...DASHBOARD_TOOL_ERROR_CODES].sort())
  })
})
