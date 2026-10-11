import { describe, expect, it } from 'vitest'
import { antigravityDefaultOptionLabel, antigravityModelName, antigravityRunModelLabel } from './antigravityStatus'

describe('the Antigravity model a panel names', () => {
  it('names the Flash level each tier runs, and the server default without one', () => {
    expect(antigravityRunModelLabel(null, 'simple')).toBe('Gemini 3.8 Flash (low)')
    expect(antigravityRunModelLabel(null, 'medium')).toBe('Gemini 3.8 Flash (medium)')
    expect(antigravityRunModelLabel(null, 'complex')).toBe('Gemini 3.8 Flash (high)')
    expect(antigravityRunModelLabel(null, null)).toBe('Gemini 3.8 Flash (high)')
  })

  it('lets a model set on the agent win over the tier, as main resolves it', () => {
    expect(antigravityRunModelLabel('gemini-3-pro', 'simple')).toBe('gemini-3-pro')
  })

  it('leaves an id it cannot read as a Gemini level alone', () => {
    expect(antigravityModelName('gemini-3-pro')).toBe('gemini-3-pro')
  })

  it('names the default option by the server default’s family and level', () => {
    expect(antigravityDefaultOptionLabel()).toBe('Default (Flash high)')
  })
})
