import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUNTIME_PINS } from '../../../../../shared/runtimePins'
import { CODEX_CONTRACT, CODEX_CONTRACT_AREAS, type ContractArea, type ContractEntry } from './codex.contract'
import { CLAUDE_CONTRACT, CLAUDE_CONTRACT_AREAS } from './claude.contract'
import { CLAUDE_INTERFACE_DOC, CODEX_INTERFACE_DOC, claudeContractDocInput, codexContractDocInput, renderContractDoc } from './contractDocs'

/**
 * The interface-contract ratchet — the part of the contract that runs in
 * `npm test`, on every machine, with no binary.
 *
 * The contract tests themselves (`codex.contract.test.ts`,
 * `claude.contract.test.ts`) need the real managed CLI and run on demand. What can rot *between* those runs is the
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

/** One engine's contract, as the ratchet needs it. A third engine is a third row. */
interface Ratcheted {
  tool: 'codex' | 'claude'
  label: string
  entries: readonly ContractEntry[]
  areas: readonly ContractArea[]
  pin: { cli: string; versionOutput: string; adapter: string }
  doc: string
  render(): string
  links: [file: string, link: string][]
}

const ENGINES: Ratcheted[] = [
  {
    tool: 'codex', label: 'Codex', entries: CODEX_CONTRACT, areas: CODEX_CONTRACT_AREAS, pin: RUNTIME_PINS.codex, doc: CODEX_INTERFACE_DOC,
    render: () => renderContractDoc(codexContractDocInput(RUNTIME_PINS, CODEX_CONTRACT, CODEX_CONTRACT_AREAS)),
    links: [['docs/README.md', 'agents/local_agents/contracts/codex_interface.md'], ['docs/agents/local_agents/acp_contract.md', 'contracts/codex_interface.md']]
  },
  {
    tool: 'claude', label: 'Claude', entries: CLAUDE_CONTRACT, areas: CLAUDE_CONTRACT_AREAS, pin: RUNTIME_PINS.claude, doc: CLAUDE_INTERFACE_DOC,
    render: () => renderContractDoc(claudeContractDocInput(RUNTIME_PINS, CLAUDE_CONTRACT, CLAUDE_CONTRACT_AREAS)),
    links: [['docs/README.md', 'agents/local_agents/contracts/claude_interface.md'], ['docs/agents/local_agents/acp_contract.md', 'contracts/claude_interface.md']]
  }
]

/**
 * Every id a contract test claims, from the `entry('<id>')` that titles it, and
 * whether that test is skipped. `it.skip` is how a `live` entry is written — and
 * the only thing it may be used for.
 */
function testedIds(tool: string): { id: string; skipped: boolean }[] {
  const source = readFileSync(join(here, `${tool}.contract.test.ts`), 'utf8')
  return [...source.matchAll(/\bit(\.skip)?\(\s*entry\('([^']+)'\)/g)].map((match) => ({ id: match[2], skipped: match[1] !== undefined }))
}

describe.each(ENGINES)('$label interface contract — registry ratchet', (engine) => {
  const ids = engine.entries.map((entry) => entry.id)

  it('finds the repository root and the contract tests', () => {
    // A wrong root makes every owner "missing", or — worse — a wrong test path
    // finds zero ids and the next check compares nothing with nothing.
    expect(existsSync(join(repoRoot, 'package.json'))).toBe(true)
    expect(testedIds(engine.tool).length).toBeGreaterThan(10)
    expect(engine.entries.length).toBeGreaterThan(10)
  })

  it('every registry id is unique and well-formed', () => {
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([])
    const shape = new RegExp(`^${engine.tool}\\.[a-z]+(\\.[a-z0-9-]+)+$`)
    expect(ids.filter((id) => !shape.test(id))).toEqual([])
  })

  it('every registry id has exactly one contract test titled with it, and no test is left over', () => {
    const tested = testedIds(engine.tool).map((test) => test.id)
    expect(ids.filter((id) => !tested.includes(id)), 'registry entries with no contract test').toEqual([])
    expect(tested.filter((id) => !ids.includes(id)), 'contract tests for ids the registry does not have').toEqual([])
    expect(tested.filter((id, index) => tested.indexOf(id) !== index), 'ids tested twice').toEqual([])
  })

  it('a test is skipped exactly when its entry is tagged `live`, and a live entry says why', () => {
    // Both directions. A skipped test for an ordinary entry reads as "checked"
    // in the generated doc for ever; a `live` entry with a running test is one
    // somebody faked a pass for.
    const live = engine.entries.filter((entry) => entry.live !== undefined)
    const skipped = testedIds(engine.tool).filter((test) => test.skipped).map((test) => test.id).sort()
    expect(skipped).toEqual(live.map((entry) => entry.id).sort())
    expect(live.filter((entry) => (entry.live ?? '').trim().length < 20).map((entry) => entry.id), 'live entries without a real reason').toEqual([])
  })

  it('every entry is filled in, in an area the doc renders', () => {
    const incomplete = engine.entries.filter((entry) =>
      !entry.name.trim() || !entry.expectation.trim() || !entry.feature.trim() || !entry.flow.trim() ||
      entry.owners.length === 0 || !engine.areas.includes(entry.area)
    ).map((entry) => entry.id)
    expect(incomplete).toEqual([])
  })

  it('every owner names a file that exists and a symbol that still appears in it', () => {
    const broken: string[] = []
    for (const entry of engine.entries) {
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
    const snapshot = join(here, 'snapshots', `${engine.tool}-${engine.pin.cli}.json`)
    expect(existsSync(snapshot), `run \`make contract-snapshot ENGINE=${engine.tool}\` to write ${snapshot}`).toBe(true)
    const parsed = JSON.parse(readFileSync(snapshot, 'utf8')) as { tool: string; version: string; adapter: string }
    expect(parsed).toMatchObject({ tool: engine.tool, version: engine.pin.versionOutput, adapter: engine.pin.adapter })
  })

  it('the generated interface doc is up to date with the registry', () => {
    const path = join(repoRoot, engine.doc)
    const current = existsSync(path) ? readFileSync(path, 'utf8') : null
    expect(current === engine.render(), `${engine.doc} is stale — run \`npm run contract:docs\``).toBe(true)
  })

  it('the doc is linked from the project index and from the ACP contract', () => {
    for (const [file, link] of engine.links) {
      expect(readFileSync(join(repoRoot, file), 'utf8').includes(link), `${file} does not link ${link}`).toBe(true)
    }
  })
})
