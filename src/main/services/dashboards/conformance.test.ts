import { describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync, realpathSync, type Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The desktop's component validator against the kit's conformance cases
 * (`conformance/dashboards/*`, matching rules in `conformance/README.md`
 * "Dashboard components"): errors are the exact set of `(path, code, field)`
 * triples, `warnings` each match some warning on the keys they give, and
 * `no_warnings` match none. Expectations only `--run` produces are left out:
 * the desktop runs a source when the user asks, never to validate.
 */

vi.mock('../../host/runtimeHost', () => ({
  runtimeHost: { isPackaged: false, getAppPath: () => process.cwd(), resourcesPath: '', getPath: () => '/nonexistent' }
}))
vi.mock('../../logger/logger', () => ({ createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }))

const { checkComponentFolder, readAgentManifest, readCommandNames } = await import('./componentScanner')

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const casesDir = join(repoRoot, 'resources/cinna-agent-kit/conformance/dashboards')

/** Codes only a `--run` reports. */
const RUN_ONLY_CODES = new Set(['run_failed', 'run_output_invalid', 'shape_invalid', 'id_missing', 'source_file_unwritten', 'runtime_missing', 'uv_missing'])

interface Triple {
  path?: string
  code?: string
  field?: string | null
}
interface Case {
  description: string
  component: string
  run: boolean
  expect: { errors: Triple[]; warnings?: Triple[]; no_warnings?: Triple[] }
}

const cases: Array<{ name: string; spec: Case }> = (readdirSync(casesDir, { withFileTypes: true }) as Dirent[])
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({ name: entry.name, spec: JSON.parse(readFileSync(join(casesDir, entry.name, 'case.json'), 'utf8')) as Case }))
  .sort((a, b) => a.name.localeCompare(b.name))

const key = (t: Triple): string => JSON.stringify([t.path, t.code, t.field ?? null])
const matches = (expected: Triple, actual: Triple): boolean =>
  (Object.keys(expected) as Array<keyof Triple>).every((k) => (expected[k] ?? null) === (actual[k] ?? null))

function check(name: string, spec: Case) {
  const agentDir = realpathSync(join(casesDir, name))
  return checkComponentFolder(realpathSync(join(agentDir, spec.component)), {
    agentDir,
    shownDir: spec.component,
    manifest: readAgentManifest(agentDir),
    commandNames: readCommandNames(agentDir)
  }).findings
}

describe('dashboards conformance cases', () => {
  it('finds the cases', () => {
    expect(cases.length).toBeGreaterThan(20)
  })

  it.each(cases)('$name', ({ name, spec }) => {
    const findings = check(name, spec)
    const errors = findings.filter((f) => f.severity === 'error').map((f) => ({ path: f.path, code: f.code, field: f.field }))
    const warnings = findings.filter((f) => f.severity === 'warning')
    const expectedErrors = spec.expect.errors.filter((t) => !RUN_ONLY_CODES.has(t.code ?? ''))
    expect(new Set(errors.map(key))).toEqual(new Set(expectedErrors.map(key)))
    for (const expected of (spec.expect.warnings ?? []).filter((t) => !RUN_ONLY_CODES.has(t.code ?? ''))) {
      expect(warnings.some((w) => matches(expected, w)), `warning ${key(expected)}`).toBe(true)
    }
    for (const unexpected of spec.expect.no_warnings ?? []) {
      expect(warnings.some((w) => matches(unexpected, w)), `no warning ${key(unexpected)}`).toBe(false)
    }
  })
})
