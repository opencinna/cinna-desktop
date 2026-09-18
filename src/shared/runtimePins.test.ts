import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUNTIME_PINS } from './runtimePins'
import { PINNED_ENGINE_VERSION } from './engine'

/**
 * The manifest is the only place a runtime version lives — except for the two
 * files that cannot import TypeScript. This test is what makes that exception
 * safe: `package.json` and `codexAdapterPatch.json` may repeat a value, and a
 * bump that touches one side only fails here rather than at a user's first turn.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(repoRoot, path), 'utf8')) as Record<string, unknown>

describe('runtime pins', () => {
  it('package.json pins exactly the adapter versions the manifest names', () => {
    const dependencies = readJson('package.json').dependencies as Record<string, string>
    // Exact strings: a `^` range here would let `npm install` move the adapter
    // off the version the patch checksum and the contract snapshot describe.
    expect(dependencies['@agentclientprotocol/codex-acp']).toBe(RUNTIME_PINS.codex.adapter)
    expect(dependencies['@agentclientprotocol/claude-agent-acp']).toBe(RUNTIME_PINS.claude.adapter)
  })

  it('codexAdapterPatch.json, read by the CommonJS install hooks, equals the manifest', () => {
    expect(readJson('src/main/agents/drivers/acp/codexAdapterPatch.json')).toEqual({
      version: RUNTIME_PINS.codex.adapter,
      originalSha256: RUNTIME_PINS.codex.adapterOriginalSha256,
      patchedSha256: RUNTIME_PINS.codex.adapterPatchedSha256
    })
  })

  it('the OpenCode pin the engine exports is the manifest’s', () => {
    expect(PINNED_ENGINE_VERSION).toBe(RUNTIME_PINS.opencode.cli)
  })

  it('every asset row is a well-formed pin', () => {
    for (const [tool, pin] of Object.entries({ codex: RUNTIME_PINS.codex, opencode: RUNTIME_PINS.opencode })) {
      expect(Object.keys(pin.assets).length, tool).toBeGreaterThan(0)
      for (const [platform, asset] of Object.entries(pin.assets)) {
        expect(asset.sha256, `${tool} ${platform}`).toMatch(/^[0-9a-f]{64}$/)
        expect(asset.file, `${tool} ${platform}`).not.toBe('')
      }
    }
  })

  it('every Codex asset comes from the pinned release and names its executable', () => {
    for (const [platform, asset] of Object.entries(RUNTIME_PINS.codex.assets)) {
      expect(asset.url, platform).toBe(
        `https://github.com/openai/codex/releases/download/rust-v${RUNTIME_PINS.codex.cli}/${asset.file}`
      )
      expect(asset.executable, platform).toMatch(/^codex-[a-z0-9_]+-[a-z0-9-]+$/)
    }
    expect(RUNTIME_PINS.codex.versionOutput).toBe(`codex-cli ${RUNTIME_PINS.codex.cli}`)
  })
})
