import { act, render, screen, waitFor } from '@testing-library/react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HourCycle } from '../../../shared/hourCycle'
import { remarkNoteFormat } from '../utils/noteFormat/remarkNoteFormat'
import { setClockLocale } from '../utils/noteFormat/tasks'
import { resetHourCycleForTests, useHourCycle } from './useHourCycle'

let os: HourCycle | null
let getHourCycle: ReturnType<typeof vi.fn>

/** A read view the way NoteDetail builds it: the plugin options carry the hook's value. */
function Chips(): React.JSX.Element {
  const hourCycle = useHourCycle()
  return (
    <div className="markdown-body">
      <Markdown remarkPlugins={[remarkGfm, [remarkNoteFormat, { hourCycle, today: '2026-11-16', timeZone: 'UTC' }]]}>
        {'- [ ] standup due:2026-11-16T15:00'}
      </Markdown>
    </div>
  )
}

const chip = (): string => (document.querySelector('[data-note-due]')?.textContent ?? '').replace(/\s/g, ' ')

beforeEach(() => {
  os = null
  resetHourCycleForTests()
  setClockLocale('en-US')
  getHourCycle = vi.fn(async () => os)
  vi.stubGlobal('window', Object.assign(window, { api: { system: { getHourCycle } } }))
})

afterEach(() => {
  setClockLocale(undefined)
  vi.unstubAllGlobals()
})

describe('useHourCycle', () => {
  it('applies the OS override read at mount', async () => {
    os = 'h23'
    render(<Chips />)
    await waitFor(() => expect(chip()).toBe('Today 15:00'))
    expect(getHourCycle).toHaveBeenCalledTimes(1)
  })

  it('re-reads on window focus and re-renders the visible chips', async () => {
    render(<Chips />)
    await waitFor(() => expect(getHourCycle).toHaveBeenCalledTimes(1))
    expect(chip()).toBe('Today 3:00 PM')

    os = 'h23'
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(chip()).toBe('Today 15:00'))

    os = null
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(chip()).toBe('Today 3:00 PM'))
    expect(getHourCycle).toHaveBeenCalledTimes(3)
  })

  it('stops listening for focus once nothing shows a time', async () => {
    const { unmount } = render(<Chips />)
    await waitFor(() => expect(getHourCycle).toHaveBeenCalledTimes(1))
    unmount()
    window.dispatchEvent(new Event('focus'))
    expect(getHourCycle).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/Today/)).toBeNull()
  })
})
