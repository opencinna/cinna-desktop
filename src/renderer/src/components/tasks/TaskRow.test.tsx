import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskDto } from '../../../../shared/tasks'

;(window as unknown as { api: unknown }).api = { app: { setTheme: async () => undefined } }
const { TaskRow } = await import('./TaskRow')

/**
 * A row's live dot and the bound chat's name. The dot is there for every task
 * with a chat and only hidden while the chat is idle, so a poll that flips it
 * moves nothing; it is decorative, and the row's name says ", running" instead.
 */

type RowTask = Parameters<typeof TaskRow>[0]['task']

const BASE: RowTask = {
  id: 't1',
  title: 'Check the invoices',
  status: 'in_progress',
  updatedAt: new Date()
}

function chat(running: boolean, title = 'August invoices'): Pick<TaskDto, 'chat'> {
  return { chat: { id: 'c1', title, running } }
}

function dot(): HTMLElement | null {
  return document.querySelector('[data-task-live-dot]')
}

afterEach(cleanup)

describe('the live dot', () => {
  it('is visible while a turn is live in the chat, and the name says so', () => {
    render(<TaskRow task={{ ...BASE, ...chat(true) }} />)
    expect(dot()?.className).toContain(' visible')
    expect(dot()?.className).not.toContain('invisible')
    expect(dot()?.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByRole('button', { name: 'Check the invoices — In progress, in August invoices, running' })).toBeTruthy()
  })

  it('pulses and names the chat on hover while running, like the app’s other live dot', () => {
    render(<TaskRow task={{ ...BASE, ...chat(true) }} />)
    expect(dot()?.className).toContain('motion-safe:animate-pulse')
    expect(dot()?.getAttribute('title')).toBe('Running in August invoices')
  })

  it('keeps its slot but is invisible, still and untitled while the chat is idle', () => {
    render(<TaskRow task={{ ...BASE, ...chat(false) }} />)
    expect(dot()?.className).toContain('invisible')
    expect(dot()?.className).not.toContain('animate-pulse')
    expect(dot()?.getAttribute('title')).toBeNull()
    expect(screen.getByRole('button', { name: 'Check the invoices — In progress, in August invoices' })).toBeTruthy()
  })

  it('says New Chat on hover for a chat with no name', () => {
    render(<TaskRow task={{ ...BASE, ...chat(true, '  ') }} />)
    expect(dot()?.getAttribute('title')).toBe('Running in New Chat')
  })

  it('is not rendered with hideChat, and the name drops ", running": the row sits under that very chat', () => {
    render(<TaskRow task={{ ...BASE, ...chat(true) }} size="compact" hideChat />)
    expect(dot()).toBeNull()
    expect(screen.getByRole('button', { name: 'Check the invoices — In progress' })).toBeTruthy()
  })

  it('is shown on a compact row without hideChat — a subtask, running in a chat of its own', () => {
    render(<TaskRow task={{ ...BASE, ...chat(true) }} size="compact" />)
    expect(dot()?.className).toContain(' visible')
    expect(screen.getByRole('button', { name: 'Check the invoices — In progress, running' })).toBeTruthy()
  })

  it('is ringed in the page background, to part it from the icon it may sit on', () => {
    render(<TaskRow task={{ ...BASE, ...chat(true) }} />)
    expect(dot()?.className).toContain('ring-1')
    expect(dot()?.className).toContain('ring-[var(--color-bg)]')
  })

  it('is not rendered for a task without a chat', () => {
    render(<TaskRow task={{ ...BASE, chat: null }} />)
    expect(dot()).toBeNull()
    expect(screen.getByRole('button', { name: 'Check the invoices — In progress' })).toBeTruthy()
  })

  it('sits before the time, which stays last', () => {
    render(<TaskRow task={{ ...BASE, ...chat(true) }} />)
    const row = screen.getByRole('button')
    expect(row.lastElementChild?.previousElementSibling).toBe(dot())
  })
})

describe('the chat name', () => {
  it('follows the title on a regular row, with the full name as its tooltip', () => {
    render(<TaskRow task={{ ...BASE, ...chat(false) }} />)
    const name = screen.getByText('in August invoices')
    expect(name.getAttribute('title')).toBe('August invoices')
    expect(screen.getByRole('button').getAttribute('title')).toBeNull()
    expect(screen.getByText('Check the invoices').getAttribute('title')).toBe('Check the invoices')
  })

  it('gives way before the title: it shrinks first, down to nothing, under its 12 rem cap', () => {
    render(<TaskRow task={{ ...BASE, ...chat(false) }} />)
    const name = screen.getByText('in August invoices')
    expect(name.className).toContain('shrink-[9999]')
    expect(name.className).toContain('min-w-0')
    expect(name.className).toContain('max-w-[12rem]')
  })

  it('is left off a compact row, which has no room for it', () => {
    render(<TaskRow task={{ ...BASE, ...chat(false) }} size="compact" />)
    expect(screen.queryByText('in August invoices')).toBeNull()
    expect(screen.getByRole('button', { name: 'Check the invoices — In progress' })).toBeTruthy()
  })

  it.each([['blank', '   '], ['the default', 'New Chat']])('is dropped, from the row and its name, when the chat title is %s', (_, title) => {
    render(<TaskRow task={{ ...BASE, ...chat(true, title) }} />)
    expect(document.querySelector('[data-task-row-chat]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Check the invoices — In progress, running' })).toBeTruthy()
    expect(dot()).not.toBeNull()
  })

  it('is left off a task without a chat', () => {
    render(<TaskRow task={BASE} />)
    expect(document.querySelector('[data-task-row-chat]')).toBeNull()
  })
})
