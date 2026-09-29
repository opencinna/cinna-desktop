import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, type Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateManifest, type ValidationReport } from './validator'

/**
 * The contract's conformance set (`conformance/manifests/*.json`, shipped in the
 * bundle since contract 1.5.0): manifests with the findings every validator of
 * the contract must report. `kit.py` runs the same set, so the desktop and
 * `kit.py` cannot disagree about a manifest without one of them failing.
 *
 * The matching rule is `conformance/README.md`'s:
 * - `errors`: the set of error paths equals this set exactly;
 * - `warnings`: every listed path is among the warning paths;
 * - `no_warnings`: no listed path is among the warning paths.
 *
 * **Finding code → field path.** Drop the `manifest.` prefix, then keep the
 * longest run of leading segments that names a field in the bundled schema
 * (object `properties`, through array `items`); what follows is a sub-code
 * (`slug.missing` → `slug`, `runtime.engine.type` → `runtime.engine`). The
 * schema is the oracle, so no code is special-cased here — a finding whose code
 * does not name its field is a validator bug, fixed in the validator. Codes
 * outside `manifest.` (`cloud.*`, `contract.*`) name no manifest field and
 * report no path.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const bundle = join(repoRoot, 'resources/cinna-agent-kit')
const casesDir = join(bundle, 'conformance/manifests')
const CONTRACT_VERSION = readFileSync(join(bundle, 'CONTRACT_VERSION'), 'utf8').trim()

type SchemaNode = { properties?: Record<string, SchemaNode>; items?: SchemaNode }
const schema = JSON.parse(readFileSync(join(bundle, 'schema/cinna-agent.schema.json'), 'utf8')) as SchemaNode

interface ConformanceCase {
  description: string
  manifest: unknown
  expect: { errors?: string[]; warnings?: string[]; no_warnings?: string[] }
}

function fieldPath(code: string): string | null {
  if (!code.startsWith('manifest.')) return null
  const path: string[] = []
  let node: SchemaNode | undefined = schema
  for (const segment of code.slice('manifest.'.length).split('.')) {
    const properties: Record<string, SchemaNode> | undefined = node?.properties ?? node?.items?.properties
    if (!properties || !Object.hasOwn(properties, segment)) break
    path.push(segment)
    node = properties[segment]
  }
  return path.join('.')
}

function paths(findings: ValidationReport['errors']): Set<string> {
  const out = new Set<string>()
  for (const finding of findings) {
    const path = fieldPath(finding.code)
    if (path !== null) out.add(path)
  }
  return out
}

const entries: Dirent[] = readdirSync(casesDir, { withFileTypes: true })
const files = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
  .map((entry) => entry.name)
  .sort()

describe('the contract conformance set', () => {
  it('is not empty — an empty set would pass every validator', () => {
    expect(files.length, `no conformance cases under ${casesDir}; re-run \`make kit-sync\``).toBeGreaterThan(0)
  })

  it('derives field paths from codes through the schema', () => {
    expect(fieldPath('manifest.slug.missing')).toBe('slug')
    expect(fieldPath('manifest.runtime.engine')).toBe('runtime.engine')
    expect(fieldPath('manifest.runtime.engine.type')).toBe('runtime.engine')
    expect(fieldPath('manifest.handovers.target_kind.coordinator_target')).toBe('handovers.target_kind')
    expect(fieldPath('cloud.unroutable')).toBeNull()
  })

  it.each(files)('%s', (file) => {
    const testCase = JSON.parse(readFileSync(join(casesDir, file), 'utf8')) as ConformanceCase
    const report = validateManifest(testCase.manifest, { contractVersion: CONTRACT_VERSION })
    const errors = paths(report.errors)
    const warnings = paths(report.warnings)
    const context = `${testCase.description}\nerrors: ${JSON.stringify(report.errors)}\nwarnings: ${JSON.stringify(report.warnings)}`

    if (testCase.expect.errors) {
      expect([...errors].sort(), context).toEqual([...testCase.expect.errors].sort())
    }
    for (const path of testCase.expect.warnings ?? []) {
      expect(warnings.has(path), `expected a warning at ${path}\n${context}`).toBe(true)
    }
    for (const path of testCase.expect.no_warnings ?? []) {
      expect(warnings.has(path), `expected no warning at ${path}\n${context}`).toBe(false)
    }
  })
})
