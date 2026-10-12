import { describe, expect, it } from 'vitest'
import {
  MAX_FILE_REF_CANDIDATES,
  agentFileContentKind,
  agentFilePreviewKindFor,
  extractFileRefEntries,
  extractInlineCodeSpans,
  extractLinkDestinations,
  fileLinkCandidatePath,
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

describe('extractLinkDestinations — the href react-markdown renders', () => {
  it('reads the <…> form, spaces and all, percent-encoded as the href is', () => {
    expect(
      extractLinkDestinations('[Index CSV](</Users/me/Agents/invoice reader/app-data/invoice_index.csv>)')
    ).toEqual(['/Users/me/Agents/invoice%20reader/app-data/invoice_index.csv'])
    expect(extractLinkDestinations('[x](<café.md>)')).toEqual(['caf%C3%A9.md'])
  })

  it('reads the bare form, in order, with a title after it', () => {
    expect(extractLinkDestinations('See [a](/abs/path.md) and [b](docs/b.md "Title") and [c](c.md \'t\')')).toEqual([
      '/abs/path.md',
      'docs/b.md',
      'c.md'
    ])
  })

  it('processes backslash escapes and character references, leaves %XX alone', () => {
    expect(extractLinkDestinations('[a](docs/a\\(1\\).md)')).toEqual(['docs/a(1).md'])
    expect(extractLinkDestinations('[a](a&amp;b.md) [b](&lt;x&gt;&quot;.md) [c](&#65;&#x42;.md)')).toEqual([
      'a&b.md',
      '%3Cx%3E%22.md',
      'AB.md'
    ])
    expect(extractLinkDestinations('[a](%20x.md)')).toEqual(['%20x.md'])
  })

  it('keeps balanced parentheses in a bare destination', () => {
    expect(extractLinkDestinations('[a](a(b)c.md) and [b](x(1).md)')).toEqual(['a(b)c.md', 'x(1).md'])
    expect(extractLinkDestinations('[a](a(b.md) [b](ok.md)')).toEqual(['ok.md'])
  })

  it('keeps a fragment and a line suffix in the href', () => {
    expect(extractLinkDestinations('[a](src/app.py#L12) [b](src/app.py:12)')).toEqual(['src/app.py#L12', 'src/app.py:12'])
  })

  it('ignores links inside code spans and code blocks', () => {
    const md = [
      'Real [a](a.md) and `[b](b.md)`',
      '```',
      '[c](c.md)',
      '```',
      '',
      '    [d](d.md)',
      '',
      '[e](e.md)'
    ].join('\n')
    expect(extractLinkDestinations(md)).toEqual(['a.md', 'e.md'])
  })

  it('collects a link whose text is a code span, and none without a link text', () => {
    expect(extractLinkDestinations('[`a.md`](docs/a.md)')).toEqual(['docs/a.md'])
    expect(extractLinkDestinations('just ](x.md) and \\[y](y.md)')).toEqual([])
  })

  it('refuses what is not an inline link', () => {
    expect(extractLinkDestinations('[a](<bad\nnewline>) [b]() [c](x y) [d](<x>y)')).toEqual([])
  })
})

describe('fileLinkCandidatePath — the link filter', () => {
  it.each([
    ['/abs/path.md', '/abs/path.md'],
    ['README', 'README'],
    ['~/notes/today.md', '~/notes/today.md'],
    ['src/app.py#L12', 'src/app.py'],
    ['src/app.py#L12-L20', 'src/app.py'],
    ['a.ts#L12', 'a.ts'],
    ['a.ts#L12-L20', 'a.ts'],
    ['a.ts#L3C4-L5C1', 'a.ts'],
    ['README.md#install', 'README.md'],
    ['notes#1.md', 'notes#1.md'],
    ['notes#section', 'notes#section'],
    ['dir/a#b/c.md', 'dir/a#b/c.md'],
    ['my%20notes.md#L2', 'my notes.md'],
    ['a%23b.md', 'a#b.md'],
    ['src/app.py:12', 'src/app.py'],
    ['src/app.py:12:4', 'src/app.py'],
    ['/Users/me/x%20y/caf%C3%A9.csv', '/Users/me/x y/café.csv'],
    ['a%zz%20b', 'a%zz%20b'],
    ['a(1).md', 'a(1).md']
  ])('accepts %s', (text, path) => {
    expect(fileLinkCandidatePath(text)).toBe(path)
  })

  it.each([
    ['', 'empty'],
    ['x'.repeat(1025), 'too long'],
    ['https://example.com/a.md', 'http'],
    ['mailto:me@example.com', 'mailto'],
    ['file:///Users/me/a.md', 'file URL'],
    ['javascript:alert(1)', 'script'],
    ['//host/a.md', 'protocol-relative'],
    ['#section', 'in-page anchor'],
    ['?q=1', 'query'],
    ['a\nb.md', 'newline'],
    ['a\u0000b.md', 'NUL'],
    ['a%00b.md', 'encoded NUL'],
    ['#L12', 'fragment only']
  ])('refuses %j (%s)', (text) => {
    expect(fileLinkCandidatePath(text)).toBeNull()
  })

  it('refuses a non-string', () => {
    expect(fileLinkCandidatePath(42)).toBeNull()
  })
})

describe('extractFileRefEntries', () => {
  it('interleaves spans and links in document order, a span in link text before its link', () => {
    const out = extractFileRefEntries(['Read [the plan](plan.md) then `a.csv`, and [`b.md`](docs/b.md).', '`c/d.py` [w](https://x.dev)'])
    expect(out).toEqual([
      { text: 'plan.md', source: 'link' },
      { text: 'a.csv', source: 'span' },
      { text: 'b.md', source: 'span' },
      { text: 'docs/b.md', source: 'link' },
      { text: 'c/d.py', source: 'span' }
    ])
  })

  it('filters each source by its own rule and de-duplicates per source and text', () => {
    const out = extractFileRefEntries(['`a.md` [a](a.md) `run it` [m](mailto:a@b) [s](</x y.md>)', '`a.md` [again](a.md) [README](README)'])
    expect(out).toEqual([
      { text: 'a.md', source: 'span' },
      { text: 'a.md', source: 'link' },
      { text: '/x%20y.md', source: 'link' },
      { text: 'README', source: 'link' }
    ])
  })

  it('caps spans and links as one list', () => {
    const md = Array.from({ length: MAX_FILE_REF_CANDIDATES + 20 }, (_, i) => (i % 2 ? `[f](f${i}.md)` : `\`f${i}.md\``)).join(' ')
    const out = extractFileRefEntries([md])
    expect(out).toHaveLength(MAX_FILE_REF_CANDIDATES)
    expect(out.slice(0, 2)).toEqual([
      { text: 'f0.md', source: 'span' },
      { text: 'f1.md', source: 'link' }
    ])
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
