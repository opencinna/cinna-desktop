import { describe, expect, it } from 'vitest'
import { COLOR_PRESETS, getPreset, THEME_COLOR_PRESET } from './chatModeColors'
import { presetForAgentId } from '../utils/agentColors'

describe('Theme Default preset', () => {
  it('resolves by id and draws only with theme variables', () => {
    expect(getPreset('theme')).toBe(THEME_COLOR_PRESET)
    expect(getPreset('theme')).toMatchObject({ name: 'Theme Default', border: 'var(--color-accent)', card: 'var(--color-accent)', text: 'var(--color-on-accent)' })
    expect(getPreset('theme').bg).toContain('var(--color-accent)')
  })

  it('stays out of COLOR_PRESETS, which agent colours hash over', () => {
    expect(COLOR_PRESETS.map((preset) => preset.id)).not.toContain('theme')
    expect(COLOR_PRESETS).toHaveLength(10)
    expect(presetForAgentId('some-agent-id').border).not.toContain('var(')
  })

  it('an unknown id still falls back to the first preset', () => {
    expect(getPreset('blue')).toBe(COLOR_PRESETS[0])
  })
})
