import { render, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { AGENT_COLOR_PRESETS } from '../../../shared/agentColors'
import { AgentTypeIcon } from '../components/agents/AgentTypeIcon'
import { WhoIcon } from '../components/chat/ChatItemTooltip'
import {
  agentInk,
  AgentColorsContext,
  agentColorMap,
  chipColorsFor,
  presetForAgentId,
  useAgentColor,
  useChosenAgentColor
} from './agentColors'

const chosen = agentColorMap([
  { agentId: 'folder:writer', preset: 'teal' },
  // A retired id is dropped, not drawn.
  { agentId: 'folder:old', preset: 'chartreuse' }
])
const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
  <AgentColorsContext.Provider value={chosen}>{children}</AgentColorsContext.Provider>
)

describe('agent colors', () => {
  it('lists fifteen presets with distinct ids', () => {
    expect(AGENT_COLOR_PRESETS).toHaveLength(15)
    expect(new Set(AGENT_COLOR_PRESETS.map((p) => p.id)).size).toBe(15)
  })

  it('derives a chip from a preset: the color, and a 10% tint of it', () => {
    expect(chipColorsFor('#44AFB0')).toEqual({ border: agentInk('#44AFB0'), bg: 'rgba(68,175,176,0.10)' })
  })

  it('gives a chip the chosen color, else the hash color', () => {
    const { result } = renderHook(() => useAgentColor(), { wrapper })
    expect(result.current('folder:writer')).toEqual(chipColorsFor('#44AFB0'))
    expect(result.current('folder:other')).toEqual(presetForAgentId('folder:other'))
    expect(result.current('folder:old')).toEqual(presetForAgentId('folder:old'))
  })

  it('has a chosen color only for an agent the user gave one', () => {
    const { result } = renderHook(() => useChosenAgentColor(), { wrapper })
    expect(result.current('folder:writer')).toBe(agentInk('#44AFB0', 'glyph'))
    expect(result.current('folder:other')).toBeNull()
    expect(result.current(undefined)).toBeNull()
  })

  it('draws a fill (the chat-row dot) in the swatch hex, not the darkened ink', () => {
    const { result } = renderHook(() => useChosenAgentColor('fill'), { wrapper })
    expect(result.current('folder:writer')).toBe('#44AFB0')
    expect(result.current('folder:other')).toBeNull()
  })

  it('falls back to the hash color outside the provider', () => {
    const { result } = renderHook(() => useAgentColor())
    expect(result.current('folder:writer')).toEqual(presetForAgentId('folder:writer'))
  })

  it('tints an agent icon in its chosen color, and leaves it muted with None', () => {
    const { container, rerender } = render(<AgentTypeIcon agent={{ source: 'folder' }} />)
    const icon = (): HTMLElement => container.firstElementChild as HTMLElement
    expect(icon().className).toContain('text-[var(--color-text-muted)]')
    expect(icon().style.color).toBe('')
    rerender(<AgentTypeIcon agent={{ source: 'folder' }} color="#44AFB0" />)
    expect(icon().className).not.toContain('text-[var(--color-text-muted)]')
    expect(icon().style.color).toBe('rgb(68, 175, 176)')
  })

  it('tints a Chats group header for an agent with a chosen color', () => {
    const who = (agentId: string) => ({ kind: 'agent' as const, name: 'Writer', color: null, agentId, source: 'folder' })
    const { container, rerender } = render(<WhoIcon who={who('folder:writer')} />, { wrapper })
    expect((container.firstElementChild as HTMLElement).style.color).toBe(agentInk('#44AFB0', 'glyph'))
    rerender(<WhoIcon who={who('folder:other')} />)
    expect((container.firstElementChild as HTMLElement).style.color).toBe('')
  })
})
