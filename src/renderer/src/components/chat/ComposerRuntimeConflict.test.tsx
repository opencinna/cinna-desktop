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

const { runtimeConflictNotice, assembleNoticeRows, useRuntimeConflictRow } = await import('./ComposerReadiness')
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
    expect(choice.text).toBe('File asks for OpenCode (GPT-5.5 Pro); runs on Claude Agent (sonnet).')
    expect(choice.sentence).toBe('cinna-agent.json asks for OpenCode (GPT-5.5 Pro); this agent runs on Claude Agent (sonnet).')
    expect([choice.primary.label, choice.alternative.label]).toEqual(['Update file', 'Use OpenCode'])
    const unrecorded = runtimeConflictCopy(UNRECORDED, name)
    expect(unrecorded.text).toBe('File pins OpenCode (GPT-5.5 Pro); Default runtime is Claude Agent (sonnet).')
    expect(unrecorded.sentence).toBe('cinna-agent.json pins OpenCode (GPT-5.5 Pro); your Default runtime is Claude Agent (sonnet).')
    expect([unrecorded.primary.action, unrecorded.alternative.action]).toEqual(['use_default', 'use_file'])
    expect([unrecorded.primary.label, unrecorded.alternative.label]).toEqual(['Use Default', 'Keep OpenCode'])
  })

  it('names the credentials when that is all that differs, and leaves out an unknown model', () => {
    const copy = runtimeConflictCopy({
      kind: 'choice',
      file: { engine: 'opencode', credentialName: 'Work OpenAI', modelId: null },
      app: { engine: 'opencode', credentialName: 'Home Anthropic', modelId: null }
    }, () => null)
    expect(copy.text).toBe('File asks for OpenCode on Work OpenAI; runs on OpenCode on Home Anthropic.')
    expect(copy.sentence).toBe('cinna-agent.json asks for OpenCode on Work OpenAI; this agent runs on OpenCode on Home Anthropic.')
  })

  it('says a same-engine side has no AI credential rather than naming no difference', () => {
    const copy = runtimeConflictCopy({
      kind: 'unrecorded',
      file: { engine: 'opencode', credentialName: 'Work OpenAI', modelId: null },
      app: { engine: 'opencode', credentialName: null, modelId: null }
    }, () => null)
    expect(copy.text).toBe('File pins OpenCode on Work OpenAI; Default runtime is OpenCode with no AI credential.')
    // Across engines a missing credential is not the difference, so it is not said.
    const across = runtimeConflictCopy({ ...CHOICE, file: { ...CHOICE.file, credentialName: null } }, () => null)
    expect(across.text).toBe('File asks for OpenCode; runs on Claude Agent.')
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

  it('says the short form on one line, with the whole sentence as its title', async () => {
    const { result } = renderHook(() => useRuntimeConflict(folder(CHOICE)), { wrapper: wrapper() })
    await waitFor(() => expect(result.current?.copy.text).toContain('(GPT-5.5 Pro)'))
    const row = runtimeConflictNotice(result.current)!
    expect(row.singleLine).toBe(true)
    expect(row.title).toBe('cinna-agent.json asks for OpenCode (GPT-5.5 Pro); this agent runs on Claude Agent (sonnet).')
    render(createElement('div', null, row.text), { wrapper: wrapper() })
    expect(screen.getByText('File asks for OpenCode (GPT-5.5 Pro); runs on Claude Agent (sonnet).')).toBeTruthy()
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

/**
 * What an answer dropped from the file ("Dropped “gpt-5.5-pro”.") takes the
 * row's place, inert, until the next send or another agent.
 */
describe('the composer row once answered', () => {
  const other = (conflict: LocalAgentRuntimeConflict | null): LocalAgentDto => ({ ...folder(conflict), id: 'folder:b' }) as LocalAgentDto
  const answered = async (): Promise<ReturnType<typeof renderHook<ReturnType<typeof useRuntimeConflictRow>, { agent: LocalAgentDto; turnRunning: boolean }>>> => {
    resolve.mockResolvedValue({ ok: true, note: 'Dropped “gpt-5.5-pro”.' })
    const hook = renderHook(({ agent, turnRunning }) => useRuntimeConflictRow(agent, turnRunning), {
      wrapper: wrapper(), initialProps: { agent: folder(CHOICE), turnRunning: false }
    })
    await waitFor(() => expect(hook.result.current?.action).toBeTruthy())
    render(createElement('div', null, hook.result.current?.action), { wrapper: wrapper() })
    fireEvent.click(screen.getByRole('button', { name: 'Update file' }))
    await waitFor(() => expect(resolve).toHaveBeenCalled())
    // Main re-resolved the agent: no conflict any more.
    hook.rerender({ agent: folder(null), turnRunning: false })
    await waitFor(() => expect(hook.result.current?.text).toBe('Dropped “gpt-5.5-pro”.'))
    return hook
  }

  it('says what the file lost in the same row, with no action', async () => {
    const hook = await answered()
    const row = hook.result.current!
    expect(row.key).toBe('runtime-conflict')
    expect(row.tone).toBe('accent')
    expect(row.singleLine).toBe(true)
    expect(row.action).toBeUndefined()
  })

  it('clears at the next send, and stays clear after it', async () => {
    const hook = await answered()
    hook.rerender({ agent: folder(null), turnRunning: true })
    await waitFor(() => expect(hook.result.current).toBeNull())
    hook.rerender({ agent: folder(null), turnRunning: false })
    expect(hook.result.current).toBeNull()
  })

  it('clears on another agent, and does not come back with the first', async () => {
    const hook = await answered()
    hook.rerender({ agent: other(null), turnRunning: false })
    expect(hook.result.current).toBeNull()
    hook.rerender({ agent: folder(null), turnRunning: false })
    expect(hook.result.current).toBeNull()
  })

  it('says nothing after an answer that dropped nothing', async () => {
    resolve.mockResolvedValue({ ok: true })
    const hook = renderHook(({ agent }) => useRuntimeConflictRow(agent, false), { wrapper: wrapper(), initialProps: { agent: folder(CHOICE) } })
    await waitFor(() => expect(hook.result.current?.action).toBeTruthy())
    render(createElement('div', null, hook.result.current?.action), { wrapper: wrapper() })
    fireEvent.click(screen.getByRole('button', { name: 'Update file' }))
    await waitFor(() => expect(resolve).toHaveBeenCalled())
    hook.rerender({ agent: folder(null) })
    await new Promise((done) => setTimeout(done, 20))
    expect(hook.result.current).toBeNull()
  })
})
