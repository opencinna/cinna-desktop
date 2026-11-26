import { cleanup, fireEvent, render as renderPlain, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement, ReactNode } from 'react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Share changes dialog's two shapes — the Bring together step while both
 * sides moved, and the field pre-filled with the session's summary after
 * Finish — and the Discard confirm, which cannot be dismissed while it runs.
 */

const { DiscardAdoptionDialog, ShareChangesDialog, ShareWithTeamDialog } = await import('./ShareDialogs')
const { SHARE_UI_TEXT } = await import('../../../../utils/shareText')

/** The dialogs read the agent (its runtime-conflict warning) through the query cache. */
function render(element: ReactElement): ReturnType<typeof renderPlain> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderPlain(element, { wrapper: ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children) })
}

const ok = <T,>(value: T) => ({ success: true as const, value })

let draftMessage: ReturnType<typeof vi.fn>

beforeEach(() => {
  draftMessage = vi.fn().mockResolvedValue(ok('An AI summary'))
  ;(window as unknown as { api: unknown }).api = { sharing: { draftMessage } }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ShareChangesDialog — the Bring together step', () => {
  it('shows the sentence and Bring together in place of the field, and asks for no draft', () => {
    const onBringTogether = vi.fn()
    const onShare = vi.fn()
    render(
      createElement(ShareChangesDialog, {
        agentId: 'folder:alpha',
        pending: false,
        error: null,
        combineFirst: true,
        onBringTogether,
        bringTogetherPending: false,
        onShare,
        onCancel: vi.fn()
      })
    )
    const dialog = screen.getByRole('dialog', { name: SHARE_UI_TEXT.shareChangesTitle })
    expect(dialog.textContent).toContain(SHARE_UI_TEXT.bringTogetherBanner)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: SHARE_UI_TEXT.share })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.bringTogether }))
    expect(onBringTogether).toHaveBeenCalledTimes(1)
    expect(onShare).not.toHaveBeenCalled()
    expect(draftMessage).not.toHaveBeenCalled()
  })

  it('reads Bringing together… inside the button while it runs, and ignores Cancel then', () => {
    const onCancel = vi.fn()
    render(
      createElement(ShareChangesDialog, {
        agentId: 'folder:alpha',
        pending: false,
        error: null,
        combineFirst: true,
        onBringTogether: vi.fn(),
        bringTogetherPending: true,
        onShare: vi.fn(),
        onCancel
      })
    )
    const bring = screen.getByRole('button', { name: SHARE_UI_TEXT.bringingTogether }) as HTMLButtonElement
    expect(bring.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.cancel }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
  })
})

describe('ShareChangesDialog — pre-filled after Finish', () => {
  it('starts with the session’s summary, never asks for a draft, and sends it', () => {
    const onShare = vi.fn()
    render(
      createElement(ShareChangesDialog, {
        agentId: 'folder:alpha',
        pending: false,
        error: null,
        initialMessage: 'Kept one tax rule.',
        onShare,
        onCancel: vi.fn()
      })
    )
    const field = screen.getByLabelText(SHARE_UI_TEXT.shareChangesLabel) as HTMLTextAreaElement
    expect(field.value).toBe('Kept one tax rule.')
    expect(field.placeholder).toBe(SHARE_UI_TEXT.shareChangesEmptyPlaceholder)
    expect(draftMessage).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.share }))
    expect(onShare).toHaveBeenCalledWith('Kept one tax rule.')
  })

  it('asks for a draft when nothing is given', () => {
    render(
      createElement(ShareChangesDialog, {
        agentId: 'folder:alpha',
        pending: false,
        error: null,
        onShare: vi.fn(),
        onCancel: vi.fn()
      })
    )
    expect(draftMessage).toHaveBeenCalledWith('folder:alpha')
  })
})

describe('DiscardAdoptionDialog', () => {
  function mount(pending: boolean): { onDiscard: ReturnType<typeof vi.fn>; onCancel: ReturnType<typeof vi.fn> } {
    const onDiscard = vi.fn()
    const onCancel = vi.fn()
    render(createElement(DiscardAdoptionDialog, { name: 'Alpha', pending, error: null, onDiscard, onCancel }))
    return { onDiscard, onCancel }
  }

  it('names the agent, says what is kept, and focuses Cancel', () => {
    const { onDiscard, onCancel } = mount(false)
    const dialog = screen.getByRole('dialog', { name: SHARE_UI_TEXT.discardTitle })
    expect(dialog.textContent).toContain(SHARE_UI_TEXT.discardBody('Alpha'))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: SHARE_UI_TEXT.cancel }))
    fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.discardConfirm }))
    expect(onDiscard).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('ignores Escape and Cancel while it runs, and reads Discarding…', () => {
    const { onCancel } = mount(true)
    expect((screen.getByRole('button', { name: SHARE_UI_TEXT.discarding }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: SHARE_UI_TEXT.cancel }))
    expect(onCancel).not.toHaveBeenCalled()
  })
})

/**
 * Sharing an agent whose file disagrees with what it runs on here: the file
 * is what travels. A warning with the app's answer inline; Share stays live.
 */
describe('the runtime-conflict warning in the share dialogs', () => {
  const conflictAgent = (kind: 'choice' | 'unrecorded' | null) => ({
    ok: true,
    value: {
      id: 'folder:alpha', kind: 'kit', stamps: { 'cinna-agent.json': { size: 1, mtimeMs: 1, hash: 'h' } },
      resolvedRuntime: {
        engine: 'claude', credentialId: null, source: 'choice', choice: kind === 'choice' ? { kind: 'default' } : null,
        conflict: kind && {
          kind,
          file: { engine: 'opencode', credentialName: 'Managed OpenAI', modelId: null },
          app: { engine: 'claude', credentialName: null, modelId: null }
        }
      }
    }
  })
  let resolveConflict: ReturnType<typeof vi.fn>
  const api = (kind: 'choice' | 'unrecorded' | null): void => {
    resolveConflict = vi.fn().mockResolvedValue({ ok: true })
    ;(window as unknown as { api: unknown }).api = {
      sharing: { draftMessage, shareWithTeamDraft: async () => ({ success: true, value: { name: 'Alpha' } }) },
      localAgents: { get: async () => conflictAgent(kind), resolveRuntimeConflict: resolveConflict },
      providers: { listModels: async () => [] },
      agentSessions: { active: async () => ({ ok: true, sessions: [] }), onChanged: () => () => {} },
      taskDispatch: { onChanged: () => () => {} },
      chat: { onTitleUpdated: () => () => {} },
      engine: { modelCatalog: async () => ({ engine: 'claude', models: [], source: 'unavailable', updatedAt: null }) }
    }
  }
  const changes = () => createElement(ShareChangesDialog, { agentId: 'folder:alpha', pending: false, error: null, onShare: vi.fn(), onCancel: vi.fn() })

  it('warns on Share changes with Update file inline, and leaves Share live', async () => {
    api('choice')
    render(changes())
    expect(await screen.findByText(/cinna-agent\.json asks for OpenCode; this agent runs on Claude Agent\. People who get it run what the file says\./)).toBeTruthy()
    expect((screen.getByRole('button', { name: SHARE_UI_TEXT.share }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Update file' }))
    await waitFor(() => expect(resolveConflict).toHaveBeenCalledWith({ agentId: 'folder:alpha', action: 'update_file', stamp: { size: 1, mtimeMs: 1, hash: 'h' } }))
  })

  it('offers Use Default runtime for a pin the app never chose, on Share with the team too', async () => {
    api('unrecorded')
    render(createElement(ShareWithTeamDialog, { agentId: 'folder:alpha', pending: false, error: null, onShare: vi.fn(), onCancel: vi.fn() }))
    fireEvent.click(await screen.findByRole('button', { name: 'Use Default runtime' }))
    await waitFor(() => expect(resolveConflict).toHaveBeenCalledWith(expect.objectContaining({ action: 'use_default' })))
  })

  it('says nothing when the file and the app agree', async () => {
    api(null)
    render(changes())
    await waitFor(() => expect(screen.getByRole('button', { name: SHARE_UI_TEXT.share })).toBeTruthy())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(document.querySelector('[data-runtime-conflict]')).toBeNull()
  })
})

