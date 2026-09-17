import { act, render, screen, fireEvent } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DetectedTool } from '../../../../../shared/localTools'
import type { LocalAgentDto } from '../../../../../shared/localAgents'

/**
 * The Open-in button's two rules: the primary click launches the default tool
 * with the action its kind needs, and a pick from the menu becomes the new
 * default. The detected-tool list and the setting are both stubbed at the hook
 * boundary — `useDefaultTool` is the one place the two are combined, and
 * `resolveDefaultTool` has its own tests in `utils/localAgents.test.ts`.
 */

const CLAUDE: DetectedTool = {
  id: 'claude',
  kind: 'cli-assistant',
  label: 'Claude Code',
  path: '/usr/local/bin/claude',
  available: true,
  version: null,
  source: 'path'
}
const CODE: DetectedTool = {
  id: 'code',
  kind: 'editor',
  label: 'VS Code',
  path: '/Applications/Visual Studio Code.app',
  available: true,
  version: null,
  source: 'app-bundle'
}

let defaultTool: DetectedTool | null = CLAUDE
const openIn = vi.fn()
const setDefaultTool = vi.fn()
vi.mock('../../../hooks/useLocalTools', () => ({
  useDefaultTool: () => ({ tool: defaultTool, launchable: [CLAUDE, CODE], autoOpen: false }),
  useOpenIn: () => ({ mutate: openIn, isPending: false }),
  useSetDefaultTool: () => setDefaultTool
}))

/**
 * The init-prompt copy is mocked at the same boundary: what this component owns
 * is the confirmation and the error routing, not the clipboard write, which has
 * its own home in `useCopyAgentInitPrompt`.
 */
const copyInitPrompt = vi.fn()
const openCredentials = vi.fn()
vi.mock('../../../hooks/useLocalAgents', () => ({
  useCopyAgentInitPrompt: () => ({ mutate: copyInitPrompt, isPending: false }),
  useOpenAgentCredentials: () => ({ mutate: openCredentials, isPending: false })
}))

const { OpenInMenu } = await import('./OpenInMenu')

const AGENT = { id: 'folder:alpha', path: '/tmp/agents/alpha', kind: 'kit' } as LocalAgentDto
const onError = vi.fn()
const onNote = vi.fn()

afterEach(() => {
  vi.clearAllMocks()
  defaultTool = CLAUDE
})

describe('OpenInMenu', () => {
  it('launches the default tool in one click, without rewriting the default', () => {
    render(createElement(OpenInMenu, { agent: AGENT, onError, onNote }))
    fireEvent.click(screen.getByRole('button', { name: /open in claude code/i }))

    expect(openIn).toHaveBeenCalledWith(
      { folder: '/tmp/agents/alpha', toolId: 'claude', action: 'terminal-command' },
      expect.anything()
    )
    expect(setDefaultTool).not.toHaveBeenCalled()
    // The page's slot is cleared on every launch and told about a refusal.
    expect(onError).toHaveBeenCalledWith(null)
    const [, options] = openIn.mock.calls[0] as [unknown, { onError: (e: Error) => void }]
    options.onError(new Error("Error invoking remote method 'local-tools:open-in': Terminal automation was denied."))
    expect(onError).toHaveBeenLastCalledWith('Terminal automation was denied.')
  })

  it('makes a tool picked from the menu the new default, with the editor action for an editor', () => {
    render(createElement(OpenInMenu, { agent: AGENT, onError, onNote }))
    fireEvent.click(screen.getByRole('button', { name: /more ways to open/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /vs code/i }))

    expect(setDefaultTool).toHaveBeenCalledWith('code')
    expect(openIn).toHaveBeenCalledWith(
      { folder: '/tmp/agents/alpha', toolId: 'code', action: 'editor' },
      expect.anything()
    )
  })

  it('falls back to "Open in…" as a plain menu when there is no usable default', () => {
    defaultTool = null
    render(createElement(OpenInMenu, { agent: AGENT, onError, onNote }))
    expect(screen.queryByRole('button', { name: /open in claude code/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /open in…/i }))
    expect(screen.getByRole('menuitem', { name: /claude code/i })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /terminal/i })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /reveal folder/i })).toBeTruthy()
  })

  it('opens credentials/.env itself, and says so when only the file manager could show it', () => {
    render(createElement(OpenInMenu, { agent: AGENT, onError, onNote }))
    fireEvent.click(screen.getByRole('button', { name: /more ways to open/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /open credentials\/\.env/i }))

    // The file, by agent id — never a renderer-supplied path — and not a reveal.
    expect(openCredentials).toHaveBeenCalledWith('folder:alpha', expect.anything())
    expect(openIn).not.toHaveBeenCalled()
    expect(setDefaultTool).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(onError).toHaveBeenCalledWith(null)

    const [, options] = openCredentials.mock.calls[0] as [
      unknown,
      {
        onSuccess: (r: { created: boolean; revealed: boolean }) => void
        onError: (e: Error) => void
      }
    ]
    // An editor opened: nothing to add — and nothing cleared, since the slot
    // may by now hold a refusal from another action.
    options.onSuccess({ created: true, revealed: false })
    expect(onNote).not.toHaveBeenCalled()
    // Nothing on this machine opens .env, so the fallback is said where the
    // user can see it — as a note, not an error: the file was shown.
    options.onSuccess({ created: false, revealed: true })
    expect(onNote).toHaveBeenLastCalledWith(
      'Nothing here opens .env, so credentials/.env was shown in the file manager.'
    )
    expect(onError).toHaveBeenLastCalledWith(null)
    options.onError(
      new Error("Error invoking remote method 'local-agent:open-credentials': The credentials folder could not be created.")
    )
    expect(onError).toHaveBeenLastCalledWith('The credentials folder could not be created.')
  })

  it('offers no .env for a bare folder, which has no credentials file', () => {
    render(createElement(OpenInMenu, { agent: { ...AGENT, kind: 'bare' }, onError, onNote }))
    fireEvent.click(screen.getByRole('button', { name: /more ways to open/i }))
    expect(screen.queryByRole('menuitem', { name: /open credentials\/\.env/i })).toBeNull()
    expect(screen.getByRole('menuitem', { name: /reveal folder/i })).toBeTruthy()
  })

  it('never makes Terminal or Reveal the default', () => {
    render(createElement(OpenInMenu, { agent: AGENT, onError, onNote }))
    fireEvent.click(screen.getByRole('button', { name: /more ways to open/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /reveal folder/i }))

    expect(openIn).toHaveBeenCalledWith(
      { folder: '/tmp/agents/alpha', action: 'reveal' },
      expect.anything()
    )
    expect(setDefaultTool).not.toHaveBeenCalled()
  })

  it('copies the prompt and confirms in place, without closing the menu', () => {
    render(createElement(OpenInMenu, { agent: AGENT, onError, onNote }))
    fireEvent.click(screen.getByRole('button', { name: /more ways to open/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /copy prompt for another tool/i }))

    // Built in main from the agent id — the renderer never assembles the path.
    expect(copyInitPrompt).toHaveBeenCalledWith('folder:alpha', expect.anything())
    const [, options] = copyInitPrompt.mock.calls[0] as [unknown, { onSuccess: () => void }]
    act(() => options.onSuccess())

    // The menu is still open, and the item itself is the confirmation: nothing
    // else on screen changes when a clipboard is written.
    expect(screen.getByRole('menuitem', { name: /copied/i })).toBeTruthy()
    expect(setDefaultTool).not.toHaveBeenCalled()
    expect(openIn).not.toHaveBeenCalled()
  })

  it('shows a failed copy inside the menu, which stays open', () => {
    render(createElement(OpenInMenu, { agent: AGENT, onError, onNote }))
    fireEvent.click(screen.getByRole('button', { name: /more ways to open/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /copy prompt for another tool/i }))

    const [, options] = copyInitPrompt.mock.calls[0] as [unknown, { onError: (e: Error) => void }]
    act(() =>
      options.onError(
        new Error("Error invoking remote method 'local-agent:init-prompt': That agent folder is no longer there.")
      )
    )

    // Not the page's slot: an open `below-right` menu covers it. The reason is
    // in the menu, and the menu is still there to retry from.
    expect(screen.getByRole('alert').textContent).toBe('That agent folder is no longer there.')
    expect(onError).not.toHaveBeenCalledWith('That agent folder is no longer there.')
    expect(screen.getByRole('menuitem', { name: /copy prompt for another tool/i })).toBeTruthy()
  })

  it('sends a failure that lands after the menu closed to the page slot instead', () => {
    render(createElement(OpenInMenu, { agent: AGENT, onError, onNote }))
    fireEvent.click(screen.getByRole('button', { name: /more ways to open/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /copy prompt for another tool/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /reveal folder/i }))

    const [, options] = copyInitPrompt.mock.calls[0] as [unknown, { onError: (e: Error) => void }]
    act(() => options.onError(new Error('That agent folder is no longer there.')))

    // A confirmation may be dropped once the user has moved on; a failure may
    // not — the clipboard still holds what it held before. The page slot is
    // not covered now the menu is gone, so that is where it goes.
    expect(onError).toHaveBeenLastCalledWith('That agent folder is no longer there.')
    fireEvent.click(screen.getByRole('button', { name: /more ways to open/i }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not re-arm "Copied" when the copy lands after the user has moved on', () => {
    render(createElement(OpenInMenu, { agent: AGENT, onError, onNote }))
    fireEvent.click(screen.getByRole('button', { name: /more ways to open/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /copy prompt for another tool/i }))

    // The copy is in flight and the item is the only disabled one, so the user
    // can still click Reveal folder — which closes the menu.
    fireEvent.click(screen.getByRole('menuitem', { name: /reveal folder/i }))
    const [, options] = copyInitPrompt.mock.calls[0] as [unknown, { onSuccess: () => void }]
    act(() => options.onSuccess())

    fireEvent.click(screen.getByRole('button', { name: /more ways to open/i }))
    expect(screen.getByRole('menuitem', { name: /copy prompt for another tool/i })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /copied/i })).toBeNull()
  })
})
