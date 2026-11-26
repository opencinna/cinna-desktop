import { describe, expect, it } from 'vitest'
import { failedUrlScheme, isRendererLoadFailure } from './rendererFailure'

describe('isRendererLoadFailure', () => {
  it('is the main frame failing to load', () => {
    expect(isRendererLoadFailure({ errorCode: -6, isMainFrame: true })).toBe(true)
  })

  it('is never a subframe, whatever it failed with', () => {
    // ERR_BLOCKED_BY_CSP from a Details frame's refused https load.
    expect(isRendererLoadFailure({ errorCode: -30, isMainFrame: false })).toBe(false)
    expect(isRendererLoadFailure({ errorCode: -6, isMainFrame: false })).toBe(false)
  })

  it('ignores an aborted main-frame navigation', () => {
    expect(isRendererLoadFailure({ errorCode: -3, isMainFrame: true })).toBe(false)
  })
})

describe('failedUrlScheme', () => {
  it('keeps the scheme only', () => {
    expect(failedUrlScheme('https://example.com/a?b')).toBe('https')
    expect(failedUrlScheme('cinna-preview://det-1/')).toBe('cinna-preview')
    expect(failedUrlScheme('')).toBe('')
  })
})
