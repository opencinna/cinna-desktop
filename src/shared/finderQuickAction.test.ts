import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_BUNDLE_ID } from './finderQuickAction'

describe('APP_BUNDLE_ID', () => {
  it('is the appId electron-builder stamps into the packaged bundle', () => {
    const config = readFileSync(join(__dirname, '..', '..', 'electron-builder.yml'), 'utf8')
    expect(config).toMatch(new RegExp(`^appId: ${APP_BUNDLE_ID.replace(/\./g, '\\.')}$`, 'm'))
  })
})
