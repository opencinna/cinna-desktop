import { beforeEach, describe, it, expect, vi } from 'vitest'

// Counts parser runs: an ordinary reply must never pay for a parse.
const parses = vi.hoisted(() => ({ count: 0 }))
vi.mock('unified', async (importOriginal) => {
  const actual = await importOriginal<typeof import('unified')>()
  return {
    ...actual,
    unified: () => {
      const processor = actual.unified()
      const parse = processor.parse.bind(processor)
      processor.parse = ((file) => {
        parses.count++
        return parse(file)
      }) as typeof processor.parse
      return processor
    }
  }
})

import { repairNestedFences } from './nestedFences'

const ZW = '\u200B'
const BOM = '\uFEFF'

beforeEach(() => {
  parses.count = 0
})

// Trimmed from a real folder-agent reply (JbZ): an unescaped bash block inside a
// markdown fence, followed by prose.
const UNESCAPED = [
  "Here's the exact block to drop into the Workflow section:",
  '',
  '```markdown',
  "### Explain a deal's AVB rebate calculation",
  '',
  '```bash',
  'uv run scripts/explain_deal_avb.py --id=DEAL_ID_OR_URL',
  '```',
  '',
  "The script is read-only. It walks a single deal's AVB rebate through:",
  '1. AVB contact resolution',
  '2. The local tier and any matching special rate',
  '```',
  '',
  'Also worth noting for whoever does the edit: the References section is dangling.'
].join('\n')

// Trimmed from a real folder-agent reply (h12o): inner fence lines "escaped" with U+200B.
const ZERO_WIDTH_ESCAPED = [
  'add something like this to the Workflow section yourself:',
  '',
  '```',
  "### Explain a deal's AVB rebate calculation",
  '',
  `${ZW}\`\`\`bash`,
  'uv run scripts/explain_deal_avb.py --id=DEAL_ID_OR_URL',
  `${ZW}\`\`\``,
  '```'
].join('\n')

const TWO_INNER = [
  '```markdown',
  '## Build',
  '```bash',
  'npm i',
  '```',
  '## Run',
  '```python',
  'print(1)',
  '```',
  '```',
  '',
  'After.'
].join('\n')

const TWO_INNER_REPAIRED = [
  '````markdown',
  '## Build',
  '```bash',
  'npm i',
  '```',
  '## Run',
  '```python',
  'print(1)',
  '```',
  '````',
  '',
  'After.'
].join('\n')

// A lone opener-looking line inside an ordinary block, with bare blocks after it:
// closing over them would swallow the prose between.
const PYTHON_STRING = '```python\ns = """\n```json\n"""\n```\n\nOutput:\n\n```\nok\n```\n\nDone.'
const HEREDOC = '```bash\ncat <<EOF\n```bash\nEOF\n```\n\nOutput:\n\n```\nok\n```\n\nDone.'

// The first bare block after the early close is an inner block, not the outer closer.
const SECOND_INNER_BARE = '```markdown\n## Build\n```bash\nnpm i\n```\n## Output\n```\nok\n```\n```\n\nAfter.'

// JbZ's shape, with an ordinary bare block further on.
const LATER_BARE = '```markdown\n### H\n```bash\nuv run x\n```\nRead-only.\n```\n\nAlso worth noting.\n\n```\nmore\n```\n\nEnd.'

// JbZ's shape, with an ordinary block that names a language further on: every
// bare block closes, so a streaming pass may repair it.
const LANG_AFTER = '```markdown\n### H\n```bash\nuv run x\n```\nRead-only.\n```\n\nAlso worth noting.\n\n```bash\nmore\n```\n\nEnd.'
const LANG_AFTER_REPAIRED =
  '````markdown\n### H\n```bash\nuv run x\n```\nRead-only.\n````\n\nAlso worth noting.\n\n```bash\nmore\n```\n\nEnd.'

// Shapes a line-based guess got wrong: none of them nests anything.
const LIST_MARKER = '1. ```bash\n   npm i\n   ```\n\nThen:\n\n```ts\nconst a = 1\n```\n\nOutput:\n\n```\nok\n```\n\nDone.'
const INDENTED_BARE_LINE =
  '```bash\ncat <<EOF\n    ```\nEOF\n```\n\nThen:\n\n```ts\nconst a = 1\n```\n\nOutput:\n\n```\nok\n```\n\nDone.'
const CLOSER_LENGTH = '```md\nx\n````bash\ny\n```\n```\n\nText\n\n```\nz\n```\n\nDone.'

const JBZ = '```markdown\n### H\n```bash\nuv run x\n```\nRead-only.\n```\n'
const JBZ_REPAIRED = '````markdown\n### H\n```bash\nuv run x\n```\nRead-only.\n````\n'
const TWO_JBZ = `${JBZ}\nMid.\n\n${JBZ}\nAfter.`

// A python string, then a snippet with nothing bare between: the python block's
// first bare sibling is the snippet's own closer, which only the later repair takes.
const PYTHON_THEN_SNIPPET = `\`\`\`python\ns = """\n\`\`\`json\n"""\n\`\`\`\n\nDoc:\n\n${JBZ}\nAfter.`

// Known gap: the bare block after the markdown block swallowed ```python and reads
// as its closer while the last block is open; once that block closes over ```js,
// the bare block is a snippet itself and is repaired from the last.
const CHAIN = '```markdown\n```bash\nx\n```\n```\n```python\ny\n```\n```\n```js\nz\n```\n\nEnd.'

/** Line indices `repaired` widened relative to `text`. */
const widened = (text: string, repaired: string): number[] => {
  const before = text.split('\n')
  return repaired.split('\n').flatMap((line, i) => (line !== before[i] ? [i] : []))
}

/** ~500 random line layouts, seeded like `drafts/nfrev_fuzz.mts`. */
const layouts = (count: number): string[] => {
  const alphabet = ['```markdown', '```bash', '```', '```', '```', 'text', '', '```python', 'prose line']
  let seed = 12345
  const next = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed % n
  }
  return Array.from({ length: count }, () => {
    const lines = Array.from({ length: 6 + next(12) }, () => alphabet[next(alphabet.length)])
    return `${lines.join('\n')}\n\nEnd.`
  })
}

/**
 * Every streaming prefix either leaves the text as written or widens only lines
 * the complete repair of its complete lines widens the same way, and a line once
 * widened stays so at later prefixes. True when `text` breaks it.
 */
const streamingBreaks = (text: string): boolean => {
  let before = new Map<number, string>()
  for (let end = 0; end <= text.length; end++) {
    if (end !== 0 && end !== text.length && text[end - 1] !== '\n') continue
    const prefix = text.slice(0, end)
    const result = repairNestedFences(prefix, { streaming: true })
    const head = prefix.slice(0, prefix.lastIndexOf('\n') + 1)
    const complete = repairNestedFences(head).split('\n')
    const lines = result.split('\n')
    const now = new Map(widened(prefix, result).map((i) => [i, lines[i]]))
    for (const [i, line] of now) if (complete[i] !== line) return true
    for (const [i, line] of before) if (now.get(i) !== line) return true
    before = now
  }
  return false
}

/** A zero-width fence line outside any block sends the text through the parser without giving it anything to repair. */
const throughParser = (text: string): string => `${text}\n\n${ZW}\`\`\``

describe('repairNestedFences', () => {
  it('lengthens the outer fence around an unescaped nested block', () => {
    expect(repairNestedFences(UNESCAPED)).toBe(
      [
        "Here's the exact block to drop into the Workflow section:",
        '',
        '````markdown',
        "### Explain a deal's AVB rebate calculation",
        '',
        '```bash',
        'uv run scripts/explain_deal_avb.py --id=DEAL_ID_OR_URL',
        '```',
        '',
        "The script is read-only. It walks a single deal's AVB rebate through:",
        '1. AVB contact resolution',
        '2. The local tier and any matching special rate',
        '````',
        '',
        'Also worth noting for whoever does the edit: the References section is dangling.'
      ].join('\n')
    )
  })

  it('drops the zero-width space from nested fence lines and lengthens the outer fence', () => {
    const repaired = repairNestedFences(ZERO_WIDTH_ESCAPED)
    expect(repaired).toBe(
      [
        'add something like this to the Workflow section yourself:',
        '',
        '````',
        "### Explain a deal's AVB rebate calculation",
        '',
        '```bash',
        'uv run scripts/explain_deal_avb.py --id=DEAL_ID_OR_URL',
        '```',
        '````'
      ].join('\n')
    )
    expect(repaired).not.toContain(ZW)
  })

  it('repairs an unescaped nested block inside a bare outer fence', () => {
    const text = 'Add this:\n\n```\n### Heading\n\n```bash\nuv run x\n```\nRead-only.\n```\n\nAfter.'
    expect(repairNestedFences(text)).toBe(
      'Add this:\n\n````\n### Heading\n\n```bash\nuv run x\n```\nRead-only.\n````\n\nAfter.'
    )
  })

  it('treats a U+FEFF prefix like a zero-width space', () => {
    expect(repairNestedFences(`\`\`\`\n${BOM}\`\`\`bash\nx\n${BOM}\`\`\`\n\`\`\``)).toBe('````\n```bash\nx\n```\n````')
  })

  it('repairs an unescaped nested block inside a list item, keeping the item indentation', () => {
    const text = [
      '- Add this:',
      '',
      '  ```markdown',
      '  ### Heading',
      '  ```bash',
      '  uv run x',
      '  ```',
      '  The script is read-only.',
      '  ```',
      '',
      'After.'
    ].join('\n')
    expect(repairNestedFences(text)).toBe(
      [
        '- Add this:',
        '',
        '  ````markdown',
        '  ### Heading',
        '  ```bash',
        '  uv run x',
        '  ```',
        '  The script is read-only.',
        '  ````',
        '',
        'After.'
      ].join('\n')
    )
  })

  it('closes over every inner block when the snippet holds two', () => {
    expect(repairNestedFences(TWO_INNER)).toBe(TWO_INNER_REPAIRED)
  })

  it('leaves a list-marker opener, an indented bare line and a closer of another length unchanged', () => {
    for (const text of [LIST_MARKER, INDENTED_BARE_LINE, CLOSER_LENGTH]) {
      expect(repairNestedFences(text)).toBe(text)
      expect(repairNestedFences(throughParser(text))).toBe(throughParser(text))
    }
    expect(parses.count).toBeGreaterThan(0)
  })

  it('returns an ordinary reply and fence-free text unchanged without parsing them', () => {
    const ordinary = 'Text\n\n```ts\nconst a = 1\n```\n\nThen\n\n```\nplain\n```\n\n> ```python\n> print(1)\n> ```\n\nMore'
    expect(repairNestedFences(ordinary)).toBe(ordinary)
    const prose = 'Just **prose**, with `inline` code.'
    expect(repairNestedFences(prose)).toBe(prose)
    expect(repairNestedFences('')).toBe('')
    expect(parses.count).toBe(0)
  })

  it('keeps a lone opener-looking line as content, even with ordinary blocks after it', () => {
    const text = [
      '```markdown',
      '### Notes',
      '```python',
      '```',
      '',
      'This paragraph stays outside the block.',
      '',
      '```ts',
      'const a = 1',
      '```',
      '',
      '```',
      'ok',
      '```'
    ].join('\n')
    expect(repairNestedFences(text)).toBe(text)
  })

  it('looks for the outer closer among the siblings of the block only', () => {
    const text = '- ```markdown\n  ```bash\n  x\n  ```\n\n  more\n\nOutside.\n\n```\nok\n```'
    expect(repairNestedFences(text)).toBe(text)
  })

  it('leaves tilde fences, and backtick fences inside them, alone', () => {
    const inside = '~~~markdown\n```md\n```bash\nx\n```\n```\n~~~'
    expect(repairNestedFences(inside)).toBe(inside)
    const tildeOuter = '~~~md\n```bash\nx\n~~~\n\n```sh\ny\n```\n\n```\nok\n```'
    expect(repairNestedFences(tildeOuter)).toBe(tildeOuter)
  })

  it('leaves an already-correct four-backtick outer fence as it is, zero-width lines aside', () => {
    const text = '````markdown\n### Heading\n\n```bash\nuv run x\n```\n````\n\nAfter.'
    expect(repairNestedFences(text)).toBe(text)
    expect(repairNestedFences(`\`\`\`\`\n${ZW}\`\`\`bash\nx\n${ZW}\`\`\`\n\`\`\`\``)).toBe('````\n```bash\nx\n```\n````')
  })

  it('returns a block with no bare block after it unchanged', () => {
    const outerOpen = '```markdown\n```bash\nx\n```'
    expect(repairNestedFences(outerOpen)).toBe(outerOpen)
  })

  it('leaves unpaired and out-of-block zero-width fence lines untouched', () => {
    const outside = `${ZW}\`\`\`bash\nx\n${ZW}\`\`\``
    expect(repairNestedFences(outside)).toBe(outside)
    const unpaired = `\`\`\`\ntext\n${ZW}\`\`\`\nmore\n\`\`\``
    expect(repairNestedFences(unpaired)).toBe(unpaired)
  })

  it('counts a nested closer longer than its opener', () => {
    expect(repairNestedFences('```md\n```bash\nx\n````\n```')).toBe('`````md\n```bash\nx\n````\n`````')
  })

  it('keeps indentation, info strings and CRLF line endings', () => {
    expect(repairNestedFences('  ```md title\n  ```bash\n  x\n  ```\n  ```')).toBe(
      '  ````md title\n  ```bash\n  x\n  ```\n  ````'
    )
    expect(repairNestedFences('```md\r\n```bash\r\nx\r\n```\r\n```\r\n')).toBe('````md\r\n```bash\r\nx\r\n```\r\n````\r\n')
  })

  it('while streaming, never counts a half-arrived last line', () => {
    const upToRun = '```markdown\n### H\n```bash\nuv run x\n```\nRead-only.\n```\n\nAlso worth noting.\n\n```bash\nmore\n```'
    // These backticks may yet become ```python, which would leave the bare block unclosed.
    expect(repairNestedFences(upToRun, { streaming: true })).toBe(upToRun)
    expect(repairNestedFences(`${upToRun}\n`, { streaming: true })).toBe(
      '````markdown\n### H\n```bash\nuv run x\n```\nRead-only.\n````\n\nAlso worth noting.\n\n```bash\nmore\n```\n'
    )
    // A partial line after a repaired head is appended as it arrived.
    expect(repairNestedFences(LANG_AFTER.slice(0, -2), { streaming: true })).toBe(LANG_AFTER_REPAIRED.slice(0, -2))
  })

  it('while streaming, leaves a block alone while its closer is unclosed', () => {
    // It may yet be closed and turn out an ordinary block; the turn repairs at finalize.
    expect(repairNestedFences(`${TWO_INNER}\n`, { streaming: true })).toBe(`${TWO_INNER}\n`)
    expect(repairNestedFences(TWO_INNER)).toBe(TWO_INNER_REPAIRED)
    expect(repairNestedFences(UNESCAPED, { streaming: true })).toBe(UNESCAPED)
  })

  it('while streaming, never repairs a snippet at a closed closer while a later one is unclosed', () => {
    // The closed `ok` block would read less broken than the text as it stands, and
    // finalize would then move the closer to the last fence.
    for (let end = 0; end <= SECOND_INNER_BARE.length; end++) {
      const prefix = SECOND_INNER_BARE.slice(0, end)
      expect(repairNestedFences(prefix, { streaming: true }), JSON.stringify(prefix)).toBe(prefix)
    }
  })

  it('decides to wait before parsing any closer', () => {
    const text = `${TWO_INNER} (waits)\n`
    expect(repairNestedFences(text, { streaming: true })).toBe(text)
    expect(parses.count).toBe(1)
  })

  it('parses once, then once per repair', () => {
    expect(repairNestedFences(TWO_JBZ)).toBe(`${JBZ_REPAIRED}\nMid.\n\n${JBZ_REPAIRED}\nAfter.`)
    expect(parses.count).toBe(3)
    // Only the first bare block after it is read, however many follow.
    parses.count = 0
    const text = '```markdown\n## Capped\n```bash\nnpm i\n```\n' + '\n```\nok\n```\n'.repeat(12)
    expect(repairNestedFences(text)).toBe(text)
    expect(parses.count).toBe(1)
  })

  it('never changes a python string or a heredoc at any streaming prefix', () => {
    for (const text of [PYTHON_STRING, HEREDOC]) {
      for (let end = 0; end <= text.length; end++) {
        const prefix = text.slice(0, end)
        expect(repairNestedFences(prefix, { streaming: true }), JSON.stringify(prefix)).toBe(prefix)
      }
    }
  })

  it('while streaming, shows only lines the complete repair widens the same way, and never takes one back', () => {
    const named = [TWO_INNER, UNESCAPED, ZERO_WIDTH_ESCAPED, LATER_BARE, SECOND_INNER_BARE, LANG_AFTER, TWO_JBZ]
    for (const text of named) expect(streamingBreaks(text), JSON.stringify(text)).toBe(false)
    expect(repairNestedFences(LANG_AFTER, { streaming: true })).toBe(LANG_AFTER_REPAIRED)
    // Two snippets: the first closer swallowed the second's opener, the second's is still open.
    expect(widened(`${TWO_JBZ}\n`, repairNestedFences(`${TWO_JBZ}\n`, { streaming: true }))).toEqual([0, 6])
  })

  it('holds the streaming property over random layouts, but for the known chain', () => {
    const breaking = layouts(500).filter(streamingBreaks)
    // CHAIN's shape: see its comment. Anything else breaking it is a regression.
    expect(breaking).toEqual([
      '```markdown\n```\n```\n```bash\nprose line\n```\n```\ntext\ntext\n```python\n\n```\n```\n```bash\n\nEnd.'
    ])
  })

  it('shows the known chain gap: a streaming repair gives way when its closer turns into a snippet', () => {
    const upToPython = CHAIN.split('\n').slice(0, 9).join('\n') + '\n'
    expect(widened(upToPython, repairNestedFences(upToPython, { streaming: true }))).toEqual([0, 4])
    expect(widened(CHAIN, repairNestedFences(CHAIN))).toEqual([4, 8])
  })

  it('leaves a python string and a heredoc that hold a lone opener line unchanged', () => {
    expect(repairNestedFences(PYTHON_STRING)).toBe(PYTHON_STRING)
    expect(repairNestedFences(HEREDOC)).toBe(HEREDOC)
  })

  it('leaves a snippet unchanged when the first bare block after it closes without swallowing an opener', () => {
    // A bare block with no opener in it is as likely an inner block of the snippet,
    // or an ordinary block after it, as the outer closer: the evidence is ambiguous
    // with a code block that merely shows a fence line, so the text stays as parsed.
    expect(repairNestedFences(SECOND_INNER_BARE)).toBe(SECOND_INNER_BARE)
    expect(repairNestedFences(LATER_BARE)).toBe(LATER_BARE)
  })

  it('repairs two snippets separately, keeping the prose between them outside', () => {
    const repaired = repairNestedFences(TWO_JBZ)
    expect(repaired).toBe(`${JBZ_REPAIRED}\nMid.\n\n${JBZ_REPAIRED}\nAfter.`)
  })

  it('repairs only the snippet after a python string and an ordinary block', () => {
    const text = `\`\`\`python\ns = """\n\`\`\`json\n"""\n\`\`\`\n\nOutput:\n\n\`\`\`\nok\n\`\`\`\n\nDoc:\n\n${JBZ}\nAfter.`
    expect(repairNestedFences(text)).toBe(text.replace(JBZ, JBZ_REPAIRED))
  })

  it('repairs a later snippet before an earlier block that would close over it', () => {
    expect(repairNestedFences(PYTHON_THEN_SNIPPET)).toBe(PYTHON_THEN_SNIPPET.replace(JBZ, JBZ_REPAIRED))
  })

  it('drops zero-width spaces a repair brings into a block', () => {
    // A zero-width-escaped snippet after a broken one: the swallowing block holds its pairs.
    const after = `${JBZ}\nMid.\n\n\`\`\`markdown\n### Z\n${ZW}\`\`\`bash\ny\n${ZW}\`\`\`\n\`\`\`\n\nAfter.`
    expect(repairNestedFences(after)).not.toContain(ZW)
    // Escaped fences after the broken inner block are prose until the repair.
    const inside = `\`\`\`markdown\n### H\n\`\`\`bash\nx\n\`\`\`\nAlso:\n${ZW}\`\`\`sh\ny\n${ZW}\`\`\`\n\`\`\`\n\n\`\`\`bash\nmore\n\`\`\`\n\nEnd.`
    expect(repairNestedFences(inside)).toBe(
      '````markdown\n### H\n```bash\nx\n```\nAlso:\n```sh\ny\n```\n````\n\n```bash\nmore\n```\n\nEnd.'
    )
  })

  it('repairs a nested block followed by an ordinary block that names a language', () => {
    expect(repairNestedFences(LANG_AFTER)).toBe(LANG_AFTER_REPAIRED)
  })

  it('does not parse a reply whose outer fence is already longer than the ones inside it', () => {
    const text = '````markdown\n## Build\n```bash\nnpm i\n```\n\n```\nok\n```\n````\n\nAfter.'
    expect(repairNestedFences(text)).toBe(text)
    expect(repairNestedFences(text, { streaming: true })).toBe(text)
    expect(parses.count).toBe(0)
  })

  it('parses a streaming head once while only its last line grows', () => {
    const head = '```markdown\n### Cached\n```bash\nuv run cached\n```\nRead-only.\n```\n\n'
    expect(repairNestedFences(`${head}Al`, { streaming: true })).toBe(`${head}Al`)
    const afterFirst = parses.count
    expect(afterFirst).toBeGreaterThan(0)
    expect(repairNestedFences(`${head}Also wor`, { streaming: true })).toBe(`${head}Also wor`)
    expect(parses.count).toBe(afterFirst)
  })

  it('keeps cached results apart by text and by streaming', () => {
    // Complete, the bare block is the closer; streaming, it may still become an opener.
    const head = '```md\n### Apart\n```bash\nx\n```\nRead-only.\n```\n'
    const repaired = '````md\n### Apart\n```bash\nx\n```\nRead-only.\n````\n'
    const other = '```md\n### Other\n```bash\ny\n```\nRead-only.\n```\n'
    expect(repairNestedFences(head, { streaming: true })).toBe(head)
    expect(repairNestedFences(head)).toBe(repaired)
    expect(repairNestedFences(head, { streaming: true })).toBe(head)
    expect(repairNestedFences(other)).toBe('````md\n### Other\n```bash\ny\n```\nRead-only.\n````\n')
    expect(repairNestedFences(head)).toBe(repaired)
  })
})
