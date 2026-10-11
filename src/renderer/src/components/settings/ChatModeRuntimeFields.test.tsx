import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatModeRuntimeFields } from './ChatModeRuntimeFields'

const catalog = vi.hoisted(() => ({ data: undefined as unknown }))
vi.mock('../../hooks/useRuntimeModelCatalog', () => ({ useRuntimeModelCatalog: () => catalog }))

describe('chat runtime profile', () => {
  it('clears model and credential when changing runtime, offers Claude aliases and no file tools', () => {
    const onChange = vi.fn()
    const view = render(<ChatModeRuntimeFields value={{ engine: 'opencode', modelId: 'provider-model', providerId: 'credential' }} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Runtime'), { target: { value: 'claude' } })
    expect(onChange).toHaveBeenCalledWith({ engine: 'claude', modelId: null, providerId: null })
    view.rerender(<ChatModeRuntimeFields value={{ engine: 'claude', modelId: null }} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'opus' } })
    expect(onChange).toHaveBeenCalledWith({ modelId: 'opus' })
    fireEvent.change(screen.getByLabelText('Tools'), { target: { value: 'none' } })
    expect(onChange).toHaveBeenCalledWith({ toolPolicy: 'none' })
    expect(screen.queryByRole('option', { name: /filesystem|shell/i })).toBeNull()
  })

  it('holds instructions while typing and saves them on blur', () => {
    const onChange = vi.fn()
    render(<ChatModeRuntimeFields value={{ systemPrompt: 'Old' }} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'New instructions' } })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.blur(screen.getByLabelText('Instructions'))
    expect(onChange).toHaveBeenCalledWith({ systemPrompt: 'New instructions' })
  })
})

it('uses models advertised by the runtime instead of fallback aliases', () => {
  catalog.data = { source: 'session', models: [{ id: 'runtime-custom-5', name: 'Runtime Custom 5' }] }
  const onChange = vi.fn()
  render(<ChatModeRuntimeFields value={{ engine: 'claude' }} onChange={onChange} />)
  expect(screen.queryByRole('option', { name: 'Opus' })).toBeNull()
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'runtime-custom-5' } })
  expect(onChange).toHaveBeenCalledWith({ modelId: 'runtime-custom-5' })
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: '__custom__' } })
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'another-model' } })
  fireEvent.blur(screen.getByLabelText('Model'))
  expect(onChange).toHaveBeenCalledWith({ modelId: 'another-model' })
  catalog.data = undefined
})

it('offers Antigravity as a chat runtime, with the models its last session advertised', () => {
  const onChange = vi.fn()
  const view = render(<ChatModeRuntimeFields value={{ engine: 'opencode', modelId: 'provider-model', providerId: 'credential' }} onChange={onChange} />)
  fireEvent.change(screen.getByLabelText('Runtime'), { target: { value: 'antigravity' } })
  expect(onChange).toHaveBeenCalledWith({ engine: 'antigravity', modelId: null, providerId: null })
  // No catalog yet: no list to pick from (Claude's aliases are Claude's), an
  // explicit model id field instead.
  view.rerender(<ChatModeRuntimeFields value={{ engine: 'antigravity', modelId: null }} onChange={onChange} />)
  expect(screen.queryByRole('option', { name: 'Opus' })).toBeNull()
  expect((screen.getByLabelText('Model') as HTMLInputElement).placeholder).toBe('Runtime default')
  view.unmount()
  catalog.data = { source: 'session', models: [{ id: 'gemini-3-pro', name: 'Gemini 3 Pro' }] }
  render(<ChatModeRuntimeFields value={{ engine: 'antigravity' }} onChange={onChange} />)
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gemini-3-pro' } })
  expect(onChange).toHaveBeenCalledWith({ modelId: 'gemini-3-pro' })
  catalog.data = undefined
})
