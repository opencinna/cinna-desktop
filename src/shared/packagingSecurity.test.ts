import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The packaged app must not run foreign code as itself: an open `--inspect` or
// NODE_OPTIONS fuse let any same-user process drive the main process and use
// safeStorage with no keychain prompt. See electron-builder.yml.
const root = join(__dirname, '..', '..')

function fuses(): Record<string, string> {
  const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
  const block = yml.match(/^electronFuses:\n((?: {2}\w+: \w+\n?)+)/m)
  expect(block, 'electron-builder.yml has an electronFuses block').not.toBeNull()
  return Object.fromEntries([...block![1].matchAll(/^ {2}(\w+): (\w+)$/gm)].map((m) => [m[1], m[2]]))
}

describe('packaged app hardening', () => {
  it('turns off the fuses that let another process inject code into Cinna', () => {
    const f = fuses()
    expect(f.enableNodeCliInspectArguments).toBe('false')
    expect(f.enableNodeOptionsEnvironmentVariable).toBe('false')
  })

  it('loads only the app.asar whose hash is in the signed Info.plist', () => {
    const f = fuses()
    expect(f.enableEmbeddedAsarIntegrityValidation).toBe('true')
    expect(f.onlyLoadAppFromAsar).toBe('true')
  })

  it('re-signs Electron Framework ad hoc after the flip, or an unsigned build is killed at launch', () => {
    expect(fuses().resetAdHocDarwinSignature).toBe('true')
  })

  it('keeps runAsNode on, which runtimeHost.nodeRuntime still relies on', () => {
    // When the node runtime stops being Electron itself, flip this to false and
    // change the expectation here.
    expect(fuses().runAsNode).toBe('true')
    const host = readFileSync(join(root, 'src/main/host/desktop/runtimeHost.ts'), 'utf8')
    expect(host).toContain("ELECTRON_RUN_AS_NODE: '1'")
  })

  it('gives a run-as-node child the extra-CA preload when a CA file is set, unpacked, since the NodeOptions fuse drops NODE_EXTRA_CA_CERTS', () => {
    const host = readFileSync(join(root, 'src/main/host/desktop/runtimeHost.ts'), 'utf8')
    expect(host).toMatch(/args: withCa \? \['--require', extraCaPreloadPath\(/)
    const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    const unpack = yml.match(/^asarUnpack:\n((?:\s+(?:#.*|- .*)\n)+)/m)
    expect(unpack?.[1]).toMatch(/^\s+- resources\/\*\*$/m)
    const main = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
    expect(main).toContain('installExtraCaCertificates()')
  })

  it('ships the vault helper beside the app and never re-signs it, so its keychain group survives (D17)', () => {
    const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    const mac = yml.slice(yml.indexOf('\nmac:\n'))
    expect(mac).toMatch(/^ {2}extraFiles:\n {4}- from: resources\/vault\/VaultHelper\.app\n {6}to: Library\/Helpers\/VaultHelper\.app$/m)
    const ignore = mac.match(/^ {2}signIgnore:\n {4}- (.+)$/m)?.[1]
    expect(ignore).toBeDefined()
    const re = new RegExp(ignore!)
    expect(re.test('/x/Cinna Desktop.app/Contents/Library/Helpers/VaultHelper.app')).toBe(true)
    expect(re.test('/x/Cinna Desktop.app/Contents/Library/Helpers/VaultHelper.app/Contents/MacOS/VaultHelper')).toBe(true)
    expect(re.test('/x/Cinna Desktop.app/Contents/Resources/speech/cinna-speech')).toBe(false)
    expect(yml).toContain("- '!resources/vault/**'")
    const helper = readFileSync(join(root, 'native/vault/helper/VaultHelper.entitlements'), 'utf8')
    expect(helper).toContain('<string>G5E484HA2U.io.opencinna.desktop.vault-helper</string>')
    const test = readFileSync(join(root, 'native/vault/helper/VaultHelper.test.entitlements'), 'utf8')
    expect(test).not.toContain('keychain-access-groups')
    for (const plist of [helper, test]) {
      expect(plist).toContain('com.apple.security.virtualization')
      expect(plist).not.toMatch(/allow-dyld-environment-variables|disable-library-validation|allow-jit|allow-unsigned-executable-memory|get-task-allow/)
    }
  })

  it('does not let DYLD_* environment variables reach the hardened app', () => {
    const plist = readFileSync(join(root, 'build/entitlements.mac.plist'), 'utf8')
    expect(plist).not.toContain('allow-dyld-environment-variables')
    expect(plist).not.toContain('disable-library-validation')
  })
})
