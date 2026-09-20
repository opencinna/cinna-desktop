import { it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

it('keeps the runtime and its shared contracts independent of desktop transports', () => {
  expect(execFileSync(process.execPath, [resolve('scripts/check-hub-boundary.mjs')], { encoding: 'utf8' }))
    .toContain('Hub boundary:')
})
