import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  NOT_A_FILE_ERROR,
  clearPastedFiles,
  clipboardFilePaths,
  fileUrlToPath,
  parseFilenamesPlist,
  parseUriList,
  pastedImageName,
  pastedRoot,
  resolvePastedFiles
} from './pastedFiles'

/** A paste attaches the files the clipboard references, else its image as a PNG, else nothing. */

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
	<string>/Users/me/Desktop/Q3 report.pdf</string>
	<string>/Users/me/Desktop/R&amp;D &lt;draft&gt;.txt</string>
</array>
</plist>
`

describe('clipboard file references', () => {
  it('turns a file URL into a path, decoding escapes, and refuses anything else', () => {
    expect(fileUrlToPath('file:///Users/me/Desktop/Q3%20report.pdf')).toBe('/Users/me/Desktop/Q3 report.pdf')
    expect(fileUrlToPath('  file:///tmp/a.png\n')).toBe('/tmp/a.png')
    expect(fileUrlToPath('https://example.com/a.png')).toBeNull()
    expect(fileUrlToPath('/tmp/a.png')).toBeNull()
    expect(fileUrlToPath('file://remote-host/share/a.png')).toBeNull()
  })

  it('reads every path of a multi-file NSFilenamesPboardType plist, entities decoded', () => {
    expect(parseFilenamesPlist(PLIST)).toEqual(['/Users/me/Desktop/Q3 report.pdf', '/Users/me/Desktop/R&D <draft>.txt'])
    expect(parseFilenamesPlist('')).toEqual([])
    expect(parseFilenamesPlist('<array><string>relative/path</string></array>')).toEqual([])
  })

  it('reads a text/uri-list, skipping comments and non-file URLs', () => {
    expect(parseUriList('# copied\r\nfile:///home/me/a.png\r\nhttps://x.test/b\r\nfile:///home/me/b%20c.txt\n')).toEqual([
      '/home/me/a.png',
      '/home/me/b c.txt'
    ])
  })

  it('prefers the plist (all files) over public.file-url (the first), without duplicates', () => {
    expect(clipboardFilePaths({ fileUrl: 'file:///Users/me/Desktop/Q3%20report.pdf', filenamesPlist: PLIST })).toEqual([
      '/Users/me/Desktop/Q3 report.pdf',
      '/Users/me/Desktop/R&D <draft>.txt'
    ])
    expect(clipboardFilePaths({ fileUrl: 'file:///tmp/one.png' })).toEqual(['/tmp/one.png'])
    expect(clipboardFilePaths({ fileNameW: Buffer.from('C:\\Users\\me\\a.png\0', 'utf16le') })).toEqual(['C:\\Users\\me\\a.png'])
    expect(clipboardFilePaths({})).toEqual([])
  })
})

describe('the pasted image name', () => {
  it('is dated in local time like a macOS screenshot, with a counter from the second', () => {
    const at = new Date(2026, 8, 30, 9, 5, 7)
    expect(pastedImageName(at)).toBe('Pasted image 2026-09-30 at 09.05.07.png')
    expect(pastedImageName(at, 2)).toBe('Pasted image 2026-09-30 at 09.05.07 (2).png')
  })
})

describe('resolvePastedFiles', () => {
  let root: string
  let dir: string
  const now = new Date(2026, 8, 30, 14, 0, 0)
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  const noImage = (): Buffer | null => {
    throw new Error('the image must not be read when files are referenced')
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cinna-paste-'))
    dir = pastedRoot(join(root, 'userData'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('attaches referenced regular files before ever reading the image (a Finder copy carries the icon)', async () => {
    const file = join(root, 'a b.txt')
    await writeFile(file, 'x')
    const paths = await resolvePastedFiles({ sources: { fileUrl: pathToFileURL(file).href }, readImagePng: noImage, dir, now })
    expect(paths).toEqual([file])
  })

  it('keeps the files of a mixed copy and drops its folders', async () => {
    const file = join(root, 'keep.md')
    const folder = join(root, 'folder')
    await writeFile(file, 'x')
    await mkdir(folder)
    const plist = `<array><string>${folder}</string><string>${file}</string></array>`
    expect(await resolvePastedFiles({ sources: { filenamesPlist: plist }, readImagePng: noImage, dir, now })).toEqual([file])
  })

  it("refuses a copied folder with the drop's sentence", async () => {
    const folder = join(root, 'folder')
    await mkdir(folder)
    await expect(
      resolvePastedFiles({ sources: { fileUrl: pathToFileURL(folder).href }, readImagePng: noImage, dir, now })
    ).rejects.toMatchObject({ code: 'not_a_file', message: NOT_A_FILE_ERROR })
  })

  it('writes an image with no references as a dated PNG, never over an earlier one', async () => {
    const first = await resolvePastedFiles({ sources: {}, readImagePng: () => png, dir, now })
    const second = await resolvePastedFiles({ sources: {}, readImagePng: () => png, dir, now })
    expect(first).toEqual([join(dir, 'Pasted image 2026-09-30 at 14.00.00.png')])
    expect(second).toEqual([join(dir, 'Pasted image 2026-09-30 at 14.00.00 (2).png')])
    expect(await readFile(first[0])).toEqual(png)
  })

  it('attaches nothing when the clipboard holds neither', async () => {
    expect(await resolvePastedFiles({ sources: {}, readImagePng: () => null, dir, now })).toEqual([])
    expect(await resolvePastedFiles({ sources: {}, readImagePng: () => Buffer.alloc(0), dir, now })).toEqual([])
  })

  it('clears every pasted image at start', async () => {
    await resolvePastedFiles({ sources: {}, readImagePng: () => png, dir, now })
    await clearPastedFiles(join(root, 'userData'))
    expect(await readdir(join(root, 'userData', 'tmp'))).toEqual([])
  })
})
