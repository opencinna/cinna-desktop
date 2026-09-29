import { describe, expect, it } from 'vitest'
import { fenceLanguageFor, fileNoteFromContents } from './fileNote'

describe('fileNoteFromContents — title', () => {
  it('takes a markdown file\'s frontmatter title first', () => {
    const text = '---\ntitle: "Quarterly plan"\nowner: me\n---\n# Heading\n'
    expect(fileNoteFromContents('/a/plan.md', text)).toEqual({ title: 'Quarterly plan', body: text })
  })

  it('takes the first H1, ATX or setext, over an earlier lower heading', () => {
    expect(fileNoteFromContents('/a/x.md', '## Intro\n\n# Main title #\n').title).toBe('Main title')
    expect(fileNoteFromContents('/a/x.markdown', '### Small\n\nBig title\n=========\n').title).toBe('Big title')
  })

  it('falls back to the first heading of any level, then the file name', () => {
    expect(fileNoteFromContents('/a/x.md', 'Some text\n\n### Only heading\n').title).toBe('Only heading')
    expect(fileNoteFromContents('/a/x.md', 'Sub\n---\n').title).toBe('Sub')
    expect(fileNoteFromContents('/a/notes.md', 'No headings at all.\n').title).toBe('notes.md')
  })

  it('ignores headings inside fenced code', () => {
    expect(fileNoteFromContents('/a/readme.md', '```sh\n# comment\n```\n\nText\n').title).toBe('readme.md')
  })

  it('uses the file name for everything that is not markdown', () => {
    expect(fileNoteFromContents('/a/b/main.py', '# not a heading\nprint(1)\n').title).toBe('main.py')
    expect(fileNoteFromContents('/a/todo.txt', '# Heading\n').title).toBe('todo.txt')
  })
})

describe('fileNoteFromContents — body', () => {
  it('keeps markdown and plain text as written', () => {
    expect(fileNoteFromContents('/a/x.md', '# T\nbody').body).toBe('# T\nbody')
    expect(fileNoteFromContents('/a/x.txt', 'plain').body).toBe('plain')
  })

  it('fences other text files, tagged with their language', () => {
    expect(fileNoteFromContents('/a/main.py', 'print(1)\n').body).toBe('```py\nprint(1)\n```')
    expect(fileNoteFromContents('/a/cfg.yml', 'a: 1').body).toBe('```yaml\na: 1\n```')
    expect(fileNoteFromContents('/a/server.log', 'started').body).toBe('```\nstarted\n```')
    expect(fileNoteFromContents('/a/Makefile', 'all:\n').body).toBe('```makefile\nall:\n```')
  })

  it('makes the fence longer than the longest backtick run inside', () => {
    const text = 'const s = `x`\n/* ```` */\n'
    expect(fileNoteFromContents('/a/x.ts', text).body).toBe('`````ts\n' + text + '`````')
  })
})

describe('fenceLanguageFor', () => {
  it('gives a file named after an Object member an untagged fence', () => {
    expect(fileNoteFromContents('/a/b.constructor', 'x').body).toBe('```\nx\n```')
  })

  it.each([
    ['a.ts', 'ts'], ['a.tsx', 'tsx'], ['a.json', 'json'], ['a.sh', 'sh'], ['a.yaml', 'yaml'],
    ['Dockerfile', 'dockerfile'], ['a.unknownext', ''], ['a.out', ''],
    // Object.prototype members are not languages.
    ['x.constructor', ''], ['x.toString', ''], ['constructor', ''], ['__proto__', '']
  ])('%s → %s', (name, language) => {
    expect(fenceLanguageFor(name)).toBe(language)
  })
})
