import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ComposerPlusMenu } from './ComposerPlusMenu'
import { MentionPopup } from './MentionPopup'
import { composerModeGroup, composerModes } from '../../utils/composerModes'
import type { ChatModeData } from '../../constants/chatModeColors'
import type { RuntimeModeAvailability } from '../../../../shared/chatModeRuntime'

/**
 * The composer's Chat mode lists: runtime modes in a Runtimes group above the
 * saved modes, only while their runtime can start a chat.
 */

const NAMES = { claude: 'Claude Agent', codex: 'Codex', antigravity: 'Antigravity', opencode: 'OpenCode' } as const
function runtimeMode(engine: keyof typeof NAMES, availability: RuntimeModeAvailability): ChatModeData {
  return {
    id: `rt-${engine}`, name: NAMES[engine], engine, builtinEngine: engine, runtime: { engine, availability },
    systemPrompt: '', toolPolicy: 'connectors', complexity: 'medium', providerId: null, modelId: null, mcpProviderIds: [],
    colorPreset: 'orange', isDefault: false, managed: false, adminManaged: false, enabled: true, createdAt: new Date()
  }
}
function savedMode(id: string, extra: Partial<ChatModeData> = {}): ChatModeData {
  return {
    id, name: id, engine: null, builtinEngine: null, systemPrompt: '', toolPolicy: 'connectors', complexity: null,
    providerId: null, modelId: null, mcpProviderIds: [], colorPreset: 'indigo', isDefault: false,
    managed: false, adminManaged: false, enabled: true, createdAt: new Date(), ...extra
  }
}

const all = [
  savedMode('Writing'),
  runtimeMode('opencode', 'needs_credential'),
  runtimeMode('antigravity', 'needs_login'),
  savedMode('Switched off', { managed: true, enabled: false }),
  runtimeMode('codex', 'needs_install'),
  runtimeMode('claude', 'ready')
]

describe('composerModes', () => {
  it('offers active runtime modes first, in the runtime order, and leaves inactive ones out', () => {
    // Needs login still counts: login is checked when the chat starts.
    expect(composerModes(all).map((mode) => mode.name)).toEqual(['Claude Agent', 'Antigravity', 'Writing'])
  })

  it('names groups only when there is a runtime mode to set apart', () => {
    const list = composerModes(all)
    expect(list.map((mode) => composerModeGroup(mode, list))).toEqual(['Runtimes', 'Runtimes', 'Saved modes'])
    const savedOnly = composerModes([savedMode('Writing')])
    expect(composerModeGroup(savedOnly[0], savedOnly)).toBeNull()
  })
})

describe('Chat mode sub-menu', () => {
  it('draws a Runtimes group above the saved modes, with the same selection behaviour', () => {
    const onSelectMode = vi.fn()
    const modes = composerModes(all)
    render(<ComposerPlusMenu canAttachFiles={false} onAttachFiles={() => {}} hasCapabilities={false} onOpenCapabilityPicker={() => {}}
      modeMenu={{ modes, activeId: 'rt-claude', onSelectMode, renderIcon: () => null }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Chat mode' }))
    const menu = screen.getByRole('menu')
    const text = menu.textContent ?? ''
    expect(text.indexOf('Runtimes')).toBeLessThan(text.indexOf('Claude Agent'))
    expect(text.indexOf('Antigravity')).toBeLessThan(text.indexOf('Saved modes'))
    expect(text.indexOf('Saved modes')).toBeLessThan(text.indexOf('Writing'))
    expect(screen.queryByText('Codex')).toBeNull()
    expect(screen.queryByText('OpenCode')).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: /Claude Agent/ }).getAttribute('aria-checked')).toBe('true')
    // The active one deselects; another one selects.
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Claude Agent/ }))
    expect(onSelectMode).toHaveBeenLastCalledWith(null)
  })

  it('offers Open Chat Folder under Actions when asked to', () => {
    const onOpen = vi.fn()
    render(<ComposerPlusMenu canAttachFiles={false} onAttachFiles={() => {}} hasCapabilities={false} onOpenCapabilityPicker={() => {}}
      actions={{ openChatFolder: { disabled: false, onOpen } }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open Chat Folder' }))
    expect(onOpen).toHaveBeenCalledOnce()
  })
})

describe('~ popup', () => {
  it('heads the runtime modes with Runtimes too', () => {
    Element.prototype.scrollIntoView = () => {}
    const modes = composerModes(all)
    render(<MentionPopup items={modes} selectedIndex={0} onSelect={() => {}} onClose={() => {}} listboxId="modes"
      header="Chat Modes" ariaLabel="Chat modes" getKey={(mode) => mode.id} getPrimary={(mode) => mode.name}
      getGroup={(mode) => composerModeGroup(mode, modes)} />)
    const text = screen.getByRole('listbox').textContent ?? ''
    expect(text).toBe('RuntimesClaude AgentAntigravitySaved modesWriting')
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Claude Agent', 'Antigravity', 'Writing'])
  })
})
