import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseBrandTheme, toResolvedBrandTheme, type ParsedBrandTheme } from './parse'
import { checkSvg } from './svgCheck'
import { rasterSize, sniffMime } from './imageFacts'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../../../shared/brandTheme/fixtures')

function cases(kind: 'valid' | 'invalid' | 'svg'): string[] {
  const entries: Dirent[] = readdirSync(join(fixtures, kind), { withFileTypes: true })
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
}

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Every file under `dir`, by its sha256; a missing dir is no files. */
function hashed(dir: string, into = new Map<string, Buffer>()): Map<string, Buffer> {
  if (!existsSync(dir)) return into
  const entries: Dirent[] = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) hashed(path, into)
    else {
      const bytes = readFileSync(path)
      into.set(sha(bytes), bytes)
    }
  }
  return into
}

/** The fixture's package assets, then `served/assets/<sha>` (core's sanitised bytes) over them. */
function assetsOf(dir: string): Map<string, Buffer> {
  const map = hashed(join(dir, 'assets'))
  const served = join(dir, 'served', 'assets')
  if (existsSync(served)) {
    for (const name of readdirSync(served)) map.set(name, readFileSync(join(served, name)))
  }
  return map
}

function served(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'served', 'served.json'), 'utf8')) as Record<string, unknown>
}

function ok(result: ReturnType<typeof parseBrandTheme>): ParsedBrandTheme {
  if ('error' in result) throw new Error(`expected a theme, got: ${result.error}`)
  return result.ok
}

const fullDir = join(fixtures, 'valid', 'full')
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

describe('parseBrandTheme over core fixtures', () => {
  it.each(cases('valid'))('accepts valid/%s', (name) => {
    const dir = join(fixtures, 'valid', name)
    const parsed = ok(parseBrandTheme(served(dir), assetsOf(dir)))
    expect(parsed.modes.dark['surface.base']).toMatch(/^#[0-9a-f]{6}$/)
  })

  const unsafe = cases('invalid').filter((name) => {
    const expect = JSON.parse(readFileSync(join(fixtures, 'invalid', name, 'expect.json'), 'utf8')) as { tag: string }
    return expect.tag === 'unsafe'
  })
  // Two unsafe cases cannot be fed as a served document; each has its own test below.
  const special = new Set(['background-missing-mode-key', 'invalid-json'])

  it('finds unsafe fixtures', () => {
    expect(unsafe.length).toBeGreaterThan(15)
  })

  it.each(unsafe.filter((name) => !special.has(name)))('rejects unsafe invalid/%s', (name) => {
    const dir = join(fixtures, 'invalid', name)
    // A server that skipped validation sends the raw package bytes.
    const result = parseBrandTheme(served(dir), hashed(join(dir, 'assets')))
    expect(result).toHaveProperty('error')
  })

  it('accepts invalid/background-missing-mode-key as flat in both modes', () => {
    // Tagged unsafe, but its served form cannot show the defect: core's
    // served_document fills the missing mode with null, so what arrives is a
    // valid background block that is flat in both modes.
    const dir = join(fixtures, 'invalid', 'background-missing-mode-key')
    const parsed = ok(parseBrandTheme(served(dir), hashed(join(dir, 'assets'))))
    expect(parsed.background).toEqual({ dark: null, light: null })
  })

  it('rejects invalid/invalid-json fed as the response body', () => {
    // No served form exists for a package that is not JSON; its theme.json
    // text stands in for a response body.
    const text = readFileSync(join(fixtures, 'invalid', 'invalid-json', 'theme.json'), 'utf8')
    expect(parseBrandTheme(text, new Map())).toHaveProperty('error')
  })
})

describe('checkSvg over core SVG fixtures', () => {
  it.each(cases('svg'))('svg/%s: rejects the upload, accepts core output', (name) => {
    const dir = join(fixtures, 'svg', name)
    const expect_ = JSON.parse(readFileSync(join(dir, 'expect.json'), 'utf8')) as { core: string }
    expect(checkSvg(readFileSync(join(dir, 'input.svg'))).ok).toBe(false)
    if (expect_.core === 'sanitised') {
      expect(checkSvg(readFileSync(join(dir, 'sanitised.svg')))).toEqual({ ok: true })
    } else {
      expect(expect_.core).toBe('refused')
    }
  })

  const svg = (body: string): boolean =>
    checkSvg(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`)).ok

  it('accepts the canonical form and refuses its near misses', () => {
    expect(svg('<rect width="1" height="1"/>')).toBe(true)
    expect(svg('<title>A &amp; B</title><rect width="1"/>')).toBe(true)
    expect(svg('<linearGradient id="g"/><linearGradient id="h" href="#g"/><rect fill="url(#g)"/>')).toBe(true)
    expect(svg(' <rect/>')).toBe(false) // whitespace between tags
    expect(svg('<rect></rect>')).toBe(false) // empty element written open and closed
    expect(svg("<rect width='1'/>")).toBe(false) // single quotes
    expect(svg('<rect fill="url(http://x)"/>')).toBe(false)
    expect(svg('<rect href="#g"/>')).toBe(false) // href off a gradient
    expect(svg('<rect class="a"/>')).toBe(false)
    expect(svg('<rect style="fill: red"/>')).toBe(false) // non-canonical style
    expect(svg('<rect style="font-family:x"/>')).toBe(false)
    expect(svg('<!-- c --><rect/>')).toBe(false)
    expect(svg('<rect fill="&#x41;"/>')).toBe(false)
    expect(svg('text')).toBe(false)
    expect(checkSvg(Buffer.from('<svg viewBox="0 0 1 1"/>')).ok).toBe(false)
    expect(checkSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 0 1"/>')).ok).toBe(false)
    expect(checkSvg(Buffer.from('﻿<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>')).ok).toBe(false)
  })

  // The SVG fixtures' uploads are mostly refused already at their root
  // (`xmlns:xlink`, a DOCTYPE); these put what core removes from them into
  // otherwise canonical files, so the allowlists themselves are exercised.
  it.each([
    '<script/>',
    '<foreignObject/>',
    '<image href="#a"/>',
    '<use href="#a"/>',
    '<a href="#a"/>',
    '<style/>',
    '<metadata/>',
    '<svg viewBox="0 0 1 1"/>',
    '<rect onload="alert(1)"/>',
    '<rect inkscape:label="x"/>',
    '<rect fill="javascript:alert(1)"/>',
    '<rect fill="data:image/png;base64,AA"/>',
    '<rect style="fill:url(https://example.com/x)"/>',
    '<rect style="stroke:#c8693d;"/>',
    '<rect transform="expression(alert(1))"/>',
    '<rect fill="a/*b"/>',
    '<rect fill="a\\b"/>',
    '<rect fill="&lt;b"/>',
    '<linearGradient href="https://example.com/#g"/>',
    '<rect id="1x"/>',
    '<title>a<rect/></title>',
    '<title>a &quot;b&quot;</title>',
    '<title>a > b</title>'
  ])('refuses %s', (body) => {
    expect(svg(body)).toBe(false)
  })

  it('caps nesting depth at 64', () => {
    const nest = (depth: number): string => '<g>'.repeat(depth - 2) + '<rect/>' + '</g>'.repeat(depth - 2)
    // The root is depth 1 and the rect the deepest.
    expect(svg(nest(64))).toBe(true)
    expect(svg(nest(65))).toBe(false)
  })
})

describe('image facts', () => {
  it('reads raster sizes from the bytes', () => {
    const assets = hashed(join(fullDir, 'assets'))
    const sizes = [...assets.values()].flatMap((bytes) => {
      const mime = sniffMime(bytes)
      if (!mime || mime === 'image/svg+xml') return []
      return [{ mime, size: rasterSize(bytes, mime) }]
    })
    expect(sizes).toEqual(
      expect.arrayContaining([
        { mime: 'image/png', size: { width: 480, height: 124 } },
        { mime: 'image/webp', size: { width: 1652, height: 1000 } }
      ])
    )
  })

  it('reads a VP8X WebP canvas and a JPEG SOF', () => {
    const vp8x = Buffer.alloc(30)
    vp8x.write('RIFF', 0, 'latin1')
    vp8x.write('WEBPVP8X', 8, 'latin1')
    vp8x.writeUIntLE(4999, 24, 3)
    vp8x.writeUIntLE(99, 27, 3)
    expect(rasterSize(vp8x, 'image/webp')).toEqual({ width: 5000, height: 100 })

    // SOI, an APP0 of 4 bytes, then SOF0 with height 300 and width 5000.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x13, 0x88, 0x03])
    expect(sniffMime(jpeg)).toBe('image/jpeg')
    expect(rasterSize(jpeg, 'image/jpeg')).toEqual({ width: 5000, height: 300 })
  })

  it('sniffs SVG in linear time: a run of comments not followed by <svg is refused at once', () => {
    // Core's _SVG_HEAD_RE backtracks exponentially on this; ~40 comments froze main.
    const hostile = Buffer.from('<!---->'.repeat(500) + 'x', 'latin1')
    const started = performance.now()
    expect(sniffMime(hostile)).toBeNull()
    expect(performance.now() - started).toBeLessThan(50)
    expect(sniffMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('image/svg+xml')
    expect(sniffMime(Buffer.from('<svgx/>'))).toBeNull()
  })
})

describe('parseBrandTheme safety checks', () => {
  const base = (): Record<string, unknown> => clone(served(fullDir))
  const theme = (doc: Record<string, unknown>): Record<string, unknown> => doc.theme as Record<string, unknown>

  it('accepts valid/full and resolves data URLs with the sniffed MIME', () => {
    const parsed = ok(parseBrandTheme(base(), assetsOf(fullDir)))
    const resolved = toResolvedBrandTheme(parsed, 'https://acme.example')
    expect(resolved.origin).toBe('https://acme.example')
    expect(resolved.revision).toBe(1)
    expect(resolved.logo?.dark).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(resolved.logo?.light).toMatch(/^data:image\/png;base64,/)
    expect(resolved.background.dark).toMatch(/^data:image\/webp;base64,/)
    expect(resolved.copy.newChatHeading).toBe('What can Acme AI help with?')
  })

  it('rejects an asset whose bytes do not match its sha256', () => {
    const assets = assetsOf(fullDir)
    const doc = base()
    const logo = (theme(doc).logo as Record<string, { sha256: string }>).light
    const tampered = Buffer.from(assets.get(logo.sha256)!)
    tampered[tampered.length - 1] ^= 0xff
    assets.set(logo.sha256, tampered)
    expect(parseBrandTheme(doc, assets)).toEqual({ error: expect.stringContaining('sha256') })
  })

  it('rejects an asset over its size limit', () => {
    const doc = base()
    // A PNG header followed by padding: 1 MB + 1 byte, over the logo raster cap.
    const big = Buffer.alloc(1024 * 1024 + 1)
    const png = assetsOf(fullDir).get((theme(doc).logo as Record<string, { sha256: string }>).light.sha256)!
    png.copy(big, 0, 0, 33)
    const hash = sha(big)
    const light = (theme(doc).logo as Record<string, Record<string, unknown>>).light
    Object.assign(light, { sha256: hash, bytes: big.length })
    const assets = assetsOf(fullDir)
    assets.set(hash, big)
    expect(parseBrandTheme(doc, assets)).toEqual({ error: expect.stringContaining('larger') })
  })

  it('rejects a colour that is not lowercase #rrggbb', () => {
    for (const color of ['#FFFFFF', '#fff', 'red', '#ffffff80', 'rgb(0,0,0)', '#ffffff;}']) {
      const doc = base()
      ;((theme(doc).modes as Record<string, Record<string, string>>).dark).accent = color
      expect(parseBrandTheme(doc, assetsOf(fullDir)), color).toEqual({ error: expect.stringContaining('accent') })
    }
  })

  it('ignores unknown keys at every level', () => {
    const doc = base()
    doc.future = { anything: true }
    theme(doc).fonts = { body: 'Inter' }
    ;(theme(doc).modes as Record<string, Record<string, string>>).dark['chart.9'] = 'not a colour'
    ;(theme(doc).copy as Record<string, string>).footer = 'x'
    expect(ok(parseBrandTheme(doc, assetsOf(fullDir))).name).toBe('Acme')
  })

  it('rejects a logo block with a null mode, but reads a null background mode as flat', () => {
    const noLogo = base()
    ;(theme(noLogo).logo as Record<string, unknown>).light = null
    expect(parseBrandTheme(noLogo, assetsOf(fullDir))).toHaveProperty('error')

    const flatLight = base()
    ;(theme(flatLight).background as Record<string, unknown>).light = null
    const parsed = ok(parseBrandTheme(flatLight, assetsOf(fullDir)))
    expect(parsed.background.light).toBeNull()
    expect(parsed.background.dark?.mime).toBe('image/webp')
  })

  it('reads an absent background block as flat in both modes', () => {
    const doc = base()
    delete theme(doc).background
    expect(ok(parseBrandTheme(doc, assetsOf(fullDir))).background).toEqual({ dark: null, light: null })
  })

  it('rejects a declared type that differs from the sniffed one', () => {
    const doc = base()
    ;(theme(doc).logo as Record<string, Record<string, unknown>>).light.type = 'image/webp'
    expect(parseBrandTheme(doc, assetsOf(fullDir))).toHaveProperty('error')
  })

  it('rejects a heading over 60 code points or with a bidi control, and an empty name', () => {
    const long = base()
    ;(theme(long).copy as Record<string, string>).newChatHeading = 'x'.repeat(61)
    expect(parseBrandTheme(long, assetsOf(fullDir))).toHaveProperty('error')

    const astral = base()
    ;(theme(astral).copy as Record<string, string>).newChatHeading = '😀'.repeat(60)
    expect(parseBrandTheme(astral, assetsOf(fullDir))).toHaveProperty('ok')

    const bidi = base()
    ;(theme(bidi).copy as Record<string, string>).newChatHeading = 'abc‮def'
    expect(parseBrandTheme(bidi, assetsOf(fullDir))).toHaveProperty('error')

    const empty = base()
    theme(empty).name = '  '
    expect(parseBrandTheme(empty, assetsOf(fullDir))).toHaveProperty('error')
  })

  it('never puts a URL in an error', () => {
    const doc = base()
    ;(theme(doc).logo as Record<string, Record<string, unknown>>).dark.sha256 = 'f'.repeat(64)
    const result = parseBrandTheme(doc, assetsOf(fullDir))
    expect(result).toHaveProperty('error')
    expect('error' in result ? result.error : '').not.toMatch(/\/api\/|https?:/)
  })
})
