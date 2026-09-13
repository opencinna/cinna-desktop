import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ToolResultBlock } from './ToolResultBlock'

describe('Tool output presentation', () => {
  it('unwraps console output independently of command recognition and keeps table whitespace', () => {
    const table = '  ┌───────┐\n  │ Agent │\n  └───────┘'
    const { container } = render(<ToolResultBlock content={'``` console\n' + table + '\n```'} />)
    expect(container.querySelector('pre')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Output' }))
    expect(container.querySelector('pre')?.textContent).toBe(table)
  })

  it('handles streamed wrappers and preserves literal fenced sections in ordinary output', () => {
    const { container, rerender } = render(<ToolResultBlock content={'```console\npartial'} isStreaming toolStream="stderr" />)
    expect(container.querySelector('pre')?.textContent).toBe('partial')
    rerender(<ToolResultBlock content={'```console\npartial\n```'} toolStream="stderr" />)
    expect(container.querySelector('pre')?.textContent).toBe('partial')
    const literal = 'File contents:\n```console\nexample\n```'
    rerender(<ToolResultBlock content={literal} toolStream="stderr" />)
    expect(container.querySelector('pre')?.textContent).toBe(literal)
  })
})
