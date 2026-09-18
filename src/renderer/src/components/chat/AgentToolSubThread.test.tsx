import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { AgentToolSubThread } from './AgentToolSubThread'
import { PermissionRequestBlock } from './PermissionRequestBlock'
import { isPermissionRequestTool, parsePermissionRequest } from '../../../../shared/localAgentRequests'
import type { MessagePart } from '../../../../shared/messageParts'

const permission: MessagePart = { kind: 'tool', text: 'Permission requested', toolName: 'cinna_permission_request', toolId: 'per_nested', toolInput: { action: 'bash', resources: ['pwd'], savable: [] } }

beforeEach(() => {
  Object.assign(window, { api: { agents: { replyUncertainty: vi.fn().mockResolvedValue(null) } } })
})

describe('specialist sub-thread controls', () => {
  it('renders a live permission as an answerable block instead of tool narration', () => {
    const answer = vi.fn().mockResolvedValue({})
    render(<AgentToolSubThread agentName="Researcher" parts={[permission]} status="pending" isStreaming
      renderRequest={(part, decision) => isPermissionRequestTool(part.toolName)
        ? <PermissionRequestBlock request={parsePermissionRequest(part.toolInput)!} requestId={part.toolId} interactive decision={decision} onAnswer={answer} />
        : null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(answer).toHaveBeenCalledWith('per_nested', 'once')
  })

  it('stops only the selected specialist and keeps a refused stop retryable', async () => {
    const stop = vi.fn().mockRejectedValue(new Error("Error invoking remote method 'agent:cancel-message': Error: Could not stop"))
    render(<AgentToolSubThread agentName="Researcher" parts={[]} status="pending" isStreaming onStop={stop} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop Researcher' }))
    expect(stop).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Could not stop')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Stop Researcher' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps completed specialist turns read-only', () => {
    render(<AgentToolSubThread agentName="Researcher" parts={[]} status="done" onStop={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Stop Researcher' })).toBeNull()
  })
})

describe('sub-thread header and failure', () => {
  const grid = (container: HTMLElement): HTMLElement => container.querySelector('.grid') as HTMLElement

  it('does not collapse a thread that ended in an error, and marks it in compact mode', () => {
    // Mutation: collapse on every end → 0fr; drop the compact marker → no "error" in the header.
    const { container, rerender } = render(<AgentToolSubThread agentName="check pg" parts={[]} status="pending" isStreaming />)
    expect(grid(container).style.gridTemplateRows).toBe('1fr')
    rerender(<AgentToolSubThread agentName="check pg" parts={[]} status="error" errorText="Subagent failed" />)
    expect(grid(container).style.gridTemplateRows).toBe('1fr')
    expect(screen.getByRole('button', { name: /check pg/ }).textContent).toContain('error')
  })

  it('opens a saved failed thread, and keeps a finished one closed in compact mode', () => {
    const failed = render(<AgentToolSubThread agentName="a" parts={[]} status="error" errorText="boom" />)
    expect(grid(failed.container).style.gridTemplateRows).toBe('1fr')
    failed.unmount()
    const done = render(<AgentToolSubThread agentName="a" parts={[]} status="done" />)
    expect(grid(done.container).style.gridTemplateRows).toBe('0fr')
    expect(screen.getByRole('button', { name: /a/ }).textContent).not.toContain('done')
  })

  it('counts calls and what the agent said as steps, not the calls’ outputs', () => {
    // Mutation: `steps = parts.length` → "4 steps".
    const parts: MessagePart[] = [
      { kind: 'thinking', text: 'hmm' },
      { kind: 'tool', text: 'Bash: ls', toolName: 'Bash', toolId: 'b1' },
      { kind: 'tool_result', text: 'a.txt', toolId: 'b1', toolStream: 'stdout' },
      { kind: 'text', text: 'Done.' }
    ]
    render(<AgentToolSubThread agentName="a" parts={parts} status="done" verbose />)
    expect(screen.getByText('3 steps')).toBeTruthy()
  })
})

describe('sub-thread header while an ask holds it open', () => {
  const grid = (container: HTMLElement): HTMLElement => container.querySelector('.grid') as HTMLElement
  const header = (): HTMLElement => screen.getByRole('button', { name: /check pg/ })

  it('ignores a collapse click and does not replay it once the ask is answered', () => {
    // Mutation: store the click while held → the thread snaps shut when `holdOpen` drops.
    const { container, rerender } = render(<AgentToolSubThread agentName="check pg" parts={[permission]} status="pending" isStreaming holdOpen />)
    expect(header().getAttribute('aria-disabled')).toBe('true')
    expect(header().getAttribute('title')).toBe('Answer the request first')
    fireEvent.click(header())
    rerender(<AgentToolSubThread agentName="check pg" parts={[permission]} status="pending" isStreaming />)
    expect(grid(container).style.gridTemplateRows).toBe('1fr')
    expect(header().getAttribute('aria-disabled')).toBeNull()
    expect(header().getAttribute('title')).toBeNull()
  })

  it('says whether it is open', () => {
    // Mutation: drop `aria-expanded` → null.
    render(<AgentToolSubThread agentName="check pg" parts={[]} status="done" />)
    expect(header().getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(header())
    expect(header().getAttribute('aria-expanded')).toBe('true')
  })

  it('leaves asks and their decisions out of the step count', () => {
    // Mutation: count every `tool` part → "4 steps".
    const parts: MessagePart[] = [
      { kind: 'tool', text: 'Bash: ls', toolName: 'Bash', toolId: 'b1' },
      permission,
      { kind: 'tool_result', text: 'Allowed once', toolId: 'per_nested', toolStream: 'stdout' },
      { kind: 'tool', text: 'Asked a question.', toolName: 'askuserquestion', toolId: 'que_1', toolInput: { questions: [] } },
      { kind: 'text', text: 'Done.' }
    ]
    render(<AgentToolSubThread agentName="check pg" parts={parts} status="done" verbose />)
    expect(screen.getByText('2 steps')).toBeTruthy()
  })

  it('draws the prompt on the ask line before the first part arrives, where it stays', () => {
    // Mutation: a "Working on: …" line of its own → the prompt shifts sideways when work arrives.
    const { rerender } = render(<AgentToolSubThread agentName="check pg" parts={[]} askMessage="Confirm pg" status="pending" isStreaming />)
    const before = screen.getByTestId('agent-ask')
    expect(before.textContent).toBe('Confirm pg')
    expect(screen.getByText('Working…')).toBeTruthy()
    rerender(<AgentToolSubThread agentName="check pg" parts={[{ kind: 'text', text: 'On it.' }]} askMessage="Confirm pg" status="pending" isStreaming />)
    const after = screen.getByTestId('agent-ask')
    expect(after.textContent).toBe('Confirm pg')
    expect(after.parentElement!.parentElement!.className).toBe(before.parentElement!.parentElement!.className)
    expect(screen.queryByText('Working…')).toBeNull()
  })
})
