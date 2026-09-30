import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearOpenInBrowserCopies, openInBrowserRoot, prepareOpenInBrowserDir } from './openInBrowserCopies'

/** Where Open in browser writes an attachment's copy, and that the copies go at start. */

let userData: string

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'cinna-open-in-browser-'))
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

const mode = (path: string): number => statSync(path).mode & 0o777

describe('open-in-browser copies', () => {
  it("go under the profile's userData, in folders only the user may enter", async () => {
    const dir = await prepareOpenInBrowserDir(userData, 'u1', 'att-1')
    expect(dir.startsWith(join(userData, 'html-open-in-browser') + '/')).toBe(true)
    expect(dir).not.toContain('att-1')
    if (process.platform !== 'win32') {
      expect(mode(openInBrowserRoot(userData))).toBe(0o700)
      expect(mode(dir)).toBe(0o700)
    }
  })

  it('get one folder per profile and attachment, emptied for each new copy', async () => {
    const dir = await prepareOpenInBrowserDir(userData, 'u1', 'att-1')
    writeFileSync(join(dir, 'old.html'), 'old')
    expect(await prepareOpenInBrowserDir(userData, 'u1', 'att-1')).toBe(dir)
    expect(existsSync(join(dir, 'old.html'))).toBe(false)
    expect(await prepareOpenInBrowserDir(userData, 'u2', 'att-1')).not.toBe(dir)
  })

  it('are all removed at start, and a start with none is fine', async () => {
    const dir = await prepareOpenInBrowserDir(userData, 'u1', 'att-1')
    writeFileSync(join(dir, 'page.html'), 'x')
    await clearOpenInBrowserCopies(userData)
    expect(existsSync(openInBrowserRoot(userData))).toBe(false)
    await expect(clearOpenInBrowserCopies(userData)).resolves.toBeUndefined()
  })
})
