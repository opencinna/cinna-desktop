import { describe, expect, it } from 'vitest'
import { isMemoryNote, memoryInfo, noteIdsForTag, noteTags, splitNotes, tagFilterChips } from './noteIndex'

const MEMORY = '---\nkind: assistant-memory\nmemory_type: preference\nsummary: Likes tea\n---\nPrefers green tea.'

describe('isMemoryNote', () => {
  it('reads kind: assistant-memory', () => {
    expect(isMemoryNote(MEMORY)).toBe(true)
  })

  it('reads a quoted value', () => {
    expect(isMemoryNote('---\nkind: "assistant-memory"\n---\nx')).toBe(true)
    expect(isMemoryNote("---\nkind: 'assistant-memory'\n---\nx")).toBe(true)
  })

  it('reads through a BOM and CRLF line endings', () => {
    expect(isMemoryNote('﻿---\r\nkind: assistant-memory\r\n---\r\nx')).toBe(true)
  })

  it('finds kind when it is not the first key', () => {
    expect(isMemoryNote('---\ntitle: Tea\ncreated: 2026-11-14\nkind: assistant-memory\n---\nx')).toBe(true)
  })

  it('is false for other kind values', () => {
    expect(isMemoryNote('---\nkind: note\n---\nx')).toBe(false)
    expect(isMemoryNote('---\nkind: assistant-memory-old\n---\nx')).toBe(false)
    expect(isMemoryNote('---\nkind: [assistant-memory]\n---\nx')).toBe(false)
  })

  it('is false without frontmatter, or with kind only in the body', () => {
    expect(isMemoryNote('kind: assistant-memory')).toBe(false)
    expect(isMemoryNote('# Memory\n\nkind: assistant-memory')).toBe(false)
  })

  it('is false for a --- thematic break that is not frontmatter', () => {
    expect(isMemoryNote('---\n# Heading\nkind: assistant-memory\n---\nx')).toBe(false)
    expect(isMemoryNote('Intro\n---\nkind: assistant-memory\n---')).toBe(false)
  })
})

describe('memoryInfo', () => {
  it('returns the memory type and summary of a memory note', () => {
    expect(memoryInfo(MEMORY)).toEqual({ memoryType: 'preference', summary: 'Likes tea' })
    expect(memoryInfo('---\nkind: assistant-memory\n---\nx')).toEqual({ memoryType: null, summary: null })
  })

  it('is null for any other note', () => {
    expect(memoryInfo('---\nsummary: x\n---\nbody')).toBeNull()
  })
})

describe('noteTags', () => {
  it('reads inline tags of a note without frontmatter', () => {
    expect(noteTags('Pay #Bills and #home')).toEqual([
      { key: 'bills', display: 'Bills' },
      { key: 'home', display: 'home' }
    ])
  })

  it('reads frontmatter list tags first, then body tags, one per key', () => {
    expect(noteTags('---\ntags:\n  - Work\n  - "#inbox/to-read/"\n---\n#work and #later')).toEqual([
      { key: 'work', display: 'Work' },
      { key: 'inbox/to-read', display: 'inbox/to-read' },
      { key: 'later', display: 'later' }
    ])
    expect(noteTags('---\ntags: [a, b]\n---\n')).toEqual([
      { key: 'a', display: 'a' },
      { key: 'b', display: 'b' }
    ])
  })

  it('splits a text scalar on commas and whitespace', () => {
    expect(noteTags('---\ntags: one, two three,#four\n---\nx').map((t) => t.key)).toEqual(['one', 'two', 'three', 'four'])
  })

  it('drops invalid frontmatter tags', () => {
    expect(noteTags('---\ntags: [1984, a.b, ok]\n---\nx').map((t) => t.key)).toEqual(['ok'])
  })

  it('does not read the frontmatter block itself as body tags', () => {
    expect(noteTags('---\ntitle: "#nottag"\nnote: x #nope\n---\nbody').map((t) => t.key)).toEqual([])
  })
})

describe('splitNotes', () => {
  it('splits regular and memory notes, keeping order', () => {
    const notes = [
      { id: 'a', body: 'plain' },
      { id: 'm1', body: MEMORY },
      { id: 'b', body: '---\nkind: note\n---\n' },
      { id: 'm2', body: '---\nkind: assistant-memory\n---\n' }
    ]
    const { regular, memory } = splitNotes(notes)
    expect(regular.map((n) => n.id)).toEqual(['a', 'b'])
    expect(memory.map((n) => n.id)).toEqual(['m1', 'm2'])
  })
})

// Ported from cinna-mobile src/notes/noteIndex.test.ts.
describe('tag chips and filter', () => {
  const rows = [
    { noteId: 'n1', key: 'inbox/to-read', display: 'Inbox/to-read' },
    { noteId: 'n2', key: 'inbox', display: 'inbox' },
    { noteId: 'n3', key: 'inbox/to-read/later', display: 'inbox/to-read/later' },
    { noteId: 'n3', key: 'bills', display: 'Bills' }
  ]

  it('offers every parent of a nested tag, counting distinct notes', () => {
    expect(tagFilterChips(rows)).toEqual([
      { key: 'bills', display: 'Bills', count: 1 },
      { key: 'inbox', display: 'inbox', count: 3 },
      { key: 'inbox/to-read', display: 'Inbox/to-read', count: 2 },
      { key: 'inbox/to-read/later', display: 'inbox/to-read/later', count: 1 }
    ])
  })

  it('derives a parent display from a nested tag when the parent is never used', () => {
    expect(tagFilterChips([{ noteId: 'n', key: 'work/q4', display: 'Work/Q4' }])[0]).toEqual({ key: 'work', display: 'Work', count: 1 })
  })

  it('filters a parent to its own and nested tags', () => {
    expect([...noteIdsForTag(rows, 'inbox')].sort()).toEqual(['n1', 'n2', 'n3'])
    expect([...noteIdsForTag(rows, 'inbox/to-read')].sort()).toEqual(['n1', 'n3'])
    expect([...noteIdsForTag(rows, 'in')]).toEqual([])
  })
})
