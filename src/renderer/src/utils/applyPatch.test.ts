import { describe, it, expect } from 'vitest'
import { parsePatch } from './applyPatch'

describe('parsePatch', () => {
  it('returns null for non-patch input', () => {
    expect(parsePatch(undefined)).toBeNull()
    expect(parsePatch(42)).toBeNull()
    expect(parsePatch('just some text')).toBeNull()
    // Looks patch-ish (has `*** `) but yields no file sections.
    expect(parsePatch('*** Begin Patch\n*** End Patch')).toBeNull()
  })

  it('parses an Add File with only additions', () => {
    const files = parsePatch(
      '*** Begin Patch\n*** Add File: files/a.txt\n+hello\n+world\n*** End Patch'
    )
    expect(files).toHaveLength(1)
    const f = files![0]
    expect(f).toMatchObject({ op: 'add', path: 'files/a.txt', additions: 2, deletions: 0 })
    expect(f.lines).toEqual([
      { type: 'add', text: 'hello' },
      { type: 'add', text: 'world' }
    ])
  })

  it('parses an Update File with a hunk, context, add and delete', () => {
    const files = parsePatch(
      ['*** Begin Patch', '*** Update File: src/x.ts', '@@ class X', ' keep', '-old', '+new', '*** End Patch'].join(
        '\n'
      )
    )
    const f = files![0]
    expect(f).toMatchObject({ op: 'update', path: 'src/x.ts', additions: 1, deletions: 1 })
    expect(f.lines).toEqual([
      { type: 'hunk', text: 'class X' },
      { type: 'context', text: 'keep' },
      { type: 'del', text: 'old' },
      { type: 'add', text: 'new' }
    ])
  })

  it('captures a rename via Move to', () => {
    const files = parsePatch(
      '*** Begin Patch\n*** Update File: old/path.ts\n*** Move to: new/path.ts\n+x\n*** End Patch'
    )
    expect(files![0]).toMatchObject({ op: 'update', path: 'old/path.ts', moveTo: 'new/path.ts' })
  })

  it('parses a Delete File', () => {
    const files = parsePatch('*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch')
    expect(files![0]).toMatchObject({ op: 'delete', path: 'gone.txt' })
    expect(files![0].lines).toHaveLength(0)
  })

  it('handles multiple files and CRLF line endings', () => {
    const files = parsePatch(
      '*** Begin Patch\r\n*** Add File: a.txt\r\n+1\r\n*** Delete File: b.txt\r\n*** End Patch'
    )
    expect(files).toHaveLength(2)
    expect(files![0]).toMatchObject({ op: 'add', path: 'a.txt' })
    expect(files![1]).toMatchObject({ op: 'delete', path: 'b.txt' })
  })
})
