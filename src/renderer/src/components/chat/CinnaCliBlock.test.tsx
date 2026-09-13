vi.hoisted(() => { Object.assign(window, { api: { app: { setTheme: async () => {} } } }) })
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CinnaCliBlock } from './CinnaCliBlock'
import { AgentContribution } from './AgentContribution'
import { ToolCallBlock } from './ToolCallBlock'
import type { MessagePart } from '../../../../shared/messageParts'

const cliParts: MessagePart[] = [
  { kind: 'tool', toolId: 'cli', toolName: 'Bash', toolInput: { command: 'cinna account agents --all' }, text: 'Bash: cinna account agents --all' },
  { kind: 'tool_result', toolId: 'cli', toolStream: 'stdout', text: '```console\nAccessible agents (2)\n  Agent           Build\n  Invoice Agent   local\n```' }
]

describe('Cinna CLI blocks', () => {
  it('uses one disclosure and removes echoed narration and console fences', () => {
    render(<CinnaCliBlock command="cinna account agents --all" narration={cliParts[0].text} results={[cliParts[1]]} />)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getAllByText('cinna account agents --all')).toHaveLength(1)
    expect(screen.queryByRole('region')).toBeNull()
    fireEvent.click(screen.getByRole('button'))
    const output = screen.getByRole('region', { name: 'Cinna CLI output' })
    expect(output.textContent).not.toContain('```')
    expect(output.textContent).toContain('  Invoice Agent   local')
    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByRole('region')).toBeNull()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('region')).toBeTruthy()
  })

  it('keeps one block as output arrives and preserves errors and real narration', () => {
    const view = render(<CinnaCliBlock command="cinna agent push" isStreaming />)
    expect(screen.queryByText('Waiting for output…')).toBeNull()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('Waiting for output…')).toBeTruthy()
    view.rerender(<CinnaCliBlock command="cinna agent push" narration="Upload failed; check the account." results={[{ text: '```console\nPermission denied\n```', toolStream: 'stderr' }]} />)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByText('stderr')).toBeTruthy()
    expect(screen.getByText('Permission denied').className).toContain('--color-danger')
    expect(screen.getByText('Upload failed; check the account.')).toBeTruthy()
    expect(screen.queryByText('Waiting for output…')).toBeNull()
  })

  it.each([false, true])('joins nested agent results in verbose=%s', (verbose) => {
    render(<AgentContribution parts={cliParts} verbose={verbose} />)
    expect(screen.queryByRole('region')).toBeNull()
    if (!verbose) fireEvent.click(screen.getByRole('button', { name: /Expand 1 step/ }))
    fireEvent.click(screen.getByRole('button', { name: /Cinna CLI/ }))
    expect(screen.getByRole('region').textContent).toContain('Accessible agents (2)')
  })

  it('also renders ordinary local tool calls with their result', () => {
    render(<ToolCallBlock name="bash" input={{ command: 'cinna --help' }} result={'```console\nUsage: cinna\n```'} status="done" />)
    fireEvent.click(screen.getByRole('button', { name: /Cinna CLI/ }))
    expect(screen.getByText('Usage: cinna')).toBeTruthy()
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })
})
