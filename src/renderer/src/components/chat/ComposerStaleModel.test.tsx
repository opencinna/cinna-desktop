import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalAgentDto } from '../../../../shared/localAgents'

/**
 * The composer's row for a CLI agent whose declared model its runtime no
 * longer offers: a warning with the way to the agent's Runs with panel, never a
 * refusal (the turn runs on the runtime's default and the chat says so).
 */

;(window as unknown as { api: unknown }).api = {}

let catalog: unknown
let defaultRuntime: { engine: string } | undefined = { engine: 'opencode' }
const refreshWanted: [string | null, boolean][] = []
vi.mock('../../hooks/useEngine', async (importOriginal) => ({ ...(await importOriginal<object>()), useDefaultRuntime: () => ({ data: defaultRuntime }) }))
vi.mock('../../hooks/useRuntimeModelCatalog', () => ({
  useRuntimeModelCatalog: (engine: string | null) => ({ data: engine ? catalog : undefined }),
  useRuntimeModelCatalogRefresh: (engine: string | null, wanted: boolean) => { refreshWanted.push([engine, wanted]); return {} }
}))

const { staleModelNotice, useStaleModelNotice } = await import('./ComposerReadiness')
const { ComposerNoticePanel } = await import('./ComposerNoticePanel')
const { useUIStore } = await import('../../stores/ui.store')

const CLAUDE = {
  engine: 'claude', source: 'session', updatedAt: 1,
  models: [{ id: 'opus', name: 'Opus 5.5' }, { id: 'haiku', name: 'Haiku 4.5' }]
} as never
const folder = (runtime: Record<string, string> | null): LocalAgentDto =>
  ({ id: 'folder:a', name: 'Agent', runtime } as unknown as LocalAgentDto)

beforeEach(() => {
  catalog = undefined
  defaultRuntime = { engine: 'opencode' }
  refreshWanted.length = 0
})
afterEach(cleanup)

describe('staleModelNotice', () => {
  it('warns about a model the runtime’s list lacks, and opens the agent’s Runs with panel', () => {
    // Mutation: return null from `staleModelNotice` and the composer says nothing while every turn runs elsewhere.
    const notice = staleModelNotice(folder({ engine: 'claude', model: 'claude-opus-4-1' }), 'claude', CLAUDE)
    render(<ComposerNoticePanel notices={notice ? [notice] : []} />)
    expect(screen.getByText('This agent’s model “claude-opus-4-1” is no longer offered by Claude Code.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Choose model' }))
    const ui = useUIStore.getState()
    expect(ui.activeLocalAgentId).toBe('folder:a')
    expect(ui.agentPageMode).toBe('settings')
    expect(ui.activeView).toBe('local-agent')
    // The panel focuses its Model select once it shows it.
    expect(ui.pendingRuntimeModelFocusId).toBe('folder:a')
  })

  it('says nothing for an offered model (aliases included), an unknown list, no model or no CLI engine', () => {
    expect(staleModelNotice(folder({ engine: 'claude', model: 'opus' }), 'claude', CLAUDE)).toBeNull()
    expect(staleModelNotice(folder({ engine: 'claude', model: 'claude-haiku-4-5' }), 'claude', CLAUDE)).toBeNull()
    expect(staleModelNotice(folder({ engine: 'claude', model: 'gone' }), 'claude', undefined)).toBeNull()
    expect(staleModelNotice(folder({ engine: 'claude', model: 'gone' }), 'claude',
      { engine: 'claude', models: [], source: 'unavailable', updatedAt: null })).toBeNull()
    expect(staleModelNotice(folder({ engine: 'claude' }), 'claude', CLAUDE)).toBeNull()
    expect(staleModelNotice(folder({ model: 'gone' }), null, CLAUDE)).toBeNull()
  })
})

describe('useStaleModelNotice', () => {
  it('reads the agent’s own CLI runtime, and asks for a list only when it names a model and none is known', () => {
    catalog = { engine: 'codex', models: [], source: 'unavailable', updatedAt: null }
    const { result, rerender } = renderHook(({ agent }) => useStaleModelNotice(agent), {
      initialProps: { agent: folder({ engine: 'codex', model: 'gpt-4' }) }
    })
    expect(result.current).toBeNull()
    expect(refreshWanted.at(-1)).toEqual(['codex', true])
    catalog = { engine: 'codex', source: 'session', updatedAt: 1, models: [{ id: 'gpt-6-luna', name: 'GPT-6-Luna' }] }
    rerender({ agent: folder({ engine: 'codex', model: 'gpt-4' }) })
    expect(result.current?.text).toBe('This agent’s model “gpt-4” is no longer offered by Codex.')
    expect(refreshWanted.at(-1)).toEqual(['codex', false])
    // An OpenCode agent (a model with no engine names a credential's catalogue) is not this row's.
    rerender({ agent: folder({ model: 'gpt-4' }) })
    expect(result.current).toBeNull()
    expect(refreshWanted.at(-1)).toEqual([null, false])
  })
})
