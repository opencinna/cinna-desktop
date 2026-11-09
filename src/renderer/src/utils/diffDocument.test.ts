import { describe, expect, it } from 'vitest'
import { compareWords, decodeEntities, diffFileLabel, diffOutline, parseDiff, type DiffRow } from './diffDocument'

const rowText = (rows: DiffRow[]): string[] => rows.map((row) => row.text)

const GIT = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 83db48f..bf2a6c1 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,3 +10,4 @@ function main() {',
  '   keep()',
  '-  old()',
  '+  next()',
  '+  more()',
  '\\ No newline at end of file',
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1 @@',
  '+hello',
  'diff --git a/gone.txt b/gone.txt',
  'deleted file mode 100644',
  '--- a/gone.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  'diff --git a/old/name.ts b/new/name.ts',
  'similarity index 100%',
  'rename from old/name.ts',
  'rename to new/name.ts',
  'diff --git a/logo.png b/logo.png',
  'Binary files a/logo.png and b/logo.png differ',
  'diff --git a/run.sh b/run.sh',
  'old mode 100644',
  'new mode 100755',
  ''
].join('\n')

describe('parseDiff: a unified diff', () => {
  it('reads every kind of file git writes, with its status and counts', () => {
    const diff = parseDiff(GIT)!
    expect(diff.headerless).toBe(false)
    expect(diff.flowing).toBe(false)
    expect(diff.files.map((file) => [diffFileLabel(file), file.status])).toEqual([
      ['src/a.ts', 'modified'],
      ['new.txt', 'added'],
      ['gone.txt', 'deleted'],
      ['old/name.ts → new/name.ts', 'renamed'],
      ['logo.png', 'binary'],
      ['run.sh', 'mode']
    ])
    expect(diff.files[0]).toMatchObject({ additions: 2, deletions: 1, sourceLine: 1 })
    expect([diff.additions, diff.deletions]).toEqual([3, 2])
  })

  it('numbers rows from the hunk header, removals by the old file', () => {
    const [hunk] = parseDiff(GIT)!.files[0].hunks
    expect(hunk).toMatchObject({ line: 10, section: 'function main() {' })
    expect(hunk.rows).toEqual([
      expect.objectContaining({ kind: 'context', text: '  keep()', line: 10 }),
      expect.objectContaining({ kind: 'del', text: '  old()', line: 11 }),
      expect.objectContaining({ kind: 'add', text: '  next()', line: 11 }),
      expect.objectContaining({ kind: 'add', text: '  more()', line: 12 }),
      { kind: 'note', text: 'No newline at end of file' }
    ])
  })

  it('takes a removed line that looks like a file header for a removal, by the hunk count', () => {
    const diff = parseDiff(['--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@', '--- not a header', '+++ not a header', ' same'].join('\n'))!
    expect(diff.files).toHaveLength(1)
    expect(diff.files[0].hunks[0].rows.map((row) => row.kind)).toEqual(['del', 'add', 'context'])
  })

  it('keeps a patch mail: the message above the first file, the signature after the last', () => {
    const diff = parseDiff(
      ['From abc Mon Sep 17', 'Subject: fix it', '', '--- a/x', '+++ b/x', '@@ -1 +1 @@', '-a', '+b', '-- ', '2.39.5'].join('\n')
    )!
    expect(diff.preamble).toEqual(['From abc Mon Sep 17', 'Subject: fix it', ''])
    expect(diff.files[0].hunks[0].rows).toHaveLength(2)
    expect(diff.files[0].trailing).toEqual(['-- ', '2.39.5'])
  })

  it('reads a difflib diff, with no a/ b/ prefixes and a name on each side', () => {
    const diff = parseDiff(['--- confluence', '+++ draft', '@@ -0,0 +1,2 @@', '+one', '+two'].join('\n'))!
    expect(diffFileLabel(diff.files[0])).toBe('confluence → draft')
    expect(diff.files[0].status).toBe('modified')
  })

  it('reads an @@ line with no numbers, as far as the next one', () => {
    const diff = parseDiff(['@@ def main', '-a', '+b', '@@', ' c', '+d'].join('\n'))!
    expect(diff.files[0].hunks).toHaveLength(2)
    expect(diff.files[0].hunks[0]).toMatchObject({ line: null, section: 'def main' })
    expect(diff.files[0].hunks[1].rows).toHaveLength(2)
  })

  it('strips a date from a plain diff -u header, and accepts CRLF', () => {
    const diff = parseDiff('--- a.txt\t2024-01-01 10:00:00\r\n+++ a.txt\t2024-01-02 10:00:00\r\n@@ -1 +1 @@\r\n-x\r\n+y\r\n')!
    expect(diffFileLabel(diff.files[0])).toBe('a.txt')
    expect(diff.files[0].hunks[0].rows.map((row) => row.kind === 'note' || row.text)).toEqual(['x', 'y'])
  })

  it('does not lose a hunk whose counts are short: the extra line stays on screen', () => {
    const diff = parseDiff(['--- a', '+++ b', '@@ -1 +1 @@', '-x', '+y', '+extra'].join('\n'))!
    expect(diff.files[0].trailing).toEqual(['+extra'])
  })
})

/** The shape of the real file: the text nodes of a page, one per line, no headers. */
const FRAGMENTS = [
  '-R1 Showroom (Google Sheets) &mdash; ⚠️',
  '+R1 Showroom (Google Sheets) &mdash; ❌',
  '+R3.5',
  '+Traffic in 7 days: ',
  '+/sellers.json',
  '+ 7,404 hits, ',
  '+/ads.txt',
  '+ 4,207.',
  '+⚠️ www',
  '-.',
  '+. In active use.'
].join('\n')

describe('parseDiff: a bare change list', () => {
  it('joins text fragments back into sentences and decodes their entities', () => {
    const diff = parseDiff(FRAGMENTS)!
    expect(diff.headerless).toBe(true)
    expect(diff.flowing).toBe(true)
    expect(rowText(diff.files[0].hunks[0].rows)).toEqual([
      'R1 Showroom (Google Sheets) — ⚠️',
      'R1 Showroom (Google Sheets) — ❌',
      'R3.5',
      'Traffic in 7 days: /sellers.json 7,404 hits, /ads.txt 4,207.',
      '⚠️ www',
      '.',
      '. In active use.'
    ])
  })

  it('counts a removal and what replaced it as one change', () => {
    expect(parseDiff(FRAGMENTS)!.changes).toBe(2)
  })

  it('marks only what differs in a replaced line', () => {
    const [before, after] = parseDiff(FRAGMENTS)!.files[0].hunks[0].rows
    if (before.kind === 'note' || after.kind === 'note') throw new Error('expected rows')
    expect(before.segments?.filter((s) => s.changed).map((s) => s.text).join('')).toContain('⚠')
    expect(after.segments?.filter((s) => s.changed).map((s) => s.text).join('')).toBe('❌')
  })

  it('leaves indented lines alone: that is code, and its leading space is the code', () => {
    const diff = parseDiff(['-  a = 1 ', '+  a = 2 ', '+  b = 3 ', '+&amp;'].join('\n'))!
    expect(diff.flowing).toBe(false)
    expect(rowText(diff.files[0].hunks[0].rows)).toEqual(['  a = 1 ', '  a = 2 ', '  b = 3 ', '&amp;'])
  })

  it('leaves whole lines alone when nothing looks like a fragment', () => {
    const diff = parseDiff(['-first line', '+first change', '+second change'].join('\n'))!
    expect(diff.flowing).toBe(false)
    expect(diff.files[0].hunks[0].rows).toHaveLength(3)
  })

  it('joins the fragments of a unified diff of a page too, and drops the meaningless numbers', () => {
    const diff = parseDiff(['--- confluence', '+++ draft', '@@ -0,0 +1,3 @@', '+Hits: ', '+/ads.txt', '+ 4,207.'].join('\n'))!
    expect(diff.flowing).toBe(true)
    expect(rowText(diff.files[0].hunks[0].rows)).toEqual(['Hits: /ads.txt 4,207.'])
  })
})

describe('parseDiff: not a diff', () => {
  it('is null for ordinary text, and for a file with no change in it', () => {
    expect(parseDiff('just some\nnotes here')).toBeNull()
    expect(parseDiff(' only context\n another')).toBeNull()
  })

  it('reads empty text as a diff of nothing', () => {
    expect(parseDiff('')).toMatchObject({ files: [], additions: 0, deletions: 0 })
    expect(parseDiff('\n\n')).toMatchObject({ files: [] })
  })
})

describe('compareWords', () => {
  const changed = (segments: { text: string; changed: boolean }[]): string =>
    segments.filter((s) => s.changed).map((s) => s.text).join('|')

  it('marks the words that differ on each side', () => {
    const marks = compareWords('return 308 for all', 'return 404 for all')!
    expect(changed(marks.before)).toBe('308')
    expect(changed(marks.after)).toBe('404')
  })

  it('marks only the tail of a line that grew', () => {
    const marks = compareWords('49 return 404.', '49 return 404. Access log follows')!
    expect(changed(marks.before)).toBe('')
    expect(changed(marks.after)).toBe(' Access log follows')
  })

  it('marks a replaced phrase as one run, not word by word', () => {
    const marks = compareWords('keep the server running this and that here now', 'keep the server running one two three here now')!
    expect(marks.after.filter((s) => s.changed)).toHaveLength(1)
  })

  it('marks a file name as one run, across its dots and hyphens', () => {
    const marks = compareWords('see the list in sample-20261106.txt today', 'see the list in gaps-20261109.csv today')!
    expect(marks.after.filter((s) => s.changed).map((s) => s.text)).toEqual(['gaps-20261109.csv'])
  })

  it('gives up on lines with little in common: a wall of marks helps nobody', () => {
    expect(compareWords('completely unrelated sentence', 'another thing entirely different')).toBeNull()
    expect(compareWords('.', '...')).toBeNull()
  })

  it('gives up rather than compare two enormous lines', () => {
    const line = (word: string): string => Array.from({ length: 2000 }, (_, i) => `${word}${i}`).join(' ')
    expect(compareWords(line('a'), line('b'))).toBeNull()
  })
})

describe('decodeEntities', () => {
  it('decodes named and numeric entities, and leaves what it does not know', () => {
    expect(decodeEntities('a &rarr; b &amp; c &#8212; &#x2014; &unknown; &#0; &#xD800; &#x110000;')).toBe(
      'a → b & c — — &unknown; &#0; &#xD800; &#x110000;'
    )
  })
})

describe('diffOutline', () => {
  it('lists the files by their source line, once there is more than one', () => {
    const outline = diffOutline(parseDiff(GIT))
    expect(outline.show).toBe(true)
    expect(outline.entries[1]).toEqual({ depth: 1, text: 'new.txt', line: 11 })
    expect(outline.entries[0].text).toBe('a.ts · src')
    expect(outline.entries[3].text).toBe('name.ts · new')
    expect(diffOutline(parseDiff('--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y')).show).toBe(false)
    expect(diffOutline(null).show).toBe(false)
  })
})

describe('parseDiff: what the review found', () => {
  const rows = (text: string): DiffRow[] => parseDiff(text)!.files[0].hunks.flatMap((hunk) => hunk.rows)

  it('reads pathological lines in linear time', () => {
    const started = Date.now()
    parseDiff(`@@ ${' '.repeat(1_000_000)}x`)
    parseDiff(`diff --git a/x${' b/y'.repeat(200_000)}\r\nindex 1..2`)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('does not take a markdown hard break for a fragment', () => {
    const diff = parseDiff(['--- a', '+++ b', '@@ -1,3 +1,3 @@', ' Roses are red,  ', ' Sugar is sweet,  ', '-And so are you.', '+And so am I.'].join('\n'))!
    expect(diff.flowing).toBe(false)
    expect(diff.files[0].hunks[0].rows).toHaveLength(4)
  })

  it('does not call a change a fragment when there is nothing to join: decoding would hide it', () => {
    const diff = parseDiff(['-b=&amp;1 ', '+b=&1 '].join('\n'))!
    expect(diff.flowing).toBe(false)
    expect(rowText(diff.files[0].hunks[0].rows)).toEqual(['b=&amp;1 ', 'b=&1 '])
  })

  it('carries a bare hunk over a blank line, and leaves a mail signature out of it', () => {
    const diff = parseDiff(['@@ foo', '-a one', '+a two', '', '-b one', '+b two', '-- ', '2.39.5'].join('\n'))!
    expect(diff.files[0].deletions).toBe(2)
    expect(diff.files[0].additions).toBe(2)
    expect(diff.files[0].trailing).toEqual(['-- ', '2.39.5'])
  })

  it('does not let a count too high swallow the next file', () => {
    const diff = parseDiff(['--- a/x', '+++ b/x', '@@ -1,50 +1,50 @@', '-a', '+b', '--- a/y', '+++ b/y', '@@ -1 +1 @@', '-c', '+d'].join('\n'))!
    expect(diff.files.map(diffFileLabel)).toEqual(['x', 'y'])
  })

  it('gives a second commit its own message, not the first file\'s card', () => {
    const diff = parseDiff(
      ['--- a/x', '+++ b/x', '@@ -1 +1 @@', '-a', '+b', 'From def', 'Subject: two', '', 'body', '--- a/y', '+++ b/y', '@@ -1 +1 @@', '-c', '+d'].join('\n')
    )!
    expect(diff.files[0].trailing).toEqual([])
    expect(diff.files[1].preamble).toEqual(['From def', 'Subject: two', '', 'body'])
  })

  it('reads a commit message quoting a diff as a message, not as files', () => {
    const diff = parseDiff(
      ['Fix: diff --git a/foo b/foo', 'diff --git a/foo b/foo', 'is what it printed', '--- old idea', '+++ new idea', '@@ -1,2 +1,2 @@', 'prose', '', '--- a/x', '+++ b/x', '@@ -1 +1 @@', '-a', '+b'].join('\n')
    )!
    expect(diff.files.map(diffFileLabel)).toEqual(['x'])
    expect(diff.preamble).toContain('--- old idea')
  })

  it('is not a diff when an @@ line is all that looks like one', () => {
    expect(parseDiff('send to me@@ home\n@@ note\nprose')).toBeNull()
  })

  it('compares a last line across its "no newline" note, as one change', () => {
    const diff = parseDiff(['--- a', '+++ b', '@@ -1 +1 @@', '-return one value', '\\ No newline at end of file', '+return two value'].join('\n'))!
    expect(diff.changes).toBe(1)
    const removed = diff.files[0].hunks[0].rows[0]
    expect(removed.kind !== 'note' && removed.segments).toBeTruthy()
  })

  it('leaves an entity named after an Object method as written', () => {
    expect(decodeEntities('&constructor; &toString;')).toBe('&constructor; &toString;')
  })

  it('keeps a signature after a binary file, calls a copy a copy, and names an unprefixed binary', () => {
    const diff = parseDiff(['diff --git x.png x.png', 'Binary files x.png and x.png differ', '-- ', '2.39.5'].join('\n'))!
    expect(diffFileLabel(diff.files[0])).toBe('x.png')
    expect(diff.files[0].trailing).toEqual(['-- ', '2.39.5'])
    const copied = parseDiff(['diff --git a/x b/y', 'similarity index 100%', 'copy from x', 'copy to y'].join('\n'))!
    expect(copied.files[0].status).toBe('copied')
    const spaced = parseDiff(['diff --git a/x b/y b/x b/y', 'old mode 100644', 'new mode 100755'].join('\n'))!
    expect(diffFileLabel(spaced.files[0])).toBe('x b/y')
  })

  it('knows a file by its header when the first row of the hunk is a stripped blank line', () => {
    const diff = parseDiff(['--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@', '', '-a', '+b', '--- a/y', '+++ b/y', '@@ -1 +1 @@', '-c', '+d'].join('\n'))!
    expect(diff.files.map(diffFileLabel)).toEqual(['x', 'y'])
    expect(diff.preamble).toEqual([])
    expect(diffFileLabel(parseDiff('--- a/x\n+++ b/x')!.files[0])).toBe('x')
  })

  it('reads a commit message quoting a diff in a later commit as a message too', () => {
    const diff = parseDiff(
      ['--- a/x', '+++ b/x', '@@ -1 +1 @@', '-a', '+b', 'Subject: two', 'diff --git a/foo b/foo', 'is what it printed', '--- a/y', '+++ b/y', '@@ -1 +1 @@', '-c', '+d'].join('\n')
    )!
    expect(diff.files.map(diffFileLabel)).toEqual(['x', 'y'])
    expect(diff.files[1].preamble).toContain('diff --git a/foo b/foo')
  })

  it('does not split a hunk at a removal and an addition that exactly fill it', () => {
    const diff = parseDiff(['--- a/q', '+++ b/q', '@@ -1,2 +1,2 @@', ' ctx', '--- old', '+++ new', '@@ -9 +9 @@', '-c', '+d'].join('\n'))!
    expect(diff.files.map(diffFileLabel)).toEqual(['q'])
    expect(diff.files[0].hunks[0].rows.map((row) => row.kind)).toEqual(['context', 'del', 'add'])
  })

  it('needs a fragment that starts with its space: whole lines ending in one keep their breaks and entities', () => {
    const diff = parseDiff(['-a=1 ', '-b=&amp;1 ', '+a=2 ', '+b=&1 '].join('\n'))!
    expect(diff.flowing).toBe(false)
    expect(rowText(diff.files[0].hunks[0].rows)).toEqual(['a=1 ', 'b=&amp;1 ', 'a=2 ', 'b=&1 '])
  })

  it('leaves a commit\'s signature with that commit, not on the next message', () => {
    const diff = parseDiff(
      ['--- a/x', '+++ b/x', '@@ -1 +1 @@', '-a', '+b', '-- ', '2.39.0', '', 'From def', 'Subject: two', '--- a/y', '+++ b/y', '@@ -1 +1 @@', '-c', '+d'].join('\n')
    )!
    expect(diff.files[0].trailing).toEqual(['-- ', '2.39.0'])
    expect(diff.files[1].preamble).toEqual(['From def', 'Subject: two'])
  })

  it('still reads rows', () => {
    expect(rows('-a\n+b')).toHaveLength(2)
  })
})
