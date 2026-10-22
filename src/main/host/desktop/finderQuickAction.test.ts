import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))

const {
  COMMAND_TOKEN,
  QUICK_ACTION_BUNDLE_NAME,
  appBundleOf,
  createFinderQuickAction,
  quickActionCommand,
  quickActionErrorMessage,
  substituteCommand,
  xmlEscape
} = await import('./finderQuickAction')

const TEMPLATE = resolve(__dirname, '..', '..', '..', '..', 'resources', 'finder', QUICK_ACTION_BUNDLE_NAME)
const DEV_APP = "/Users/o'neil/dev/cinna & co/node_modules/electron/dist/Electron.app"

let home: string
let command: string
const refreshServices = vi.fn(async () => undefined)

function service(platform: NodeJS.Platform = 'darwin') {
  return createFinderQuickAction({ platform, home: () => home, templateDir: () => TEMPLATE, command: () => command, refreshServices })
}
const installed = (): string => join(home, 'Library', 'Services', QUICK_ACTION_BUNDLE_NAME)
const installedDocument = (): string => readFileSync(join(installed(), 'Contents', 'document.wflow'), 'utf8')

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cinna-finder-qa-'))
  command = 'open -b io.opencinna.desktop "$@"'
  refreshServices.mockClear()
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('the template', () => {
  it('is a files-and-folders Finder service named Mention in Cinna, with a command placeholder', () => {
    const info = readFileSync(join(TEMPLATE, 'Contents', 'Info.plist'), 'utf8')
    expect(info).toContain('<string>Mention in Cinna</string>')
    expect(info).toMatch(/<key>NSSendFileTypes<\/key>\s*<array>\s*<string>public\.item<\/string>\s*<\/array>/)
    expect(info).not.toContain('NSRequiredContext')
    expect(info).toMatch(/<key>CinnaQuickActionVersion<\/key>\s*<string>\d+<\/string>/)
    const document = readFileSync(join(TEMPLATE, 'Contents', 'document.wflow'), 'utf8')
    expect(document.split(COMMAND_TOKEN)).toHaveLength(2)
    expect(document).toMatch(/<key>inputMethod<\/key>\s*<integer>1<\/integer>/)
    expect(document).toMatch(/<key>shell<\/key>\s*<string>\/bin\/zsh<\/string>/)
    expect(document).toMatch(/<key>serviceInputTypeIdentifier<\/key>\s*<string>com\.apple\.Automator\.fileSystemObject<\/string>/)
  })
})

describe('the command', () => {
  it('opens the packaged app by bundle id', () => {
    expect(quickActionCommand({ defaultApp: false, execPath: '/Applications/Cinna Desktop.app/Contents/MacOS/Cinna Desktop' }))
      .toBe('open -b io.opencinna.desktop "$@"')
  })

  it('opens the running Electron.app under npm run dev, shell-quoted', () => {
    expect(appBundleOf(`${DEV_APP}/Contents/MacOS/Electron`)).toBe(DEV_APP)
    expect(quickActionCommand({ defaultApp: true, execPath: `${DEV_APP}/Contents/MacOS/Electron` }))
      .toBe(`open -a '/Users/o'\\''neil/dev/cinna & co/node_modules/electron/dist/Electron.app' "$@"`)
  })

  it('is XML-escaped into the workflow', () => {
    const shell = quickActionCommand({ defaultApp: true, execPath: `${DEV_APP}/Contents/MacOS/Electron` })
    const out = substituteCommand(`<string>${COMMAND_TOKEN}</string>`, shell)
    expect(out).toBe(`<string>open -a &apos;/Users/o&apos;\\&apos;&apos;neil/dev/cinna &amp; co/node_modules/electron/dist/Electron.app&apos; &quot;$@&quot;</string>`)
    expect(xmlEscape('<a>')).toBe('&lt;a&gt;')
    expect(substituteCommand('<string>no token</string>', shell)).toBeNull()
  })
})

describe('install, status, uninstall', () => {
  it('is unsupported and refuses off macOS', async () => {
    const qa = service('linux')
    expect(qa.status()).toEqual({ supported: false, installed: false, outdated: false })
    expect((await qa.install()).success).toBe(false)
    expect(existsSync(installed())).toBe(false)
  })

  it('installs into ~/Library/Services with the command substituted, and asks macOS to refresh', async () => {
    const qa = service()
    expect(qa.status()).toEqual({ supported: true, installed: false, outdated: false })
    const result = await qa.install()
    expect(result).toEqual({ success: true, status: { supported: true, installed: true, outdated: false } })
    expect(installedDocument()).toContain('<string>open -b io.opencinna.desktop &quot;$@&quot;</string>')
    expect(installedDocument()).not.toContain(COMMAND_TOKEN)
    expect(existsSync(join(installed(), 'Contents', 'Info.plist'))).toBe(true)
    expect(refreshServices).toHaveBeenCalledTimes(1)
  })

  it('reports outdated when the app location changed or the template version moved, and install overwrites', async () => {
    const qa = service()
    await qa.install()
    command = `open -a '/elsewhere/Electron.app' "$@"`
    expect(qa.status().outdated).toBe(true)
    await qa.install()
    expect(qa.status().outdated).toBe(false)
    expect(installedDocument()).toContain('/elsewhere/Electron.app')

    const info = join(installed(), 'Contents', 'Info.plist')
    writeFileSync(info, readFileSync(info, 'utf8').replace(/(<key>CinnaQuickActionVersion<\/key>\s*<string>)\d+/, '$10'))
    expect(qa.status().outdated).toBe(true)
    writeFileSync(join(installed(), 'Contents', 'stale.txt'), 'left over')
    await qa.install()
    expect(qa.status()).toEqual({ supported: true, installed: true, outdated: false })
    expect(existsSync(join(installed(), 'Contents', 'stale.txt'))).toBe(false)
  })

  it('a refresh failure does not fail the install', async () => {
    refreshServices.mockRejectedValueOnce(new Error('pbs missing'))
    expect((await service().install()).success).toBe(true)
  })

  it('uninstall removes only that bundle, and is fine when it is already gone', async () => {
    const qa = service()
    await qa.install()
    const neighbour = join(home, 'Library', 'Services', 'Other.workflow')
    mkdirSync(neighbour)
    expect(await qa.uninstall()).toEqual({ success: true, status: { supported: true, installed: false, outdated: false } })
    expect(existsSync(installed())).toBe(false)
    expect(existsSync(neighbour)).toBe(true)
    expect(refreshServices).toHaveBeenCalledTimes(2)
    expect((await qa.uninstall()).success).toBe(true)
  })

  it('leaves something at the path that is not a directory in place and says so', async () => {
    mkdirSync(join(home, 'Library', 'Services'), { recursive: true })
    const target = join(home, 'elsewhere')
    mkdirSync(target)
    symlinkSync(target, installed())
    const result = await service().uninstall()
    expect(result.success).toBe(false)
    expect(result).toMatchObject({ error: `~/Library/Services/${QUICK_ACTION_BUNDLE_NAME} isn’t a Quick Action; Cinna left it in place.` })
    expect(existsSync(target)).toBe(true)
    expect(existsSync(installed())).toBe(true)
  })
})

describe('failures', () => {
  // A sentence the user can act on; never Node's message, never a path under
  // the real home.
  it('says ~/Library/Services is not a folder when it is a file', async () => {
    mkdirSync(join(home, 'Library'), { recursive: true })
    writeFileSync(join(home, 'Library', 'Services'), 'not a folder')
    const result = await service().install()
    expect(result).toMatchObject({ success: false, error: '~/Library/Services isn’t a folder.' })
  })

  it('says the same when a folder above it is a file', async () => {
    writeFileSync(join(home, 'Library'), 'not a folder')
    expect(await service().install()).toMatchObject({ success: false, error: '~/Library/Services isn’t a folder.' })
  })

  it('falls back to a plain sentence for anything else, without the raw message or a path', async () => {
    const qa = createFinderQuickAction({
      platform: 'darwin', home: () => home, templateDir: () => join(home, 'no-template'), command: () => command, refreshServices
    })
    const result = await qa.install()
    expect(result).toMatchObject({ success: false, error: 'Could not install the Quick Action.' })
    expect(JSON.stringify(result)).not.toContain(home)
  })

  it.each([
    ['EACCES', 'install', 'Cinna can’t write to ~/Library/Services.'],
    ['EPERM', 'remove', 'Cinna can’t write to ~/Library/Services.'],
    ['EEXIST', 'install', '~/Library/Services isn’t a folder.'],
    ['ENOTDIR', 'remove', '~/Library/Services isn’t a folder.'],
    ['EIO', 'install', 'Could not install the Quick Action.'],
    ['EIO', 'remove', 'Could not remove the Quick Action.']
  ] as const)('maps %s on %s to a sentence', (code, action, message) => {
    const err = Object.assign(new Error(`${code}: /Users/someone/Library/Services`), { code })
    expect(quickActionErrorMessage(err, action)).toBe(message)
  })
})
