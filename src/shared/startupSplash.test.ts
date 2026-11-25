import { describe, expect, it } from 'vitest'
import { STARTUP_SPLASH_FAST_ARG, startupSplashArgs } from './startupSplash'

describe('startupSplashArgs', () => {
  it('passes the fast switch for CINNA_STARTUP_SPLASH=fast in an unpackaged build', () => {
    expect(startupSplashArgs({ CINNA_STARTUP_SPLASH: 'fast' }, false)).toEqual([STARTUP_SPLASH_FAST_ARG])
  })

  it('never passes it in a packaged build', () => {
    expect(startupSplashArgs({ CINNA_STARTUP_SPLASH: 'fast' }, true)).toEqual([])
  })

  it('passes nothing without the variable or with another value', () => {
    expect(startupSplashArgs({}, false)).toEqual([])
    expect(startupSplashArgs({ CINNA_STARTUP_SPLASH: 'full' }, false)).toEqual([])
  })
})
