import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BRAND_DERIVED_VARIABLES, BRAND_ROLE_MAP } from './roleMap'
import { BRAND_THEME_ROLES } from './roles'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '../../renderer/src/assets/main.css'), 'utf8')

/** Every `--color-*` main.css declares (not merely reads). */
const declared = new Set([...css.matchAll(/(?:^|[\s;{])--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]))

describe('brand role map', () => {
  it('lists every role once, in the contract order', () => {
    expect(Object.keys(BRAND_ROLE_MAP)).toEqual([...BRAND_THEME_ROLES])
  })

  it('finds the variables in main.css at all', () => {
    expect(declared.size).toBeGreaterThan(40)
  })

  it('maps or derives every --color-* main.css declares', () => {
    const mapped = new Set(Object.values(BRAND_ROLE_MAP).flat())
    const derived = new Set(BRAND_DERIVED_VARIABLES)
    const loose = [...declared].filter((name) => !mapped.has(name) && !derived.has(name))
    expect(loose, 'a --color-* variable is neither mapped from a role nor on the derived list').toEqual([])
  })

  it('maps only variables that exist, each to one role, and derives none of them', () => {
    const all = Object.values(BRAND_ROLE_MAP).flat()
    expect(all.filter((name) => !declared.has(name))).toEqual([])
    expect(new Set(all).size).toBe(all.length)
    expect(all.filter((name) => BRAND_DERIVED_VARIABLES.includes(name))).toEqual([])
    expect(BRAND_DERIVED_VARIABLES.filter((name) => !declared.has(name))).toEqual([])
  })
})
