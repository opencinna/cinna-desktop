import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Guards against the class of bug where an IPC module exports a
 * `register*Handlers()` function but it never gets invoked — which silently
 * leaves whole channel groups unhandled at runtime (e.g. the `sync:*` channels
 * that shipped unregistered until wired into `registerAllIpcHandlers`).
 *
 * A registrar counts as wired if it's CALLED anywhere in the registration tree
 * — directly in `index.ts` or indirectly by another registrar (e.g.
 * `registerAgentHandlers` calls `registerA2AHandlers`). We verify a call-site
 * exists in some file OTHER than the registrar's own definition file (so the
 * `export function name(): void` signature doesn't count as its own call).
 */
const ipcDir = dirname(fileURLToPath(import.meta.url))

const ipcFiles = readdirSync(ipcDir).filter((f) => f.endsWith('.ipc.ts'))
const sources = new Map<string, string>(
  [...ipcFiles, 'index.ts'].map((f) => [f, readFileSync(join(ipcDir, f), 'utf8')])
)

function exportedRegistrars(): { file: string; name: string }[] {
  const out: { file: string; name: string }[] = []
  for (const file of ipcFiles) {
    for (const m of (sources.get(file) as string).matchAll(
      /export function (register\w*Handlers)\s*\(/g
    )) {
      out.push({ file, name: m[1] })
    }
  }
  return out
}

describe('IPC handler registration', () => {
  const registrars = exportedRegistrars()

  it('discovers the registrar functions', () => {
    expect(registrars.length).toBeGreaterThan(5)
  })

  it.each(registrars)('$name is invoked somewhere in the registration tree', ({ file, name }) => {
    const call = new RegExp(`${name}\\s*\\(\\s*\\)`)
    const wiredElsewhere = [...sources.entries()].some(
      ([f, src]) => f !== file && call.test(src)
    )
    expect(wiredElsewhere, `${name} is exported but never called outside ${file}`).toBe(true)
  })

  it('reaches every registrar transitively from registerAllIpcHandlers', () => {
    // index.ts must call registerAllIpcHandlers' members; walk the call graph
    // starting from index.ts and confirm every registrar is reachable.
    const reachable = new Set<string>()
    const indexSrc = sources.get('index.ts') as string
    const frontier: string[] = registrars
      .filter((r) => new RegExp(`${r.name}\\s*\\(\\s*\\)`).test(indexSrc))
      .map((r) => r.name)
    while (frontier.length) {
      const name = frontier.pop() as string
      if (reachable.has(name)) continue
      reachable.add(name)
      const defFile = registrars.find((r) => r.name === name)?.file
      if (!defFile) continue
      const body = sources.get(defFile) as string
      for (const other of registrars) {
        if (!reachable.has(other.name) && new RegExp(`${other.name}\\s*\\(\\s*\\)`).test(body)) {
          frontier.push(other.name)
        }
      }
    }
    const orphans = registrars.map((r) => r.name).filter((n) => !reachable.has(n))
    expect(orphans, `unreachable from registerAllIpcHandlers: ${orphans.join(', ')}`).toEqual([])
  })
})
