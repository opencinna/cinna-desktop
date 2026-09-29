import { describe, expect, it } from 'vitest'
import {
  MAX_FILE_REF_CANDIDATES,
  agentFileContentKind,
  agentFilePreviewKindFor,
  extractFileRefCandidates,
  extractInlineCodeSpans,
  fileRefCandidatePath,
  isCredentialFileRef,
  isCredentialFilePath
} from './agentFiles'

describe('fileRefCandidatePath — the shape filter', () => {
  it.each([
    ['data/reforecast/2026-H2/pulled/omp.csv', 'data/reforecast/2026-H2/pulled/omp.csv'],
    ['cycle_summary.md', 'cycle_summary.md'],
    ['pulled/', 'pulled/'],
    ['~/notes/today.md', '~/notes/today.md'],
    ['/Users/me/report.pdf', '/Users/me/report.pdf'],
    ['src/app.py:12', 'src/app.py'],
    ['src/app.py:12:4', 'src/app.py'],
    ['.env', '.env']
  ])('accepts %s', (text, path) => {
    expect(fileRefCandidatePath(text)).toBe(path)
  })

  it.each([
    ['a', 'too short'],
    ['x'.repeat(509) + '.csv', 'too long'],
    ['uv run main.py', 'whitespace'],
    ['https://example.com/a.md', 'URL'],
    ['-rf/x', 'leading dash'],
    ['data/*.csv', 'glob'],
    ['src/{a,b}.ts', 'brace'],
    ['a|b.txt', 'pipe'],
    ['$HOME/x', 'variable'],
    ['KEY=val.txt', 'assignment'],
    ["it's.md", 'quote'],
    ['README', 'no slash and no extension'],
    ['reforecast_common', 'identifier'],
    ['file.toolongextension', 'extension over 10 characters'],
    ['12:30', 'a time']
  ])('refuses %s (%s)', (text) => {
    expect(fileRefCandidatePath(text)).toBeNull()
  })
})

describe('extractInlineCodeSpans', () => {
  it('returns inline spans in order', () => {
    expect(extractInlineCodeSpans('Wrote `a.csv` and then `b/c.md`.')).toEqual(['a.csv', 'b/c.md'])
  })

  it('skips fenced blocks, with backticks and tildes, including unclosed ones', () => {
    const md = [
      'Before `one.py`',
      '```python',
      'x = `not.py`',
      '```',
      'Middle `two.py`',
      '~~~',
      '`nope.py`',
      '~~~',
      'After `three.py`',
      '```',
      '`never.py`'
    ].join('\n')
    expect(extractInlineCodeSpans(md)).toEqual(['one.py', 'two.py', 'three.py'])
  })

  it('treats a "```x```" line as inline code, not a fence', () => {
    expect(extractInlineCodeSpans('```a.py``` then `b.py`')).toEqual(['a.py', 'b.py'])
  })

  it('skips indented code blocks but not indented list continuations', () => {
    const md = ['Intro `one.md`', '', '    `indented.md`', '    more', '', 'Back `two.md`'].join('\n')
    expect(extractInlineCodeSpans(md)).toEqual(['one.md', 'two.md'])
    const list = ['- item `a.md`', '', '    continued `b.md`'].join('\n')
    expect(extractInlineCodeSpans(list)).toEqual(['a.md', 'b.md'])
  })

  it('follows the backtick-run rule and escapes', () => {
    // The escaped backtick opens nothing, so the next pair encloses " and ",
    // which CommonMark trims to "and"; the last backtick is unmatched.
    expect(extractInlineCodeSpans('`` a`b.md `` and \\`x.md` and `y.md`')).toEqual(['a`b.md', 'and'])
    expect(extractInlineCodeSpans('unmatched `` run then `c.md`')).toEqual(['c.md'])
  })

  it('does not pair backticks across a table row or heading', () => {
    const md = ['| a | `broken |', '| b | `ok.md` |', '# Title `h.md`'].join('\n')
    expect(extractInlineCodeSpans(md)).toEqual(['ok.md', 'h.md'])
  })
})

describe('extractFileRefCandidates', () => {
  it('filters by shape and de-duplicates across messages, first occurrence wins', () => {
    const out = extractFileRefCandidates(['`a.csv` `run it` `b/c`', '`a.csv` `d.md:3`'])
    expect(out).toEqual(['a.csv', 'b/c', 'd.md:3'])
  })

  it('caps the candidates', () => {
    const md = Array.from({ length: MAX_FILE_REF_CANDIDATES + 20 }, (_, i) => `\`f${i}.md\``).join(' ')
    const out = extractFileRefCandidates([md])
    expect(out).toHaveLength(MAX_FILE_REF_CANDIDATES)
    expect(out[0]).toBe('f0.md')
  })
})

describe('agentFilePreviewKindFor', () => {
  it('keeps every attachment kind, including highlighted python, and adds other code and config as text', () => {
    expect(agentFilePreviewKindFor('a.csv')).toBe('csv')
    expect(agentFilePreviewKindFor('README.md')).toBe('markdown')
    expect(agentFilePreviewKindFor('x/y/reforecast_common.py')).toBe('python')
    expect(agentFilePreviewKindFor('pyproject.toml')).toBe('text')
  })

  it('has no preview for binary and unknown types', () => {
    expect(agentFilePreviewKindFor('dump.gz')).toBeNull()
    expect(agentFilePreviewKindFor('sheet.xlsx')).toBeNull()
    expect(agentFilePreviewKindFor('Makefile')).toBeNull()
  })
})

describe('isCredentialFilePath', () => {
  const agentDir = '/agents/a'
  it.each([
    '/agents/a/.env',
    '/elsewhere/.env.local',
    '/agents/a/credentials/service.json',
    '/agents/a/credentials/nested/token.txt',
    '/agents/a/Credentials/token.txt',
    '/x/server.pem',
    '/x/tls.key',
    '/home/me/.ssh/id_rsa',
    '/home/me/.ssh/id_ed25519',
    '/home/me/.ssh/id_ecdsa',
    '/home/me/.ssh/id_dsa',
    '/home/me/.ssh/id_rsa_work',
    '/home/me/.netrc',
    '/c/Users/me/_netrc',
    '/home/me/.npmrc',
    '/home/me/.pypirc',
    '/home/me/.pgpass',
    '/home/me/.git-credentials',
    '/home/me/.dockercfg',
    '/home/me/.docker/config.json',
    '/home/me/.aws/credentials',
    '/home/me/.kube/config',
    '/agents/a/.AWS/Credentials'
  ])('refuses %s', (path) => {
    expect(isCredentialFilePath(path, agentDir)).toBe(true)
  })

  it.each([
    '/agents/a/.env.example',
    '/agents/a/.env.sample',
    '/agents/a/.env.template',
    '/agents/a/credentials/README.md',
    '/agents/a/credentials/.env.example',
    '/agents/a/credentials/service.json.example',
    '/agents/a/data/credentials.csv',
    '/other/credentials/service.json',
    '/home/me/.ssh/id_rsa.pub',
    '/home/me/.ssh/id_ed25519.pub',
    '/x/id_mapping.csv',
    '/x/docker/config.json',
    '/x/my.aws/credentials',
    '/x/.aws/credentials.md',
    '/x/.kube/config.yaml',
    '/x/netrc.txt'
  ])('allows %s', (path) => {
    expect(isCredentialFilePath(path, agentDir)).toBe(false)
  })
})

describe('agentFileContentKind', () => {
  it.each([
    'notes.md', 'README.markdown', 'data.csv', 'table.tsv', 'plain.txt', 'config.json', 'spec.yaml', 'spec.yml',
    'main.py', 'types.pyi', 'index.ts', 'App.tsx', 'run.sh', 'query.sql', 'server.log', 'server.log.1',
    'app.log.12', 'job.out', 'job.err', '/abs/path/Makefile', 'Dockerfile', '.gitignore', 'LICENSE',
    '.env.example', 'dir/.editorconfig', '.nvmrc'
  ])('%s is text', (name) => {
    expect(agentFileContentKind(name)).toBe('text')
  })

  it.each(['report.pdf', 'deck.pptx', 'photo.JPG', 'sheet.xlsx', 'talk.key', '/x/y/image.heic'])(
    '%s is binary',
    (name) => {
      expect(agentFileContentKind(name)).toBe('binary')
    }
  )

  it.each(['dump.gz', 'archive.zip', 'model.bin', 'NOTES', 'data.parquet', 'server.logs'])('%s is unknown', (name) => {
    expect(agentFileContentKind(name)).toBe('unknown')
  })
})

describe('isCredentialFileRef', () => {
  it('judges an inside ref by its folder-relative path, an outside one by its absolute path', () => {
    expect(isCredentialFileRef({ path: '/a/credentials/x.json', displayPath: 'credentials/x.json', inside: true })).toBe(true)
    expect(isCredentialFileRef({ path: '/a/credentials/README.md', displayPath: 'credentials/README.md', inside: true })).toBe(false)
    expect(isCredentialFileRef({ path: '/o/.env.local', displayPath: '/o/.env.local', inside: false })).toBe(true)
    expect(isCredentialFileRef({ path: '/o/credentials/x.json', displayPath: '/o/credentials/x.json', inside: false })).toBe(false)
    expect(isCredentialFileRef({ path: '/a/main.py', displayPath: 'main.py', inside: true })).toBe(false)
    expect(isCredentialFileRef({ path: '/a/.aws/credentials', displayPath: '.aws/credentials', inside: true })).toBe(true)
  })
})
