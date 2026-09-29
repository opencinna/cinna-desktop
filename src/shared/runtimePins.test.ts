import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUNTIME_PINS } from './runtimePins'
import { PINNED_CLAUDE_VERSION, PINNED_CODEX_VERSION, PINNED_ENGINE_VERSION } from './engine'

/**
 * The manifest is the only place a runtime version lives — except for the two
 * files that cannot import TypeScript. This test is what makes that exception
 * safe: `package.json` and the adapter patch files may repeat a value, and a
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

  it('claudeAdapterPatch.json, read by the CommonJS install hooks, equals the manifest', () => {
    expect(readJson('src/main/agents/drivers/acp/claudeAdapterPatch.json')).toEqual({
      version: RUNTIME_PINS.claude.adapter,
      originalSha256: RUNTIME_PINS.claude.adapterOriginalSha256,
      patchedSha256: RUNTIME_PINS.claude.adapterPatchedSha256
    })
  })

  it('the OpenCode pin the engine exports is the manifest’s', () => {
    expect(PINNED_ENGINE_VERSION).toBe(RUNTIME_PINS.opencode.cli)
  })

  it('every asset row is a well-formed pin', () => {
    for (const [tool, pin] of Object.entries({ claude: RUNTIME_PINS.claude, codex: RUNTIME_PINS.codex, opencode: RUNTIME_PINS.opencode, git: RUNTIME_PINS.git })) {
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

  it('every Codex asset carries the code-mode host of the same release and triple', () => {
    // 0.155.0 loses Code Mode without `codex-code-mode-host` beside `codex`.
    for (const [platform, asset] of Object.entries(RUNTIME_PINS.codex.assets)) {
      const triple = asset.executable!.replace(/^codex-/, '')
      expect(asset.companions, platform).toHaveLength(1)
      const host = asset.companions![0]!
      expect(host.sha256, platform).toMatch(/^[0-9a-f]{64}$/)
      expect(host.sha256, platform).not.toBe(asset.sha256)
      expect(host.size, platform).toBeGreaterThan(0)
      expect(host.executable, platform).toBe(`codex-code-mode-host-${triple}`)
      expect(host.file, platform).toBe(`codex-code-mode-host-${triple}.tar.gz`)
      expect(host.url, platform).toBe(
        `https://github.com/openai/codex/releases/download/rust-v${RUNTIME_PINS.codex.cli}/${host.file}`
      )
      expect(host.installAs, platform).toBe('codex-code-mode-host')
    }
  })

  it('every Claude asset is the executable itself, of the pinned release, from the vendor bucket, with its size', () => {
    const release = 'https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases'
    for (const [platform, asset] of Object.entries(RUNTIME_PINS.claude.assets)) {
      expect(asset.url, platform).toBe(`${release}/${RUNTIME_PINS.claude.cli}/${platform}/claude`)
      // This is what stops the installer running tar on an executable.
      expect(asset.format, platform).toBe('executable')
      // The size is the download's ceiling: absent, a ~215 MB file is refused
      // by a guard sized for archives.
      expect(asset.size, platform).toBeGreaterThan(200 * 1024 * 1024)
    }
    expect(RUNTIME_PINS.claude.versionOutput).toBe(`${RUNTIME_PINS.claude.cli} (Claude Code)`)
  })

  it('every git asset is a dugite-native tarball of the pinned release, POSIX only, with its size', () => {
    const release = `https://github.com/desktop/dugite-native/releases/download/${RUNTIME_PINS.git.release}`
    const plats: Record<string, string> = {
      'darwin-arm64': 'macOS-arm64',
      'darwin-x64': 'macOS-x64',
      'linux-x64': 'ubuntu-x64',
      'linux-arm64': 'ubuntu-arm64'
    }
    // The wrapper is a POSIX shell script: no Windows row may creep in.
    expect(Object.keys(RUNTIME_PINS.git.assets).sort()).toEqual(Object.keys(plats).sort())
    for (const [platform, asset] of Object.entries(RUNTIME_PINS.git.assets)) {
      expect(asset.file, platform).toBe(`dugite-native-v${RUNTIME_PINS.git.cli}-4098283-${plats[platform]}.tar.gz`)
      expect(asset.url, platform).toBe(`${release}/${asset.file}`)
      // An archive holding a tree, not an executable to move into place.
      expect(asset.format, platform).toBeUndefined()
      expect(asset.size, platform).toBeGreaterThan(10 * 1024 * 1024)
    }
    expect(new Set(Object.values(RUNTIME_PINS.git.assets).map((asset) => asset.sha256)).size).toBe(4)
    expect(RUNTIME_PINS.git.release).toBe(`v${RUNTIME_PINS.git.cli}-4`)
    expect(RUNTIME_PINS.git.versionOutput).toBe(`git version ${RUNTIME_PINS.git.cli}`)
  })

  it('the versions the renderer shows are the manifest’s', () => {
    expect(PINNED_CLAUDE_VERSION).toBe(RUNTIME_PINS.claude.cli)
    expect(PINNED_CODEX_VERSION).toBe(RUNTIME_PINS.codex.cli)
  })
})
