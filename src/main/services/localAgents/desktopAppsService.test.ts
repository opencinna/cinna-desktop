import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

/**
 * **Which vendor desktop apps a Mac has, from the bundle alone.** The bundle's
 * own `Info.plist` is the only file read, and the vendor id has to be in it —
 * a folder that is merely named `Claude.app` is not Claude Desktop.
 */

vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { detectDesktopApps, desktopAppRoots } = await import('./desktopAppsService')

let root: string
let second: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'desktop-apps-'))
  second = mkdtempSync(join(tmpdir(), 'desktop-apps-user-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(second, { recursive: true, force: true })
})

function plant(dir: string, bundle: string, plist: string | Buffer | null): void {
  mkdirSync(join(dir, bundle, 'Contents'), { recursive: true })
  if (plist !== null) writeFileSync(join(dir, bundle, 'Contents', 'Info.plist'), plist)
}

const xmlPlist = (id: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>\n`

/** A binary plist stores ASCII strings as raw bytes between binary markers. */
const binaryPlist = (id: string): Buffer =>
  Buffer.concat([Buffer.from('bplist00'), Buffer.from([0xd1, 0x01, 0x02, 0x5f, 0x10, id.length]), Buffer.from(id, 'ascii'), Buffer.from([0x00, 0x08, 0x0b])])

const env = (...roots: string[]): NodeJS.ProcessEnv => ({ CINNA_DESKTOP_APP_ROOTS: roots.join(delimiter) })

describe('detectDesktopApps', () => {
  it('finds Claude Desktop from an XML plist naming its bundle id', async () => {
    plant(root, 'Claude.app', xmlPlist('com.anthropic.claudefordesktop'))
    expect(await detectDesktopApps({ env: env(root) })).toEqual([
      { id: 'claude-desktop', label: 'Claude Desktop', engine: 'claude' }
    ])
  })

  it('finds ChatGPT from a binary plist, under either bundle name and either id', async () => {
    plant(second, 'ChatGPT.app', binaryPlist('com.openai.codex'))
    expect(await detectDesktopApps({ env: env(root, second) })).toEqual([
      { id: 'chatgpt', label: 'ChatGPT', engine: 'codex' }
    ])
    rmSync(join(second, 'ChatGPT.app'), { recursive: true })
    plant(root, 'Codex.app', binaryPlist('com.openai.chat'))
    expect((await detectDesktopApps({ env: env(root, second) })).map((app) => app.id)).toEqual(['chatgpt'])
  })

  it('lists both, in display order', async () => {
    plant(second, 'ChatGPT.app', xmlPlist('com.openai.chat'))
    plant(root, 'Claude.app', xmlPlist('com.anthropic.claudefordesktop'))
    expect((await detectDesktopApps({ env: env(root, second) })).map((app) => app.id)).toEqual(['claude-desktop', 'chatgpt'])
  })

  it('ignores a bundle whose plist names another id', async () => {
    plant(root, 'Claude.app', xmlPlist('com.example.notclaude'))
    plant(root, 'ChatGPT.app', xmlPlist('com.anthropic.claudefordesktop'))
    expect(await detectDesktopApps({ env: env(root) })).toEqual([])
  })

  it('ignores a bundle with no plist, and a root that does not exist', async () => {
    plant(root, 'Claude.app', null)
    expect(await detectDesktopApps({ env: env(root, join(root, 'missing')) })).toEqual([])
  })

  it('looks at nothing off macOS unless the override names roots', async () => {
    plant(root, 'Claude.app', xmlPlist('com.anthropic.claudefordesktop'))
    expect(await detectDesktopApps({ platform: 'linux', env: {} })).toEqual([])
    expect(desktopAppRoots({ platform: 'win32', env: {} })).toBeNull()
    expect((await detectDesktopApps({ platform: 'linux', env: env(root) })).map((app) => app.id)).toEqual(['claude-desktop'])
  })

  it('on macOS looks in /Applications and the user folder', () => {
    expect(desktopAppRoots({ platform: 'darwin', env: {}, home: '/Users/someone' })).toEqual([
      '/Applications',
      join('/Users/someone', 'Applications')
    ])
  })
})
