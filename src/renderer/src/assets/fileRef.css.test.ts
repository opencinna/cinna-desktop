import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The `.file-ref` rules in `main.css`. jsdom does not lay out, so these read the
 * stylesheet: the two properties that matter here are about layout cost, and a
 * regression in either is invisible until someone measures a wrapped link.
 */
const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/assets/main.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
)

const fileRefRules = [...css.matchAll(/([^{}]*code\.file-ref[^{}]*)\{([^}]*)\}/g)].map((match) => ({
  selector: match[1].trim().replace(/\s+/g, ' '),
  body: match[2]
}))

describe('.file-ref styles', () => {
  it('exist', () => {
    expect(fileRefRules.map((rule) => rule.selector)).toContain('.markdown-body code.file-ref')
  })

  it('break a wrapped link like plain inline code, with no cloned padding', () => {
    for (const rule of fileRefRules) expect(rule.body).not.toMatch(/box-decoration-break/)
  })

  it('edge the span in a neutral tone off its own fill, per theme, never in the accent', () => {
    const edges = fileRefRules.filter((rule) => /box-shadow|--file-ref-edge/.test(rule.body))
    expect(edges.length).toBeGreaterThan(0)
    for (const rule of edges) {
      const edgeLines = rule.body.split(';').filter((line) => /box-shadow|--file-ref-edge/.test(line))
      for (const line of edgeLines) expect(line).not.toMatch(/--color-accent/)
    }
    const light = fileRefRules.find((rule) => rule.selector === '[data-theme="light"] .markdown-body code.file-ref')
    expect(light?.body).toMatch(/--file-ref-edge:\s*color-mix\(in srgb, var\(--color-bg-hover\), (white|black) \d+%\)/)
    const base = fileRefRules.find((rule) => rule.selector === '.markdown-body code.file-ref')
    expect(base?.body).toMatch(/box-shadow:\s*inset 0 0 0 1px var\(--file-ref-edge\)/)
  })

  it('keep the plain inline-code fill, with no gradient or background of their own', () => {
    for (const rule of fileRefRules) expect(rule.body).not.toMatch(/background|gradient/)
  })

  it('darken or lighten the edge on hover through its own variable, defined in both themes', () => {
    const hover = fileRefRules.find((rule) => rule.selector === '.markdown-body code.file-ref:hover')
    expect(hover?.body).toMatch(/box-shadow:\s*inset 0 0 0 1px var\(--file-ref-edge-hover\)/)
    for (const selector of ['.markdown-body code.file-ref', '[data-theme="light"] .markdown-body code.file-ref']) {
      const body = fileRefRules.find((rule) => rule.selector === selector)?.body ?? ''
      expect(body).toMatch(/--file-ref-edge:\s*color-mix\(/)
      expect(body).toMatch(/--file-ref-edge-hover:\s*color-mix\(/)
    }
  })

  it('give keyboard focus its own outline, apart from hover', () => {
    const focus = fileRefRules.find((rule) => rule.selector === '.markdown-body code.file-ref:focus-visible')
    expect(focus?.body).toMatch(/outline:\s*2px solid var\(--color-accent\)/)
    expect(focus?.body).toMatch(/outline-offset:\s*1px/)
    for (const rule of fileRefRules) {
      if (rule.selector.includes(':hover')) {
        expect(rule.selector).not.toContain(':focus-visible')
        expect(rule.body).not.toMatch(/outline/)
      }
    }
  })
})

/** Every rule in the sheet, one entry per selector of a selector list. */
const allRules = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)].flatMap((match) =>
  match[1].split(',').map((selector) => ({ selector: selector.trim().replace(/\s+/g, ' '), body: match[2] }))
)

describe('file preview zebra rows', () => {
  const stripe = /background(-color)?:\s*color-mix\(in srgb, var\(--color-bg-secondary\), black [\d.]+%\)/

  it('stripe the csv table and a previewed markdown table from the first body row, in both themes', () => {
    for (const scope of ['.file-preview-table', '.file-preview-markdown']) {
      const dark = allRules.find((rule) => rule.selector === `${scope} tbody tr:nth-child(odd) td`)
      expect(dark?.body).toMatch(stripe)
      const light = allRules.find((rule) => rule.selector === `[data-theme="light"] ${scope} tbody tr:nth-child(odd) td`)
      expect(light?.body).toMatch(stripe)
      expect(light?.body.match(stripe)?.[0]).not.toBe(dark?.body.match(stripe)?.[0])
    }
  })

  it('stripe no other table, the chat’s markdown included', () => {
    const striped = allRules.filter((rule) => /tr:nth-(child|of-type)\(/.test(rule.selector))
    expect(striped.length).toBeGreaterThan(0)
    for (const rule of striped) {
      expect(rule.selector).toMatch(/^(\[data-theme="light"\] )?\.file-preview-(table|markdown) /)
      expect(rule.selector).toContain(':nth-child(odd)')
    }
  })
})
