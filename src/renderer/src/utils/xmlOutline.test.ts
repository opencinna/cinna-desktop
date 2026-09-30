import { describe, expect, it } from 'vitest'
import { parseXml } from './xmlDocument'
import { OUTLINE_PER_PARENT, xmlOutline } from './xmlOutline'

const outline = (text: string) => xmlOutline(parseXml(text))

describe('xmlOutline', () => {
  it('lists elements that hold elements to depth 4 not counting the root, in document order', () => {
    const toc = outline('<r><a><b><c><d><e><x/></e></d></c></b></a><f><g/></f></r>')
    expect(toc.entries.map((e) => [e.text, e.depth])).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
      ['d', 4],
      ['f', 1]
    ])
    expect(toc.show).toBe(true)
  })

  it('uses element ids that the tree rows carry, root first', () => {
    const doc = parseXml('<r><a><x/></a><b><x/></b></r>')!
    expect(xmlOutline(doc).entries.map((e) => e.line)).toEqual([1, 3])
    expect(doc.elements[1].name).toBe('a')
    expect(doc.elements[3].name).toBe('b')
  })

  it('names an entry by id, name, key or title, in that order, else a short name/title child', () => {
    const toc = outline(
      [
        '<r xmlns:ns="urn:ns">',
        '<item title="T" name="N" id="I"><v/></item>',
        '<item title="T" key="K"><v/></item>',
        '<item title="T"><v/></item>',
        '<item><name>  Quarterly   report </name></item>',
        '<item><title>Only title</title></item>',
        `<item><name>${'x'.repeat(100)}</name></item>`,
        `<item id="${'y'.repeat(100)}"><v/></item>`,
        '<ns:item><v/></ns:item>',
        '</r>'
      ].join('')
    )
    const labels = toc.entries.filter((e) => e.depth === 1).map((e) => e.text)
    expect(labels.slice(0, 5)).toEqual(['item · I', 'item · K', 'item · T', 'item · Quarterly report', 'item · Only title'])
    // A long name is not "short": no label from it.
    expect(labels[5]).toBe('item')
    // A long attribute value is cut.
    expect(labels[6].length).toBe(60)
    expect(labels[6].endsWith('…')).toBe(true)
    expect(labels[7]).toBe('ns:item')
  })

  it('lists 50 children per parent, then a note for the rest', () => {
    const items = Array.from({ length: OUTLINE_PER_PARENT + 7 }, (_, i) => `<row id="${i}"><c/></row>`).join('')
    const toc = outline(`<r>${items}</r>`)
    expect(toc.entries).toHaveLength(OUTLINE_PER_PARENT + 1)
    const last = toc.entries[toc.entries.length - 1]
    expect(last).toMatchObject({ text: '… 7 more', noteTag: 'row', note: true, depth: 1 })
    expect(last.line).toBeLessThan(0)

    const mixed = Array.from({ length: OUTLINE_PER_PARENT }, () => '<a><x/></a>').join('') + '<a><x/></a><b><x/></b>'
    const note = outline(`<r>${mixed}</r>`).entries.at(-1)
    expect(note?.text).toBe('… 2 more')
    expect(note?.noteTag).toBeUndefined()
  })

  it('puts a nested note after its siblings subtrees, at their depth', () => {
    const inner = Array.from({ length: OUTLINE_PER_PARENT + 1 }, () => '<c><x/></c>').join('')
    const toc = outline(`<r><p>${inner}</p><q><x/></q></r>`)
    expect(toc.entries.at(-2)).toMatchObject({ text: '… 1 more', noteTag: 'c', depth: 2, note: true })
    expect(toc.entries.at(-1)).toMatchObject({ text: 'q', depth: 1 })
  })

  it('is shown only with at least two clickable entries', () => {
    expect(outline('<r><a><x/></a></r>').show).toBe(false)
    expect(outline('<r/>').show).toBe(false)
    expect(outline('<r><a><x/></a><b><x/></b></r>').show).toBe(true)
    // Leaves only: nothing to list, however many.
    expect(outline('<r><a/><b/><c>text</c></r>').show).toBe(false)
  })

  it('leaves out elements that hold only text or nothing — content, not sections', () => {
    const toc = outline(
      '<catalog><book id="1"><title>A</title><price>3</price></book><book id="2"><title>B</title></book>' +
        '<note>text only</note><empty id="z"/><shelf><book id="3"><name>C</name></book><price>9</price></shelf></catalog>'
    )
    expect(toc.entries.map((e) => [e.text, e.depth])).toEqual([
      ['book · 1', 1],
      ['book · 2', 1],
      ['shelf', 1],
      ['book · 3', 2]
    ])
    // The cap counts sections only: 60 leaves beside 2 sections leave no note.
    const leaves = Array.from({ length: 60 }, () => '<v>1</v>').join('')
    expect(outline(`<r>${leaves}<a><x/></a><b><x/></b></r>`).entries.map((e) => e.text)).toEqual(['a', 'b'])
  })

  it('is empty for malformed or truncated XML', () => {
    expect(parseXml('<r><a>')).toBeNull()
    expect(parseXml('not xml')).toBeNull()
    expect(outline('<r><a></r>')).toEqual({ entries: [], show: false })
  })
})
