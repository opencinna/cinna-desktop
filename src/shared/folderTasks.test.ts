import { describe, expect, it } from 'vitest'
import {
  EMPTY_FOLDER_BOARD,
  HANDOFF_CLOSE,
  HANDOFF_OPEN,
  folderBoardColumns,
  folderCategoryOf,
  folderCustomFields,
  folderLabelMapsTo,
  folderStatusOf,
  folderTaskFileName,
  folderTaskId,
  folderTaskSlug,
  folderWordForStatus,
  formatFolderValue,
  isFolderTaskFileName,
  normalizeStatusWord,
  parseFolderBoard,
  parseFolderTaskFile,
  patchFolderTaskFile,
  renderFolderTaskFile
} from './folderTasks'

/** A file a teammate wrote by hand: comments, a nested map, a block list, CRLF-free. */
const HAND_WRITTEN = [
  '---',
  '# written by hand',
  'title: Fix the login bug',
  'status: In Progress',
  'priority: high',
  'estimate: 3',
  'labels: [ui, "docs, maybe"]',
  'meta:',
  '  owner: sam',
  '  links:',
  '    - https://example.test/1',
  '',
  '    - https://example.test/2',
  'blocked_by:',
  '  - t-aaaa',
  '  - t-bbbb',
  'notes: |',
  '  line one',
  '  line two',
  'done_when: "tests pass # really"',
  '---',
  'The login form rejects valid passwords.',
  '',
  'Steps in the issue.',
  ''
].join('\n')

describe('parseFolderTaskFile', () => {
  it('reads owned keys, defaults id to the stem and the version to none', () => {
    const parsed = parseFolderTaskFile(HAND_WRITTEN, 'fix-login')!
    expect(parsed.id).toBe('fix-login')
    expect(parsed.idFromFile).toBe(false)
    expect(parsed.version).toBeNull()
    expect(parsed.title).toBe('Fix the login bug')
    expect(parsed.status).toBe('In Progress')
    expect(parsed.priority).toBe('high')
    expect(parsed.blockedBy).toEqual(['t-aaaa', 't-bbbb'])
    expect(parsed.description).toBe('The login form rejects valid passwords.\n\nSteps in the issue.')
    expect(parsed.handoffNote).toBeNull()
  })

  it('surfaces nested custom values as read-only text and one-liners as editable', () => {
    const parsed = parseFolderTaskFile(HAND_WRITTEN, 'fix-login')!
    const byKey = Object.fromEntries(parsed.custom.map((field) => [field.key, field]))
    expect(byKey.estimate).toEqual({ key: 'estimate', value: 3, editable: true })
    expect(byKey.labels).toEqual({ key: 'labels', value: ['ui', 'docs, maybe'], editable: true })
    expect(byKey.done_when).toEqual({ key: 'done_when', value: 'tests pass # really', editable: true })
    expect(byKey.meta.editable).toBe(false)
    expect(byKey.meta.value).toBe('owner: sam\nlinks:\n  - https://example.test/1\n\n  - https://example.test/2')
    expect(byKey.notes).toEqual({ key: 'notes', value: '|\nline one\nline two', editable: false })
    expect(folderCustomFields(parsed)).toMatchObject({ estimate: 3, labels: ['ui', 'docs, maybe'] })
  })

  it('reads an explicit id, a version and the handoff section apart from the description', () => {
    const text = [
      '---', 'cinna_task: 1', 'id: t-abc', 'title: "Quoted: title"', '---', 'Body.', '',
      HANDOFF_OPEN, 'Half done.', 'Next: tests.', HANDOFF_CLOSE, ''
    ].join('\n')
    const parsed = parseFolderTaskFile(text, 'whatever')!
    expect(parsed).toMatchObject({ id: 't-abc', idFromFile: true, version: 1, title: 'Quoted: title' })
    expect(parsed.description).toBe('Body.')
    expect(parsed.handoffNote).toBe('Half done.\nNext: tests.')
  })

  it('is not a task without frontmatter, and leaves invalid or reserved custom keys out', () => {
    expect(parseFolderTaskFile('# Just notes\n', 'notes')).toBeNull()
    const parsed = parseFolderTaskFile('---\ntitle: X\nassignee: sam\n9lives: yes\nok_key: 1\n---\n', 'x')!
    expect(parsed.custom.map((field) => field.key)).toEqual(['ok_key'])
  })

  it('accepts a BOM and CRLF line endings', () => {
    const parsed = parseFolderTaskFile('﻿---\r\ntitle: Win\r\nstatus: todo\r\n---\r\nBody\r\n', 'win')!
    expect(parsed).toMatchObject({ title: 'Win', status: 'todo', description: 'Body' })
  })
})

describe('patchFolderTaskFile', () => {
  it('changes only the owned lines: nested custom YAML survives a title and status patch byte for byte', () => {
    const patched = patchFolderTaskFile(HAND_WRITTEN, { title: 'Fix the login bug for good', status: 'done' })
    const before = HAND_WRITTEN.split('\n')
    const after = patched.split('\n')
    expect(after.length).toBe(before.length)
    const changed = after.map((line, index) => (line === before[index] ? null : index)).filter((index) => index !== null)
    expect(changed).toEqual([2, 3])
    expect(after[2]).toBe('title: Fix the login bug for good')
    expect(after[3]).toBe('status: done')
    expect(parseFolderTaskFile(patched, 'fix-login')!.custom).toEqual(parseFolderTaskFile(HAND_WRITTEN, 'fix-login')!.custom)
  })

  it('adds a missing owned key before the closing line and removes one set to null', () => {
    const added = patchFolderTaskFile('---\ntitle: A\n---\nBody\n', { id: 't-1', parent: 't-0' })
    expect(added).toBe('---\ntitle: A\nid: t-1\nparent: t-0\n---\nBody\n')
    expect(patchFolderTaskFile(added, { parent: null })).toBe('---\ntitle: A\nid: t-1\n---\nBody\n')
  })

  it('rewrites one scalar custom key, adds and removes others, and never touches a nested one', () => {
    const patched = patchFolderTaskFile(HAND_WRITTEN, {
      custom: { estimate: 5, labels: undefined, area: 'billing', meta: 'flattened?' }
    })
    expect(patched).toContain('\nestimate: 5\n')
    expect(patched).not.toContain('labels:')
    expect(patched).toContain('\narea: billing\n---\n')
    expect(patched).toContain('meta:\n  owner: sam\n')
    expect(patched).not.toContain('flattened')
  })

  it('replaces a nested owned key with one line', () => {
    const patched = patchFolderTaskFile(HAND_WRITTEN.replace('title: Fix the login bug', 'title: |\n  Fix the\n  login bug'), {
      title: 'One line'
    })
    expect(parseFolderTaskFile(patched, 'x')!.title).toBe('One line')
    expect(patched).not.toContain('  Fix the')
  })

  it('keeps CRLF and the BOM on the lines it writes', () => {
    const text = '﻿---\r\ntitle: Win\r\nmeta:\r\n  a: 1\r\n---\r\nBody\r\n'
    const patched = patchFolderTaskFile(text, { status: 'open' })
    expect(patched).toBe('﻿---\r\ntitle: Win\r\nmeta:\r\n  a: 1\r\nstatus: open\r\n---\r\nBody\r\n')
  })

  it('writes the handoff section at the end and replaces it, leaving the description alone', () => {
    const first = patchFolderTaskFile('---\ntitle: A\n---\nDo the thing.\n', { handoffNote: 'Half done.' })
    expect(first).toBe(`---\ntitle: A\n---\nDo the thing.\n\n${HANDOFF_OPEN}\nHalf done.\n${HANDOFF_CLOSE}\n`)
    const second = patchFolderTaskFile(first, { handoffNote: 'All done.' })
    expect(second).toBe(`---\ntitle: A\n---\nDo the thing.\n\n${HANDOFF_OPEN}\nAll done.\n${HANDOFF_CLOSE}\n`)
    expect(patchFolderTaskFile(second, { handoffNote: null })).toBe('---\ntitle: A\n---\nDo the thing.\n')
  })

  it('replaces the description, leaving the handoff section alone', () => {
    const text = `---\ntitle: A\n---\nOld.\n\n${HANDOFF_OPEN}\nNote.\n${HANDOFF_CLOSE}\n`
    const patched = patchFolderTaskFile(text, { description: 'New\ntext.' })
    expect(patched).toBe(`---\ntitle: A\n---\nNew\ntext.\n\n${HANDOFF_OPEN}\nNote.\n${HANDOFF_CLOSE}\n`)
    expect(parseFolderTaskFile(patched, 'a')!).toMatchObject({ description: 'New\ntext.', handoffNote: 'Note.' })
  })

  it('takes an opening marker with no closing one as the user’s text: appends a section, replaces nothing', () => {
    const text = `---\ntitle: A\n---\nIntro.\n${HANDOFF_OPEN}\nKeep this paragraph.\nAnd this one.\n`
    const patched = patchFolderTaskFile(text, { handoffNote: 'Half done.' })
    expect(patched).toBe(`${text}\n${HANDOFF_OPEN}\nHalf done.\n${HANDOFF_CLOSE}\n`)
    expect(parseFolderTaskFile(text, 'a')!).toMatchObject({
      description: `Intro.\n${HANDOFF_OPEN}\nKeep this paragraph.\nAnd this one.`, handoffNote: null
    })
    // And clearing the note leaves that text where it is.
    expect(patchFolderTaskFile(text, { handoffNote: null })).toBe(text)
  })

  it('keeps a stray opening marker’s text through two handoff writes', () => {
    const text = `---\ntitle: A\n---\nIntro.\n${HANDOFF_OPEN}\nUser text after a quoted marker.\n`
    const first = patchFolderTaskFile(text, { handoffNote: 'Note 1' })
    expect(parseFolderTaskFile(first, 'a')!).toMatchObject({
      description: `Intro.\n${HANDOFF_OPEN}\nUser text after a quoted marker.`, handoffNote: 'Note 1'
    })
    const second = patchFolderTaskFile(first, { handoffNote: 'Note 2' })
    expect(second).toBe(`${text}\n${HANDOFF_OPEN}\nNote 2\n${HANDOFF_CLOSE}\n`)
  })

  it('reads only the text between the markers as the note; text after the section is the user’s', () => {
    const text = `---\ntitle: A\n---\nIntro.\n\n${HANDOFF_OPEN}\nNote.\n${HANDOFF_CLOSE}\n\nAfterword, mine.\n`
    expect(parseFolderTaskFile(text, 'a')!).toMatchObject({ description: 'Intro.\n\nAfterword, mine.', handoffNote: 'Note.' })
  })

  it('keeps the user’s text after the closing marker byte for byte when the note changes or goes', () => {
    const tail = '\r\nAfterword,   mine.  \n\n  - a list\n'
    const text = `---\ntitle: A\n---\nIntro.\n\n${HANDOFF_OPEN}\nOld note.\n${HANDOFF_CLOSE}${tail}`
    const replaced = patchFolderTaskFile(text, { handoffNote: 'New note.' })
    expect(replaced).toBe(`---\ntitle: A\n---\nIntro.\n\n${HANDOFF_OPEN}\nNew note.\n${HANDOFF_CLOSE}${tail}`)
    expect(parseFolderTaskFile(replaced, 'a')!.handoffNote).toBe('New note.')
    const removed = patchFolderTaskFile(text, { handoffNote: null })
    expect(removed).toBe(`---\ntitle: A\n---\nIntro.\n\n${tail.slice(2)}`)
  })

  it('round-trips awkward titles through quoting', () => {
    for (const title of ['null', 'a: b', 'has # hash', ' padded ', 'say "hi"', 'back\\slash', '42']) {
      const patched = patchFolderTaskFile('---\ntitle: x\n---\n', { title })
      const read = parseFolderTaskFile(patched, 's')!.title
      expect(read).toBe(title.trim())
    }
    expect(formatFolderValue('Plain words')).toBe('Plain words')
  })

  it('refuses a file with no frontmatter', () => {
    expect(() => patchFolderTaskFile('no frontmatter', { title: 'x' })).toThrow()
  })
})

describe('renderFolderTaskFile', () => {
  it('writes the fixed key order and reads back to the same task', () => {
    const text = renderFolderTaskFile({
      id: 't-abcdefgh',
      title: 'Write docs',
      status: 'todo',
      priority: 'normal',
      origin: 'cinna',
      custom: { area: 'docs', estimate: 2, labels: ['a', 'b'], ok: true },
      description: 'All of them.',
      handoffNote: null
    })
    expect(text).toBe([
      '---', 'cinna_task: 1', 'id: t-abcdefgh', 'title: Write docs', 'status: todo', 'priority: normal',
      'origin: cinna', 'area: docs', 'estimate: 2', 'labels: [a, b]', 'ok: true', '---', 'All of them.', ''
    ].join('\n'))
    expect(parseFolderTaskFile(text, 'write-docs')).toMatchObject({
      id: 't-abcdefgh', title: 'Write docs', status: 'todo', description: 'All of them.'
    })
    expect(folderCustomFields(parseFolderTaskFile(text, 'x')!)).toEqual({ area: 'docs', estimate: 2, labels: ['a', 'b'], ok: true })
  })

  it('names files from the title and ids from random bytes', () => {
    expect(folderTaskSlug('Fix the Login bug!')).toBe('fix-the-login-bug')
    expect(folderTaskSlug('Café ünïcode')).toBe('cafe-unicode')
    expect(folderTaskSlug('!!!')).toBe('task')
    expect(folderTaskFileName('a', 1)).toBe('a.md')
    expect(folderTaskFileName('a', 3)).toBe('a-3.md')
    expect(folderTaskId(new Uint8Array([0, 1, 31, 32, 33, 0, 0, 0]))).toBe('t-ab7abaaa')
    expect(isFolderTaskFileName('a.md')).toBe(true)
    expect(isFolderTaskFileName('.a.md')).toBe(false)
    expect(isFolderTaskFileName('_board.yaml')).toBe(false)
  })
})

describe('status words', () => {
  const board = parseFolderBoard([
    '# our words',
    'Icebox: backlog',
    'Up Next: ready',
    '"on hold": waiting',
    'todo: done',
    'nonsense: whatever',
    '  indented: ready',
    'Icebox: active'
  ].join('\n'))

  it('normalizes words and reads _board.yaml in order, first line wins', () => {
    expect(normalizeStatusWord(' In-Progress ')).toBe('in_progress')
    expect(board.entries.map((entry) => [entry.label, entry.category])).toEqual([
      ['Icebox', 'backlog'], ['Up Next', 'ready'], ['on hold', 'waiting'], ['todo', 'done']
    ])
  })

  it('maps words through the board first, then the defaults; unmapped is new and inert', () => {
    expect(folderCategoryOf('todo', EMPTY_FOLDER_BOARD)).toBe('backlog')
    expect(folderCategoryOf('todo', board)).toBe('done')
    expect(folderCategoryOf('WIP', board)).toBe('active')
    expect(folderStatusOf('Up next', board)).toEqual({ status: 'open', category: 'ready' })
    expect(folderStatusOf('wontfix', board)).toEqual({ status: 'cancelled', category: 'cancelled' })
    expect(folderStatusOf('archived', board)).toEqual({ status: 'archived', category: 'hidden' })
    expect(folderStatusOf('someday', board)).toEqual({ status: 'new', category: null })
    expect(folderStatusOf(null, board)).toEqual({ status: 'new', category: 'backlog' })
    expect(folderLabelMapsTo('on hold', 'blocked', board)).toBe(true)
    expect(folderLabelMapsTo('someday', 'new', board)).toBe(false)
  })

  it('orders columns by category: board words, then default words in use; unmapped words in use last', () => {
    const columns = folderBoardColumns(board, ['Doing', 'someday', 'icebox', 'review', 'Done', 'aaa'])
    expect(columns.map((column) => [column.label, column.category, column.status, column.droppable])).toEqual([
      ['Icebox', 'backlog', 'new', true],
      ['Up Next', 'ready', 'open', true],
      ['Doing', 'active', 'in_progress', false],
      ['on hold', 'waiting', 'blocked', false],
      ['review', 'waiting', 'blocked', false],
      ['todo', 'done', 'completed', true],
      ['Done', 'done', 'completed', true],
      ['aaa', null, 'new', false],
      ['someday', null, 'new', false]
    ])
  })

  it('puts a default word in use in its category, not after every board word', () => {
    const own = parseFolderBoard('Doing: active\nShipped: done\n')
    expect(folderBoardColumns(own, ['todo', 'Doing']).map((column) => column.label)).toEqual(['todo', 'Doing', 'Shipped'])
  })

  it('adds a canonical column for an occupied category that has none, in category order', () => {
    const own = parseFolderBoard('Doing: active\nShipped: done\n')
    const columns = folderBoardColumns(own, ['todo'], ['ready', 'active', 'waiting', 'done', 'failed'])
    expect(columns.map((column) => [column.label, column.category, column.status, column.droppable])).toEqual([
      ['todo', 'backlog', 'new', true],
      ['open', 'ready', 'open', true],
      ['Doing', 'active', 'in_progress', false],
      ['blocked', 'waiting', 'blocked', false],
      ['Shipped', 'done', 'completed', true],
      ['error', 'failed', 'error', false]
    ])
    // No fallback for a category nothing sits in, and none when the category has a word.
    expect(folderBoardColumns(EMPTY_FOLDER_BOARD, ['wip'], ['active']).map((column) => column.label)).toEqual(['wip'])
    expect(folderBoardColumns(EMPTY_FOLDER_BOARD, [], []).map((column) => column.label)).toEqual([])
  })

  it('writes nothing when the word already fits, else the first board word, else the canonical one', () => {
    expect(folderWordForStatus('in_progress', 'doing', board, [])).toBeNull()
    expect(folderWordForStatus('open', 'Icebox', board, [])).toBe('Up Next')
    expect(folderWordForStatus('in_progress', 'Icebox', board, ['WIP'])).toBe('WIP')
    expect(folderWordForStatus('in_progress', 'Icebox', board, [])).toBe('in_progress')
    expect(folderWordForStatus('error', null, EMPTY_FOLDER_BOARD, [])).toBe('error')
    expect(folderWordForStatus('new', 'someday', board, [])).toBe('Icebox')
    expect(folderWordForStatus('archived', null, EMPTY_FOLDER_BOARD, [])).toBe('archived')
  })
})
