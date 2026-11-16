import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A closed block does no work for the body it is not showing: a long chat
 * holds hundreds of closed tool outputs, some of them a megabyte.
 */

const unwrap = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../../utils/consoleOutput', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/consoleOutput')>()
  return {
    ...actual,
    unwrapConsoleOutput: (...args: Parameters<typeof actual.unwrapConsoleOutput>) => {
      unwrap.calls += 1
      return actual.unwrapConsoleOutput(...args)
    }
  }
})

const { ToolResultBlock } = await import('./ToolResultBlock')
const { CinnaCliBlock } = await import('./CinnaCliBlock')
const { ToolCallBlock } = await import('./ToolCallBlock')

beforeEach(() => {
  unwrap.calls = 0
})

describe('a closed tool output', () => {
  it('does not unwrap its output until opened', () => {
    // Mutation: build the <pre> as an eager child → unwrapped on every render while closed.
    const view = render(<ToolResultBlock content={'```console\nhuge\n```'} />)
    view.rerender(<ToolResultBlock content={'```console\nhuge\n```'} />)
    expect(unwrap.calls).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Output' }))
    expect(unwrap.calls).toBeGreaterThan(0)
    expect(screen.getByText('huge')).toBeTruthy()
  })

  it('a Cinna CLI block does not unwrap its output until opened', () => {
    render(<CinnaCliBlock command="cinna agents list" results={[{ text: 'one\ntwo' }]} />)
    expect(unwrap.calls).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: /Cinna CLI/ }))
    expect(unwrap.calls).toBe(1)
  })
})

describe('a closed tool call', () => {
  it('mounts its details on the first open and keeps them when closed again', () => {
    // Mutation: render the details whatever `expanded` says → the result is parsed and drawn while closed.
    const { container } = render(<ToolCallBlock name="search" input={{ q: 'x' }} result={'{"hits":3}'} status="done" />)
    expect(screen.queryByText('Method')).toBeNull()
    expect(screen.queryByText('hits:')).toBeNull()
    const header = container.querySelector('button') as HTMLButtonElement
    fireEvent.click(header)
    expect(screen.getByText('Method')).toBeTruthy()
    expect(screen.getByText('hits:')).toBeTruthy()
    fireEvent.click(header)
    expect((container.querySelector('.grid') as HTMLElement).style.gridTemplateRows).toBe('0fr')
    expect(screen.getByText('Method')).toBeTruthy()
  })
})
