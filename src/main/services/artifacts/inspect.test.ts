import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decideKind, exclusionFor, inspectArtifactPath } from './inspect'
import { FALLBACK_ARTIFACT_LIMITS, artifactKindLine, type ArtifactLimits } from '../../../shared/artifacts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'artifact-inspect-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function put(rel: string, contents: string | Buffer = 'x'): void {
  const abs = join(dir, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, contents)
}

describe('inspectArtifactPath', () => {
  it('drops every A10 path once, at the top of what matched, with its reason', () => {
    put('report/index.html')
    put('report/.git/HEAD')
    put('report/.git/objects/ab/cdef')
    put('report/.env')
    put('report/.env.local')
    put('report/server.pem')
    put('report/id.key')
    put('report/credentials/token.json')
    put('report/app-data/state.db')
    put('report/.claude/settings.json')
    put('report/node_modules/a/index.js')
    put('report/node_modules/b/index.js')
    put('report/.DS_Store')
    put('report/sub/node_modules/c.js')
    put('report/sub/data.csv', 'a,b\n')

    const result = inspectArtifactPath(join(dir, 'report'), FALLBACK_ARTIFACT_LIMITS)

    expect(result.files.map((file) => file.path)).toEqual(['index.html', 'sub/data.csv'])
    expect(result.excluded).toEqual(
      expect.arrayContaining([
        { path: '.git/', reason: 'git data' },
        { path: '.env', reason: 'secret file' },
        { path: '.env.local', reason: 'secret file' },
        { path: 'server.pem', reason: 'secret file' },
        { path: 'id.key', reason: 'secret file' },
        { path: 'credentials/', reason: 'credentials' },
        { path: 'app-data/', reason: 'app data' },
        { path: '.claude/', reason: 'agent settings' },
        { path: 'node_modules/', reason: 'dependencies' },
        { path: '.DS_Store', reason: 'system file' },
        { path: 'sub/node_modules/', reason: 'dependencies' }
      ])
    )
    // One row per match, never its contents.
    expect(result.excluded).toHaveLength(11)
    expect(result.size).toBe(1 + 4)
    expect(result.overLimits).toBeNull()
  })

  it('lists a symlink and never follows it, to a file or to a folder', () => {
    const outside = mkdtempSync(join(tmpdir(), 'artifact-outside-'))
    try {
      writeFileSync(join(outside, 'secret.txt'), 'top secret')
      mkdirSync(join(outside, 'tree'))
      writeFileSync(join(outside, 'tree', 'deep.txt'), 'deep')
      put('out/readme.md', '# hi')
      symlinkSync(join(outside, 'secret.txt'), join(dir, 'out', 'link.txt'))
      symlinkSync(join(outside, 'tree'), join(dir, 'out', 'linked-dir'))

      const result = inspectArtifactPath(join(dir, 'out'), FALLBACK_ARTIFACT_LIMITS)

      expect(result.files.map((file) => file.path)).toEqual(['readme.md'])
      expect(result.excluded).toEqual([
        { path: 'link.txt', reason: 'symlink' },
        { path: 'linked-dir', reason: 'symlink' }
      ])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('stops counting once past the file limit and says which limit', () => {
    for (let i = 0; i < 10; i++) put(`many/f${String(i).padStart(2, '0')}.txt`)
    const limits: ArtifactLimits = { maxRevisionFiles: 3, maxRevisionBytes: 1000, maxFileBytes: 1000 }

    const result = inspectArtifactPath(join(dir, 'many'), limits)

    expect(result.files).toHaveLength(4)
    expect(result.overLimits).toEqual({ files: true, size: false, perFile: [] })
  })

  it('stops counting once past the size limit, and names files over the per-file limit', () => {
    put('big/a.bin', Buffer.alloc(40))
    put('big/b.bin', Buffer.alloc(40))
    put('big/c.bin', Buffer.alloc(40))
    put('big/d.bin', Buffer.alloc(40))
    const limits: ArtifactLimits = { maxRevisionFiles: 100, maxRevisionBytes: 100, maxFileBytes: 30 }

    const result = inspectArtifactPath(join(dir, 'big'), limits)

    expect(result.files.map((file) => file.path)).toEqual(['a.bin', 'b.bin', 'c.bin'])
    expect(result.overLimits).toEqual({ files: false, size: true, perFile: ['a.bin', 'b.bin', 'c.bin'] })
  })

  it('a single file is itself; an excluded single file leaves nothing', () => {
    put('notes/report.md', '# Q3')
    put('notes/.env', 'KEY=1')
    const md = inspectArtifactPath(join(dir, 'notes', 'report.md'), FALLBACK_ARTIFACT_LIMITS)
    expect(md).toMatchObject({ isFolder: false, kind: 'files', entry: null, files: [{ path: 'report.md', size: 4 }] })
    const env = inspectArtifactPath(join(dir, 'notes', '.env'), FALLBACK_ARTIFACT_LIMITS)
    expect(env.files).toEqual([])
    expect(env.excluded).toEqual([{ path: '.env', reason: 'secret file' }])
  })

  it('a folder that is itself excluded is one row', () => {
    put('agent/credentials/a.json')
    const result = inspectArtifactPath(join(dir, 'agent', 'credentials'), FALLBACK_ARTIFACT_LIMITS)
    expect(result.files).toEqual([])
    expect(result.excluded).toEqual([{ path: 'credentials/', reason: 'credentials' }])
  })
})

describe('kind and entry', () => {
  it('a root index.html is a site that opens it', () => {
    put('site/index.html')
    put('site/app.js')
    const result = inspectArtifactPath(join(dir, 'site'), FALLBACK_ARTIFACT_LIMITS)
    expect(result).toMatchObject({ kind: 'site', entry: 'index.html', entryCandidates: [] })
    expect(artifactKindLine({ ...result, fileCount: result.files.length })).toBe('Mini-site · opens index.html')
  })

  it('a single .html file is a site', () => {
    put('page.html')
    const result = inspectArtifactPath(join(dir, 'page.html'), FALLBACK_ARTIFACT_LIMITS)
    expect(result).toMatchObject({ kind: 'site', entry: 'page.html' })
  })

  it('several .html and no index.html offer the candidates; a choice makes a site', () => {
    put('pages/b.html')
    put('pages/a.html')
    put('pages/data.csv')
    const open = inspectArtifactPath(join(dir, 'pages'), FALLBACK_ARTIFACT_LIMITS)
    expect(open).toMatchObject({ kind: 'files', entry: null, entryCandidates: ['a.html', 'b.html'] })
    expect(artifactKindLine({ ...open, fileCount: open.files.length })).toBe('3 files')
    const chosen = inspectArtifactPath(join(dir, 'pages'), FALLBACK_ARTIFACT_LIMITS, 'b.html')
    expect(chosen).toMatchObject({ kind: 'site', entry: 'b.html' })
    // A start page that is not among them is ignored.
    expect(decideKind(['a.html', 'x.csv'], 'nope.html')).toMatchObject({ kind: 'files', entry: null })
  })

  it('names a single file by its type', () => {
    expect(artifactKindLine({ isFolder: false, kind: 'files', entry: null, fileCount: 1, name: 'report.md' })).toBe('Markdown document')
    expect(artifactKindLine({ isFolder: false, kind: 'files', entry: null, fileCount: 1, name: 'x.parquet' })).toBe('PARQUET file')
  })

  it('applies the directory rules only to folders, and .git to both', () => {
    expect(exclusionFor('credentials', false)).toBeNull()
    expect(exclusionFor('credentials', true)).toBe('credentials')
    expect(exclusionFor('.git', false)).toBe('git data')
    expect(exclusionFor('.env.example', false)).toBe('secret file')
    expect(exclusionFor('KEY.PEM', false)).toBe('secret file')
  })

  it('leaves out dot-named files and folders as hidden, keeping the specific reasons first', () => {
    expect(exclusionFor('.eslintrc', false)).toBe('hidden file')
    expect(exclusionFor('.cache', true)).toBe('hidden file')
    expect(exclusionFor('.claude', true)).toBe('agent settings')
    expect(exclusionFor('.DS_Store', false)).toBe('system file')
    put('site/index.html')
    put('site/.hidden.json')
    put('site/.vscode/settings.json')
    const result = inspectArtifactPath(join(dir, 'site'), FALLBACK_ARTIFACT_LIMITS, null)
    expect(result.files.map((file) => file.path)).toEqual(['index.html'])
    expect(result.excluded).toEqual(expect.arrayContaining([
      { path: '.hidden.json', reason: 'hidden file' },
      { path: '.vscode/', reason: 'hidden file' }
    ]))
  })
})
