import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChosenPeopleList, REMOVE_REPEAT_MS, type ChosenPerson } from './ShareDialogs'
import { SHARE_UI_TEXT } from '../../../../utils/shareText'

/**
 * The chosen list's removals: one click takes a row off, and the next row's
 * X arriving under the pointer does not take the second click of a double
 * click as a choice of its own.
 */

const PEOPLE: ChosenPerson[] = [
  { userId: 'u-ann', access: 'use', label: 'Ann <ann@x.test>' },
  { userId: 'u-bob', access: 'use', label: 'Bob <bob@x.test>' },
  { userId: 'u-cy', access: 'use', label: 'Cy <cy@x.test>' }
]

function Harness({ everyoneOn = false }: { everyoneOn?: boolean }): React.JSX.Element {
  const [people, setPeople] = useState(PEOPLE)
  const [everyone, setEveryone] = useState(everyoneOn)
  return (
    <ChosenPeopleList
      people={people}
      disabled={false}
      onChange={setPeople}
      everyone={{ on: everyone, onRemove: () => setEveryone(false) }}
    />
  )
}

/** Each row's title: a person's name, or Everyone. */
const names = (): string[] =>
  Array.from(document.querySelectorAll('[data-chosen-people] li')).map((row) => row.querySelector('[id]')?.textContent ?? '')
const remove = (name: string): HTMLElement => screen.getByRole('button', { name: SHARE_UI_TEXT.removeFromList(name) })

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('ChosenPeopleList removals', () => {
  it('ignores the second click of a double click on a person’s X, which lands on the next row’s X', () => {
    render(<Harness />)
    fireEvent.click(remove('Ann'))
    // The next row moved up: its X is where the pointer is, and the second click arrives.
    act(() => vi.advanceTimersByTime(120))
    fireEvent.click(remove('Bob'))
    expect(names()).toEqual(['Bob', 'Cy'])
    // Past the double click's window, a click is a choice again.
    act(() => vi.advanceTimersByTime(REMOVE_REPEAT_MS))
    fireEvent.click(remove('Bob'))
    expect(names()).toEqual(['Cy'])
  })

  it('ignores a second click that lands on the first person after Everyone’s X took its row away', () => {
    render(<Harness everyoneOn />)
    fireEvent.click(remove(SHARE_UI_TEXT.everyone))
    act(() => vi.advanceTimersByTime(150))
    fireEvent.click(remove('Ann'))
    expect(names()).toEqual(['Ann', 'Bob', 'Cy'])
  })
})
