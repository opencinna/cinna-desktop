import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DevelopmentRecheckButton } from './DevelopmentRecheckButton'

afterEach(() => vi.useRealTimers())

describe('development recheck feedback', () => {
  it('keeps an immediate result visibly checking for 600 ms and prevents duplicate clicks', async () => {
    vi.useFakeTimers()
    const check = vi.fn().mockResolvedValue({})
    render(<DevelopmentRecheckButton onCheck={check} />)
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(599) })
    const button = screen.getByRole('button', { name: 'Checking…' })
    expect(button).toHaveProperty('disabled', true)
    expect(button.querySelector('svg')?.classList.contains('animate-spin')).toBe(true)
    fireEvent.click(button)
    expect(check).toHaveBeenCalledOnce()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(screen.getByRole('button', { name: 'Check again' })).toHaveProperty('disabled', false)
  })
  it('keeps spinning for a slow check and reports failure before allowing retry', async () => {
    vi.useFakeTimers()
    let fail!: (error: Error) => void
    render(<DevelopmentRecheckButton onCheck={() => new Promise((_resolve, reject) => { fail = reject })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(screen.getByRole('button', { name: 'Checking…' })).toHaveProperty('disabled', true)
    await act(async () => { fail(new Error('Network unavailable')); await vi.advanceTimersByTimeAsync(1) })
    expect(screen.getByRole('alert').textContent).toBe('Network unavailable')
    expect(screen.getByRole('button', { name: 'Check again' })).toHaveProperty('disabled', false)
  })
})
