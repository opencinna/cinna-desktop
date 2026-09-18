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
