import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ARTIFACTS_SCHEMA_REPO_PATH, ARTIFACTS_PROTOCOL_VERSION } from '../kit/artifactsProtocol'
import { ArtifactToolProvider, ARTIFACTS_TOOL_SCHEMAS } from './artifacts/artifactToolProvider'

/**
 * The parity ratchet of the artifacts protocol: the tool this desktop
 * registers on its `cinna` MCP server is exactly what `artifacts.schema.json`
 * states — name, description and input schema — as cinna-core's is. The
 * schema arrives in the kit bundle with `make kit-sync`; without it the test
 * is skipped rather than failed.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const schemaPath = join(repoRoot, ARTIFACTS_SCHEMA_REPO_PATH)
const available = existsSync(schemaPath)

describe.skipIf(!available)('the cinna MCP artifact tool matches artifacts.schema.json', () => {
  const schema = available
    ? JSON.parse(readFileSync(schemaPath, 'utf8')) as { protocol_version: number; server: string; tools: Record<string, { description: string; inputSchema: unknown }> }
    : null

  it('is the protocol version this desktop implements, on the server named cinna', () => {
    expect(schema!.protocol_version).toBe(ARTIFACTS_PROTOCOL_VERSION)
    expect(schema!.server).toBe('cinna')
  })

  it('registers exactly the schema’s tools, each with its description and input schema', () => {
    const session = { scope: { profileUserId: 'p', settingsUserId: 's' }, chatId: 'c', agentId: 'a' }
    const tools = new ArtifactToolProvider(session, {} as never).getTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(schema!.tools).sort())
    for (const tool of tools) {
      expect({ [tool.name]: tool.inputSchema }).toEqual({ [tool.name]: schema!.tools[tool.name].inputSchema })
      expect(tool.description).toBe(schema!.tools[tool.name].description)
    }
    expect(Object.keys(ARTIFACTS_TOOL_SCHEMAS).sort()).toEqual(Object.keys(schema!.tools).sort())
  })
})
