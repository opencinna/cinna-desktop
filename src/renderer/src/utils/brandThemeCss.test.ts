import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildBrandThemeCss, brandBackgroundRules } from './brandThemeCss'
import { BRAND_ROLE_MAP } from '../../../shared/brandTheme/roleMap'
import type { ResolvedBrandTheme } from '../../../shared/brandTheme/roles'

const fixtures = join(process.cwd(), 'src/shared/brandTheme/fixtures')

/** valid/full as main resolves it, with stand-in data URLs (main sniffs the MIME; see parse.test.ts). */
function fullTheme(): ResolvedBrandTheme {
  const served = JSON.parse(readFileSync(join(fixtures, 'valid/full/served/served.json'), 'utf8')) as {
    revision: number
    theme: { name: string; modes: ResolvedBrandTheme['modes'] }
  }
  return {
    origin: 'https://acme.example',
    revision: served.revision,
    name: served.theme.name,
    modes: served.theme.modes,
    background: { dark: 'data:image/webp;base64,UklGRg==', light: 'data:image/webp;base64,UklGRh==' },
    copy: {}
  }
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

describe('buildBrandThemeCss', () => {
  it('builds one @layer brand sheet with both modes from the role map', () => {
    const css = buildBrandThemeCss(fullTheme())!
    expect(css.startsWith('@layer brand {\n')).toBe(true)
    expect(css).toContain('[data-brand][data-theme="dark"] {')
    expect(css).toContain('[data-brand][data-theme="light"] {')
    // A role mapped to two variables sets both.
    expect(css).toContain('--color-danger: #ef4444;')
    expect(css).toContain('--color-severity-error: #ef4444;')
    expect(css).toContain('--color-dashboard-muted: #8a8a8a;')
    const declared = css.match(/--color-[a-z0-9-]+:/g) ?? []
    expect(declared).toHaveLength(2 * Object.values(BRAND_ROLE_MAP).flat().length)
    expect(css).toContain('[data-brand][data-theme="dark"] body { background-image: url("data:image/webp;base64,UklGRg=="); }')
  })

  it('writes nothing but #rrggbb values into declarations', () => {
    const css = buildBrandThemeCss(fullTheme())!
    const values = [...css.matchAll(/--color-[a-z0-9-]+: ([^;]*);/g)].map((m) => m[1])
    expect(values.every((v) => /^#[0-9a-f]{6}$/.test(v))).toBe(true)
  })

  it.each(['#FFFFFF', 'red', '#fff', '#ffffff; } body { display: none', 'var(--color-bg)', 'url(x)', ''])(
    'refuses the whole sheet for a role value %j',
    (value) => {
      const theme = clone(fullTheme())
      theme.modes.light.border = value
      expect(buildBrandThemeCss(theme)).toBeNull()
    }
  )

  it('refuses a missing role or mode', () => {
    const noRole = clone(fullTheme())
    delete (noRole.modes.dark as Partial<ResolvedBrandTheme['modes']['dark']>)['chart.8']
    expect(buildBrandThemeCss(noRole)).toBeNull()
    const noMode = clone(fullTheme()) as unknown as { modes: Record<string, unknown> }
    delete noMode.modes.light
    expect(buildBrandThemeCss(noMode as unknown as ResolvedBrandTheme)).toBeNull()
  })

  it('a null background and a missing block both paint background-image: none, never the stock mesh', () => {
    const flatLight = fullTheme()
    flatLight.background = { dark: flatLight.background.dark, light: null }
    expect(buildBrandThemeCss(flatLight)).toContain('[data-brand][data-theme="light"] body { background-image: none; }')

    const noBlock = fullTheme() as Partial<ResolvedBrandTheme>
    delete noBlock.background
    const css = buildBrandThemeCss(noBlock as ResolvedBrandTheme)!
    expect(css).toContain('[data-brand][data-theme="dark"] body { background-image: none; }')
    expect(css).toContain('[data-brand][data-theme="light"] body { background-image: none; }')
    expect(css).not.toContain('gradient-mesh')
  })

  it('takes only data: URLs of an image type as a background', () => {
    for (const url of ['https://example.com/bg.png', 'data:text/css;base64,AAAA', 'data:image/png;base64,AA")}body{x:url("', 'data:image/png,raw']) {
      expect(brandBackgroundRules({ dark: url, light: null }), url).toBeNull()
    }
    expect(brandBackgroundRules({ dark: 'data:image/svg+xml;base64,PHN2Zz4=', light: null })).toEqual([
      '  [data-brand][data-theme="dark"] body { background-image: url("data:image/svg+xml;base64,PHN2Zz4="); }',
      '  [data-brand][data-theme="light"] body { background-image: none; }'
    ])
  })

  it('leaves the background out for the tray popup', () => {
    const css = buildBrandThemeCss(fullTheme(), { background: false })!
    expect(css).not.toContain('background-image')
    expect(css).not.toContain(' body ')
  })
})
