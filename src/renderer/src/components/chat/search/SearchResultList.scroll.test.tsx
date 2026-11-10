import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SearchResultList, type RailEntry } from './SearchResultList'

/**
 * The results list opens at its bottom, nearest the bar, and stays where the
 * user scrolled it until the results themselves change. The parents build
 * `entries` afresh on every render, so a re-render alone must not move it.
 */

const ids = ['a', 'b', 'c', 'd']

function List({ entries, resultsKey }: { entries: readonly RailEntry[]; resultsKey: string }): React.JSX.Element {
  return (
    <SearchResultList id="results" label="Search results" entries={entries} resultsKey={resultsKey} activeId={undefined} onActivate={() => {}}>
      {entries.map((entry) => (
        <div key={entry.id} id={entry.id} role="option" aria-selected={false} />
      ))}
    </SearchResultList>
  )
}

const freshEntries = (): RailEntry[] => ids.map((id) => ({ id, group: 'chat' }))

/** jsdom has no layout: give the list a scroll height so "the bottom" means something. */
function withScrollHeight(list: HTMLElement): HTMLElement {
  Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 1000 })
  return list
}

describe('SearchResultList scrolling', () => {
  it('keeps the user’s scroll position when the parent re-renders with the same results', () => {
    const { rerender, getByRole } = render(<List entries={freshEntries()} resultsKey="q|a,b,c,d" />)
    const list = withScrollHeight(getByRole('listbox'))
    // The user scrolls up to older results.
    list.scrollTop = 120
    // The parent re-renders (a stream tick, a store change) with an equal but new array.
    rerender(<List entries={freshEntries()} resultsKey="q|a,b,c,d" />)
    expect(getByRole('listbox').scrollTop).toBe(120)
  })

  it('goes to the bottom when the results change', () => {
    const { rerender, getByRole } = render(<List entries={freshEntries()} resultsKey="q|a,b,c,d" />)
    // The list is keyed on the results, so the next one is a new element: give every element a height.
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 800 })
    try {
      rerender(<List entries={freshEntries()} resultsKey="qu|a,b,c" />)
      expect(getByRole('listbox').scrollTop).toBe(800)
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', original)
    }
  })
})
