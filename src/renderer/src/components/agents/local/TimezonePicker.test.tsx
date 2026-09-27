import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { TimezonePicker, matchesTimezone, timezoneOptions } from './TimezonePicker'

function Harness({ initial = 'Europe/Berlin', onPick = vi.fn() }: { initial?: string; onPick?: (zone: string) => void }) {
  const [zone, setZone] = useState(initial)
  return <>
    <span id="tz-label">Timezone</span>
    <TimezonePicker value={zone} labelledBy="tz-label" className="" onChange={(next) => { setZone(next); onPick(next) }} />
  </>
}
const options = () => within(screen.getByRole('listbox', { name: 'Timezones' })).queryAllByRole('option').map((option) => option.textContent)
const search = () => screen.getByRole('textbox', { name: 'Search timezones' })

describe('TimezonePicker', () => {
  it('is named by its label and shows the zone with its current offset', () => {
    render(<Harness initial="Asia/Tokyo" />)
    const trigger = screen.getByRole('button', { name: 'Timezone' })
    expect(trigger.textContent).toBe('Asia/Tokyo · GMT+9')
  })

  it('filters by city, by a name written with spaces or underscores, and by offset', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Timezone' }))
    expect(document.activeElement).toBe(search())
    fireEvent.change(search(), { target: { value: 'berlin' } })
    expect(options()).toEqual([expect.stringMatching(/^Europe\/Berlin/)])
    fireEvent.change(search(), { target: { value: 'new york' } })
    expect(options()).toEqual([expect.stringMatching(/^America\/New York/)])
    fireEvent.change(search(), { target: { value: 'New_York' } })
    expect(options()).toEqual([expect.stringMatching(/^America\/New York/)])
    fireEvent.change(search(), { target: { value: 'gmt+9' } })
    expect(options()).toContain('Asia/TokyoGMT+9')
    fireEvent.change(search(), { target: { value: 'nowhere at all' } })
    expect(options()).toEqual([])
    expect(screen.getByText('No matching timezones')).toBeTruthy()
  })

  it('marks the current zone and picks another with the keyboard, returning focus to the trigger', () => {
    const onPick = vi.fn()
    render(<Harness onPick={onPick} />)
    fireEvent.click(screen.getByRole('button', { name: 'Timezone' }))
    expect(screen.getByRole('option', { selected: true }).textContent).toMatch(/^Europe\/Berlin/)
    fireEvent.change(search(), { target: { value: 'tokyo' } })
    fireEvent.keyDown(search(), { key: 'ArrowDown' })
    fireEvent.keyDown(search(), { key: 'ArrowUp' })
    expect(search().getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: /Tokyo/ }).id)
    fireEvent.keyDown(search(), { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith('Asia/Tokyo')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Timezone' }))
    expect(screen.getByRole('button', { name: 'Timezone' }).textContent).toBe('Asia/Tokyo · GMT+9')
  })

  it('closes on Escape and cancels the keydown, so an enclosing dialog does not close', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Timezone' }))
    const notPrevented = fireEvent.keyDown(search(), { key: 'Escape' })
    expect(notPrevented).toBe(false)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Timezone' }))
  })

  it('keeps a stored zone this runtime does not list', () => {
    expect(timezoneOptions('Mars/Olympus_Mons')).toContain('Mars/Olympus_Mons')
    expect(timezoneOptions('Europe/Berlin')).toContain('UTC')
    render(<Harness initial="Mars/Olympus_Mons" />)
    expect(screen.getByRole('button', { name: 'Timezone' }).textContent).toBe('Mars/Olympus Mons')
    fireEvent.click(screen.getByRole('button', { name: 'Timezone' }))
    expect(screen.getByRole('option', { selected: true }).textContent).toBe('Mars/Olympus Mons')
  })

  it('matches without a query', () => {
    expect(matchesTimezone('Europe/Berlin', 'GMT+2', '  ')).toBe(true)
  })
})
