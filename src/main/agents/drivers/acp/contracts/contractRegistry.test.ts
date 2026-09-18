import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUNTIME_PINS } from '../../../../../shared/runtimePins'
import { CODEX_CONTRACT, CODEX_CONTRACT_AREAS } from './codex.contract'
import { CODEX_INTERFACE_DOC, codexContractDocInput, renderContractDoc } from './contractDocs'

/**
 * The interface-contract ratchet — the part of the contract that runs in
 * `npm test`, on every machine, with no binary.
 *
 * The contract tests themselves (`codex.contract.test.ts`) need the real
 * managed CLI and run on demand. What can rot *between* those runs is the
 * bookkeeping around them, and each of these is a way it does:
 *
 * - an entry added to the registry with no test, which then reads as "checked"
 *   in the generated doc for ever;
 * - a test left behind for an entry that was deleted or renamed;
 * - an `owners` reference to a file that moved or a symbol that was renamed —
 *   the one field whose whole job is to say where to look when a release turns
 *   an entry red, silently pointing at nothing;
 * - a pin bumped without its snapshot, so the next version has nothing to diff
 *   against;
 * - the generated doc drifting from the registry it is a view of.
 *
 * Read in Node, never through shell `grep`, for the reason `kindBranches.test.ts`
 * gives: the `grep` in this environment can silently miss matches, and a
 * ratchet built on a negative result from it is a guess.
 *
 * An owner's symbol is checked as a **literal occurrence** in its file, not as
 * a declaration: several owners are a string the code depends on
 * (`collaboration_mode`, `session/load`, `errorKind`) rather than an export.
 * That is weaker than resolving a symbol and catches what actually happens —
 * a rename, or the code moving to another file.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '../../../../../..')
const TEST_FILE = join(here, 'codex.contract.test.ts')

/** Every id a contract test claims, from the `entry('<id>')` that titles it. */
function testedIds(): string[] {
  const source = readFileSync(TEST_FILE, 'utf8')
  return [...source.matchAll(/\bit\(\s*entry\('([^']+)'\)/g)].map((match) => match[1])
}

describe('Codex interface contract — registry ratchet', () => {
  it('finds the repository root and the contract tests', () => {
    // A wrong root makes every owner "missing", or — worse — a wrong test path
    // finds zero ids and the next check compares nothing with nothing.
    expect(existsSync(join(repoRoot, 'package.json'))).toBe(true)
    expect(testedIds().length).toBeGreaterThan(10)
    expect(CODEX_CONTRACT.length).toBeGreaterThan(10)
  })

  it('every registry id is unique and well-formed', () => {
    const ids = CODEX_CONTRACT.map((entry) => entry.id)
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([])
    expect(ids.filter((id) => !/^codex\.[a-z]+(\.[a-z0-9-]+)+$/.test(id))).toEqual([])
  })

  it('every registry id has exactly one contract test titled with it, and no test is left over', () => {
    const ids = CODEX_CONTRACT.map((entry) => entry.id)
    const tested = testedIds()
    expect(ids.filter((id) => !tested.includes(id)), 'registry entries with no contract test').toEqual([])
    expect(tested.filter((id) => !ids.includes(id)), 'contract tests for ids the registry does not have').toEqual([])
    expect(tested.filter((id, index) => tested.indexOf(id) !== index), 'ids tested twice').toEqual([])
  })

  it('every entry is filled in, in an area the doc renders', () => {
    const incomplete = CODEX_CONTRACT.filter((entry) =>
      !entry.name.trim() || !entry.expectation.trim() || !entry.feature.trim() || !entry.flow.trim() ||
      entry.owners.length === 0 || !CODEX_CONTRACT_AREAS.includes(entry.area)
    ).map((entry) => entry.id)
    expect(incomplete).toEqual([])
  })

  it('every owner names a file that exists and a symbol that still appears in it', () => {
    const broken: string[] = []
    for (const entry of CODEX_CONTRACT) {
      for (const reference of entry.owners) {
        const [file, symbol, extra] = reference.split('#')
        if (!file || !symbol || extra !== undefined) { broken.push(`${entry.id}: "${reference}" is not file#symbol`); continue }
        const path = join(repoRoot, file)
        if (!existsSync(path)) { broken.push(`${entry.id}: ${file} does not exist`); continue }
        if (!readFileSync(path, 'utf8').includes(symbol)) broken.push(`${entry.id}: ${file} no longer contains "${symbol}"`)
      }
    }
    expect(broken).toEqual([])
  })

  it('the pinned version has its snapshot committed', () => {
    const snapshot = join(here, 'snapshots', `codex-${RUNTIME_PINS.codex.cli}.json`)
    expect(existsSync(snapshot), `run \`make contract-snapshot ENGINE=codex\` to write ${snapshot}`).toBe(true)
    const parsed = JSON.parse(readFileSync(snapshot, 'utf8')) as { tool: string; version: string; adapter: string }
    expect(parsed).toMatchObject({ tool: 'codex', version: RUNTIME_PINS.codex.versionOutput, adapter: RUNTIME_PINS.codex.adapter })
  })

  it('the generated interface doc is up to date with the registry', () => {
    const expected = renderContractDoc(codexContractDocInput(RUNTIME_PINS, CODEX_CONTRACT, CODEX_CONTRACT_AREAS))
    const path = join(repoRoot, CODEX_INTERFACE_DOC)
    const current = existsSync(path) ? readFileSync(path, 'utf8') : null
    expect(current === expected, `${CODEX_INTERFACE_DOC} is stale — run \`npm run contract:docs\``).toBe(true)
  })

  it('the doc is linked from the project index and from the ACP contract', () => {
    for (const [file, link] of [
      ['docs/README.md', 'agents/local_agents/contracts/codex_interface.md'],
      ['docs/agents/local_agents/acp_contract.md', 'contracts/codex_interface.md']
    ]) {
      expect(readFileSync(join(repoRoot, file), 'utf8').includes(link), `${file} does not link ${link}`).toBe(true)
    }
  })
})
