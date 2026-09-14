import { describe, expect, it, vi } from 'vitest'

vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { canApproveDirectory, consentDialogOptions, createConsentRegistry } = await import('./consent')
const { createPathCanonicalizer } = await import('./canonicalPath')

const HOME = '/Users/me'
const registry = () => createConsentRegistry({ homeDirs: () => [HOME] })

/** Injected firmlinks: each long spelling stats as its short one; nothing else exists. */
const FIRMLINKED = ['/Users', '/Users/me', '/Users/me/projects', '/data/x', '/data/x/a.md', '/data/x/b.md']
function identity(path: string): { dev: number; ino: number } {
  const short = path.startsWith('/System/Volumes/Data/') ? path.slice('/System/Volumes/Data'.length) : path
  const index = FIRMLINKED.indexOf(short)
  if (index < 0) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  return { dev: 1, ino: index + 100 }
}
const firmlinks = createPathCanonicalizer({ platform: 'darwin', stat: async (p) => identity(p), statSync: identity })

describe('consent registry', () => {
  it('a file approval covers that file only', () => {
    const consent = registry()
    consent.approvePath('u1', '/data/x/a.md')
    expect(consent.isApproved('u1', '/data/x/a.md')).toBe(true)
    expect(consent.isApproved('u1', '/data/x/b.md')).toBe(false)
  })

  it('a folder approval covers everything under it, and nothing beside it', () => {
    const consent = registry()
    expect(consent.approveDirectory('u1', '/data/x')).toBe(true)
    expect(consent.isApproved('u1', '/data/x/b.md')).toBe(true)
    expect(consent.isApproved('u1', '/data/x/sub/c.md')).toBe(true)
    expect(consent.isApproved('u1', '/data/xy/a.md')).toBe(false)
    expect(consent.isApproved('u1', '/data/a.md')).toBe(false)
  })

  it('keeps each profile’s approvals to itself', () => {
    const consent = registry()
    consent.approvePath('u1', '/data/x/a.md')
    consent.approveDirectory('u1', '/data/y')
    expect(consent.isApproved('u2', '/data/x/a.md')).toBe(false)
    expect(consent.isApproved('u2', '/data/y/b.md')).toBe(false)
  })

  it('refuses to approve the home, a folder holding it, the root or a volume root as a folder', () => {
    const consent = registry()
    for (const dir of [HOME, '/Users', '/', '/Volumes/Drive', '/Volumes', '/media/me/usb', '/mnt/disk']) {
      expect(consent.approveDirectory('u1', dir)).toBe(false)
    }
    expect(consent.isApproved('u1', `${HOME}/secret.md`)).toBe(false)
    expect(consent.isApproved('u1', '/Users/other/a.md')).toBe(false)
    expect(consent.isApproved('u1', '/etc/hosts')).toBe(false)
    expect(consent.isApproved('u1', '/Volumes/Drive/a.md')).toBe(false)
  })

  it('allows folders below those, and beside the home', () => {
    expect(canApproveDirectory(`${HOME}/projects`, [HOME])).toBe(true)
    expect(canApproveDirectory('/Users/other', [HOME])).toBe(true)
    expect(canApproveDirectory('/Volumes/Drive/work', [HOME])).toBe(true)
    expect(canApproveDirectory('/media/me/usb/work', [HOME])).toBe(true)
  })
})

describe('consent registry — macOS data-volume spelling', () => {
  const consent = () => createConsentRegistry({ homeDirs: () => [HOME], paths: firmlinks })

  it('refuses the home, and what holds it, spelled through the data volume', () => {
    for (const dir of ['/System/Volumes/Data/Users/me', '/System/Volumes/Data/Users', '/System/Volumes/Data']) {
      expect(canApproveDirectory(dir, [HOME], firmlinks)).toBe(false)
      expect(consent().canApproveDirectory(dir)).toBe(false)
    }
    expect(canApproveDirectory('/System/Volumes/Data/Users/me/projects', [HOME], firmlinks)).toBe(true)
  })

  it('an approval under one spelling covers the other, and only that', () => {
    const registry = consent()
    registry.approvePath('u1', '/System/Volumes/Data/data/x/a.md')
    expect(registry.isApproved('u1', '/data/x/a.md')).toBe(true)
    expect(registry.isApproved('u1', '/data/x/b.md')).toBe(false)
    expect(registry.approveDirectory('u1', '/data/x')).toBe(true)
    expect(registry.isApproved('u1', '/System/Volumes/Data/data/x/b.md')).toBe(true)
  })
})

describe('consentDialogOptions', () => {
  const file = {
    agentName: 'GFCA',
    kind: 'file' as const,
    path: '/Users/me/work/pulled/a.md',
    dir: '/Users/me/work/pulled',
    displayPath: '~/work/pulled/a.md',
    displayDir: '~/work/pulled',
    offerDir: true,
    previewable: true
  }

  it('asks about a previewable file in ~/ paths, says it reads it, and offers its folder', () => {
    expect(consentDialogOptions(file, 'darwin')).toMatchObject({
      buttons: ['Show file', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: "Show a file outside GFCA's folder?",
      detail: '~/work/pulled/a.md\n\nCinna reads it to preview it here.\n\nFolder: ~/work/pulled',
      checkboxLabel: "Don't ask again for anything inside “pulled” until Cinna restarts",
      checkboxChecked: false
    })
  })

  it('shows the path alone for a file it will not read, and omits the checkbox when the folder may not be approved', () => {
    const options = consentDialogOptions({ ...file, previewable: false, offerDir: false }, 'darwin')
    expect(options.detail).toBe('~/work/pulled/a.md')
    expect(options).not.toHaveProperty('checkboxLabel')
  })

  it('sets the offered folder apart with a blank line for a file it will not read', () => {
    expect(consentDialogOptions({ ...file, previewable: false }, 'darwin').detail).toBe(
      '~/work/pulled/a.md\n\nFolder: ~/work/pulled'
    )
  })

  it.each([
    ['darwin', 'Show in Finder'],
    ['linux', 'Show in folder'],
    ['win32', 'Show in folder']
  ] as const)('asks about a folder on %s with %j, naming it once', (platform, button) => {
    const folder = {
      ...file,
      kind: 'dir' as const,
      path: '/Users/me/work/pulled',
      displayPath: '~/work/pulled',
      previewable: false
    }
    // The folder a "don't ask again" covers is the one already named: no `Folder:` line.
    expect(consentDialogOptions(folder, platform)).toMatchObject({
      buttons: [button, 'Cancel'],
      message: "Show a folder outside GFCA's folder?",
      detail: '~/work/pulled',
      checkboxLabel: "Don't ask again for anything inside “pulled” until Cinna restarts"
    })
    expect(consentDialogOptions({ ...folder, offerDir: false }, platform).detail).toBe('~/work/pulled')
  })
})
