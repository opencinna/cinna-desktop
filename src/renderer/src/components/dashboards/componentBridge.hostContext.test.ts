import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOST_COMPUTED_SOURCES, HOST_VARIABLE_SOURCES, readHostContext } from './componentBridge'

/**
 * The `--cinna-*` variables the host sends a dashboard frame: every name the
 * design pack, its example and the kit's template read, each with a value the
 * frame can use (no `var()`, which means nothing there).
 */

const repo = process.cwd()
const read = (...path: string[]): string => readFileSync(join(repo, ...path), 'utf8')

/**
 * Every `var(--cinna-…)` a file reads. A name built in a template
 * (`var(--cinna-chart-${slot})` in charts.js) stops at the `-`: it stands for
 * the eight palette slots.
 */
function cinnaNames(text: string): string[] {
  return [...text.matchAll(/var\(\s*(--cinna-[a-z0-9-]+)/g)].flatMap((m) =>
    m[1].endsWith('-') ? Array.from({ length: 8 }, (_, i) => `${m[1]}${i + 1}`) : [m[1]]
  )
}

const READERS: Record<string, string> = {
  'pack ui.css': read('resources', 'dashboard-design', 'ui.css'),
  'pack charts.js': read('resources', 'dashboard-design', 'charts.js'),
  'pack example': read('resources', 'dashboard-design', 'example', 'index.html'),
  'kit template style.css': read('resources', 'cinna-agent-kit', 'templates', 'dashboard-html', 'style.css')
}

/** The declarations of one theme block of main.css, as the app's root carries them. */
function themeBlock(selector: string): Array<[string, string]> {
  const css = read('src', 'renderer', 'src', 'assets', 'main.css')
  const start = css.indexOf(`${selector} {`)
  expect(start, selector).toBeGreaterThan(-1)
  const body = css.slice(start, css.indexOf('\n  }', start))
  return [...body.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()])
}

/** One theme's declarations: the dark root, with the light block over it for light. */
function declarations(selector: string): Map<string, string> {
  const dark = ':root, [data-theme="dark"]'
  return new Map([...themeBlock(dark), ...(selector === dark ? [] : themeBlock(selector))])
}

/**
 * Chromium's (Electron's) substitution of `var()` inside a custom property
 * when it is read: `--color-highlight-tint` reads back as
 * `color-mix(in srgb, #a78bfa 26%, #0f0f0f)`. jsdom substitutes nothing, so
 * `chromium` stands in for it by writing the substituted values.
 */
function substitute(value: string, all: Map<string, string>, depth = 0): string {
  if (depth > 8) return ''
  return value.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, name: string) => substitute(all.get(name) ?? '', all, depth + 1))
}

function applyTheme(selector: string, { chromium = true }: { chromium?: boolean } = {}): void {
  const root = document.documentElement
  const all = declarations(selector)
  for (const [name, value] of all) root.style.setProperty(name, chromium ? substitute(value, all) : value)
  root.style.setProperty('--font-code', "'SF Mono', 'Fira Code', 'Cascadia Code', monospace")
  document.body.style.setProperty('font-family', '-apple-system, BlinkMacSystemFont, sans-serif')
}

afterEach(() => {
  document.documentElement.removeAttribute('style')
  document.body.removeAttribute('style')
})

describe('readHostContext', () => {
  it.each([['dark', ':root, [data-theme="dark"]'], ['light', '[data-theme="light"]']] as const)(
    'sends every --cinna-* name the pack, its example and the kit template read (%s), with no var() left',
    (theme, selector) => {
      applyTheme(selector)
      const { theme: sent, styles } = readHostContext(theme)
      expect(sent).toBe(theme)
      for (const [reader, text] of Object.entries(READERS)) {
        const names = cinnaNames(text)
        // The example reads its colours through the pack's classes; the others name tokens themselves.
        if (reader !== 'pack example') expect(names.length, reader).toBeGreaterThan(0)
        for (const name of names) expect(styles.variables[name], `${reader} reads ${name}`).toBeTruthy()
      }
      for (const [name, value] of Object.entries(styles.variables)) expect(value, name).not.toContain('var(')
      // The tint is a color-mix of two app variables: sent as Chromium reads it, both substituted.
      expect(styles.variables['--cinna-highlight-tint']).toMatch(/^color-mix\(in srgb, #[0-9a-f]+ \d+%, #[0-9a-f]+\)$/)
    }
  )

  it('sends the kit names, the pack names and the old desktop names, from main.css', () => {
    applyTheme('[data-theme="light"]')
    const { variables } = readHostContext('light').styles
    expect(variables).toMatchObject({
      '--cinna-bg': '#ffffff',
      '--cinna-fg': '#1a1a1a',
      '--cinna-muted': '#8a8a8a',
      '--cinna-highlight-tint': 'color-mix(in srgb, #7c3aed 12%, #ffffff)',
      '--cinna-surface': '#f5f5f5',
      '--cinna-grid': '#eeeeee',
      '--cinna-axis': '#d4d4d4',
      '--cinna-chart-1': '#2e88b8',
      '--cinna-chart-8': '#e34948',
      '--cinna-chart-pos': '#2a78d6',
      '--cinna-seq': '#2e88b8',
      '--cinna-font': '-apple-system, BlinkMacSystemFont, sans-serif',
      '--cinna-font-mono': "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
      '--cinna-text': '#1a1a1a',
      '--cinna-text-secondary': '#555',
      '--cinna-text-muted': '#999',
      '--cinna-bg-secondary': '#f5f5f5',
      '--cinna-bg-tertiary': '#ebebeb'
    })
    expect(Object.keys(variables).sort()).toEqual([...Object.keys(HOST_VARIABLE_SOURCES), ...Object.keys(HOST_COMPUTED_SOURCES)].sort())
  })

  it('sends the dashboard muted grey, not the app muted text, in both themes', () => {
    applyTheme('[data-theme="light"]')
    expect(readHostContext('light').styles.variables).toMatchObject({ '--cinna-muted': '#8a8a8a', '--cinna-text-muted': '#999' })
    applyTheme(':root, [data-theme="dark"]')
    expect(readHostContext('dark').styles.variables).toMatchObject({ '--cinna-muted': '#666', '--cinna-text-muted': '#666' })
  })

  it('drops a value that is empty or still holds var(), and sends the rest as read', () => {
    applyTheme(':root, [data-theme="dark"]', { chromium: false })
    document.documentElement.style.setProperty('--color-accent', '  ')
    const { variables } = readHostContext('dark').styles
    expect(variables['--cinna-highlight-tint']).toBeUndefined()
    expect(variables['--cinna-accent']).toBeUndefined()
    expect(variables['--cinna-bg']).toBe('#0f0f0f')
  })
})
