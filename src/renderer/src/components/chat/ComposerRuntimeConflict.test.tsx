import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalAgentDto, LocalAgentRuntimeConflict } from '../../../../shared/localAgents'

/**
 * The composer's runtime-conflict row: the file and the app disagree about
 * what the agent runs on. One labelled action (the app's answer) and the
 * file's behind the chevron; never while a turn of the agent runs.
 */

const { runtimeConflictNotice, assembleNoticeRows } = await import('./ComposerReadiness')
const { runtimeConflictCopy, useRuntimeConflict } = await import('../agents/local/runtimeConflict')

const CHOICE: LocalAgentRuntimeConflict = {
  kind: 'choice',
  file: { engine: 'opencode', credentialName: 'Managed OpenAI', modelId: 'gpt-5.5-pro' },
  app: { engine: 'claude', credentialName: null, modelId: 'sonnet' }
}
const UNRECORDED: LocalAgentRuntimeConflict = { ...CHOICE, kind: 'unrecorded' }

function folder(conflict: LocalAgentRuntimeConflict | null): LocalAgentDto {
  return {
    id: 'folder:a', kind: 'kit', stamps: { 'cinna-agent.json': { size: 1, mtimeMs: 1, hash: 'h' } },
    resolvedRuntime: { engine: 'claude', credentialId: null, source: 'choice', choice: { kind: 'default' }, conflict }
  } as unknown as LocalAgentDto
}

let resolve: ReturnType<typeof vi.fn>
let sessions: { agentId: string; chatId: string; title: string | null }[] = []

beforeEach(() => {
  resolve = vi.fn().mockResolvedValue({ ok: true })
  sessions = []
  ;(window as unknown as { api: unknown }).api = {
    localAgents: { resolveRuntimeConflict: resolve },
    providers: { listModels: async () => [{ id: 'gpt-5.5-pro', name: 'GPT-5.5 Pro', providerId: 'p1' }] },
    agentSessions: { active: async () => ({ ok: true, sessions }), onChanged: () => () => {} },
    taskDispatch: { onChanged: () => () => {} },
    chat: { onTitleUpdated: () => () => {} },
    engine: { modelCatalog: async () => ({ engine: 'claude', models: [], source: 'unavailable', updatedAt: null }) }
  }
})
afterEach(cleanup)

function wrapper(): ({ children }: { children: ReactNode }) => React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }) => createElement(QueryClientProvider, { client }, children)
}

describe('runtimeConflictCopy', () => {
  it('names both sides with their models, and the two answers for each kind', () => {
    const name = (side: { modelId: string | null }): string | null => (side.modelId === 'gpt-5.5-pro' ? 'GPT-5.5 Pro' : side.modelId)
    const choice = runtimeConflictCopy(CHOICE, name)
    expect(choice.text).toBe('cinna-agent.json asks for OpenCode (GPT-5.5 Pro); this agent runs on Claude Agent (sonnet).')
    expect([choice.primary.label, choice.alternative.label]).toEqual(['Update file', 'Use OpenCode'])
    const unrecorded = runtimeConflictCopy(UNRECORDED, name)
    expect(unrecorded.text).toBe('cinna-agent.json pins OpenCode (GPT-5.5 Pro); your Default runtime is Claude Agent (sonnet).')
    expect([unrecorded.primary.action, unrecorded.alternative.action]).toEqual(['use_default', 'use_file'])
    expect([unrecorded.primary.label, unrecorded.alternative.label]).toEqual(['Use Default', 'Keep OpenCode'])
  })

  it('names the credentials when that is all that differs, and leaves out an unknown model', () => {
    const copy = runtimeConflictCopy({
      kind: 'choice',
      file: { engine: 'opencode', credentialName: 'Work OpenAI', modelId: null },
      app: { engine: 'opencode', credentialName: 'Home Anthropic', modelId: null }
    }, () => null)
    expect(copy.text).toBe('cinna-agent.json asks for OpenCode on Work OpenAI; this agent runs on OpenCode on Home Anthropic.')
  })
})

describe('the composer row', () => {
  it('shows the sentence with Update file, and Use OpenCode behind the chevron', async () => {
    const { result } = renderHook(() => useRuntimeConflict(folder(CHOICE)), { wrapper: wrapper() })
    await waitFor(() => expect(result.current?.copy.text).toContain('(GPT-5.5 Pro)'))
    const row = runtimeConflictNotice(result.current)
    expect(row?.key).toBe('runtime-conflict')
    render(createElement('div', null, row?.text, row?.action), { wrapper: wrapper() })
    fireEvent.click(screen.getByRole('button', { name: 'Update file' }))
    await waitFor(() => expect(resolve).toHaveBeenCalledWith({ agentId: 'folder:a', action: 'update_file', stamp: { size: 1, mtimeMs: 1, hash: 'h' } }))
    fireEvent.click(screen.getByRole('button', { name: 'More ways to settle the runtime' }))
    expect(screen.getByRole('menuitem', { name: 'Use OpenCode' })).toBeTruthy()
  })

  it('is not there while a turn of the agent runs — the composer’s own stream, or one main lists', async () => {
    const streaming = renderHook(() => useRuntimeConflict(folder(CHOICE), { turnRunning: true }), { wrapper: wrapper() })
    expect(runtimeConflictNotice(streaming.result.current)).toBeNull()
    sessions = [{ agentId: 'folder:a', chatId: 'c1', title: null }]
    const listed = renderHook(() => useRuntimeConflict(folder(CHOICE)), { wrapper: wrapper() })
    await waitFor(() => expect(listed.result.current?.running).toBe(true))
    expect(runtimeConflictNotice(listed.result.current)).toBeNull()
  })

  it('is not there without a conflict', () => {
    const { result } = renderHook(() => useRuntimeConflict(folder(null)), { wrapper: wrapper() })
    expect(result.current).toBeNull()
    expect(runtimeConflictNotice(result.current)).toBeNull()
  })

  it('sits with the AI-credential row in the panel’s order', () => {
    const row = (key: string) => ({ key, tone: 'warning', icon: () => null, text: key }) as never
    const rows = assembleNoticeRows({
      folder: null, readinessItem: null, readiness: null, reasonId: 'r', credentials: null,
      accounts: { rows: [], loaded: true, aiCredentialCovered: false }, skillCredentials: null,
      aiCredential: row('ai-credential'), runtimeConflict: row('runtime-conflict'), staleModel: row('stale-model'), findings: null
    })
    expect(rows.map((each) => each.key)).toEqual(['ai-credential', 'runtime-conflict', 'stale-model'])
  })
})
