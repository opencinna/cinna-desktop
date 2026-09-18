/**
 * Renders an interface-contract registry as its generated doc.
 *
 * Pure, and shared on purpose: `scripts/generate-contract-docs.mjs` writes the
 * file with it and `contractRegistry.test.ts` compares the file against it, so
 * "the doc is stale" is decided by the same code that would regenerate it.
 *
 * Loaded by a type-stripping Node from that script — so a **type-only** import
 * (erased entirely) and nothing else.
 */
import type { ContractArea, ContractEntry } from './codex.contract'

export interface ContractDocInput {
  /** `Codex`, `Claude Code`. */
  toolName: string
  cliVersion: string
  adapterPackage: string
  adapterVersion: string
  /** Repo-relative, for the "generated from" line. */
  registryPath: string
  testPath: string
  snapshotPath: string
  areas: readonly ContractArea[]
  entries: readonly ContractEntry[]
}

/** A table cell: pipes escaped, newlines flattened. */
const cell = (text: string): string => text.replaceAll('|', '\\|').replaceAll('\n', ' ')

/** `src/a/b.ts#symbol` → `` `b.ts` `symbol` `` linked to the file, relative to `docs/agents/local_agents/contracts/`. */
function owner(reference: string): string {
  const [file, symbol] = reference.split('#')
  const name = file.split('/').pop() ?? file
  return `[\`${name}\`](../../../../${file}) \`${symbol}\``
}

export function renderContractDoc(input: ContractDocInput): string {
  const lines: string[] = [
    `# ${input.toolName} Interface Contract`,
    '',
    `<!-- GENERATED from ${input.registryPath} by scripts/generate-contract-docs.mjs — do not edit. Run \`npm run contract:docs\`. -->`,
    '',
    `Every external interface of ${input.toolName} that Cinna relies on, one entry each: what the tool must do, which Cinna code depends on it, and what the user loses when it stops. **Verified against ${input.toolName} CLI ${input.cliVersion} with \`${input.adapterPackage}\` ${input.adapterVersion}** — the versions pinned in \`src/shared/runtimePins.ts\`.`,
    '',
    `Each entry has exactly one test, titled with its id, in [\`${input.testPath.split('/').pop()}\`](../../../../${input.testPath}). They run the real pinned binary and the real patched adapter over stdio against a loopback fake provider — no login, no provider request — with \`npm run test:contract\` (\`make contract ENGINE=codex\` installs the binary first). They are not part of \`npm test\`.`,
    '',
    `The raw shapes a run observes are compared with the committed [\`${input.snapshotPath.split('/').pop()}\`](../../../../${input.snapshotPath}), and a difference fails the run; \`make contract-snapshot ENGINE=codex\` rewrites it once a change is understood. To evaluate a new release, \`make contract-next ENGINE=codex VERSION=<x.y.z>\` runs the same tests against that version without changing the pin; red entries name their owners below, and the run prints the diff between the pinned snapshot and the candidate's (written to a temp path, never into the tree) — that diff is what changed.`,
    '',
    'Hand-written evidence and reasoning stay in [The ACP Engine Contract](../acp_contract.md) and [The Codex Engine — Technical Details](../codex_engine_tech.md); this file is only the index of what is checked.',
    ''
  ]
  for (const area of input.areas) {
    const entries = input.entries.filter((entry) => entry.area === area)
    if (entries.length === 0) continue
    lines.push(`## ${area.charAt(0).toUpperCase()}${area.slice(1)}`, '')
    lines.push('| Id | Surface | Expectation | Owners | Feature at risk | Flow step |', '|---|---|---|---|---|---|')
    for (const entry of entries) {
      lines.push(`| \`${entry.id}\` | ${cell(entry.surface)}: \`${cell(entry.name)}\` | ${cell(entry.expectation)} | ${entry.owners.map(owner).join('<br>')} | ${cell(entry.feature)} | ${cell(entry.flow)} |`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

export const CODEX_INTERFACE_DOC = 'docs/agents/local_agents/contracts/codex_interface.md'

/**
 * The Codex doc's parameters. Takes the pins and the registry as arguments so
 * this module needs no runtime import: the script and the ratchet each import
 * those their own way and both get the same document.
 */
export function codexContractDocInput(
  pins: { codex: { cli: string; adapter: string } },
  entries: readonly ContractEntry[],
  areas: readonly ContractArea[]
): ContractDocInput {
  return {
    toolName: 'Codex',
    cliVersion: pins.codex.cli,
    adapterPackage: '@agentclientprotocol/codex-acp',
    adapterVersion: pins.codex.adapter,
    registryPath: 'src/main/agents/drivers/acp/contracts/codex.contract.ts',
    testPath: 'src/main/agents/drivers/acp/contracts/codex.contract.test.ts',
    snapshotPath: `src/main/agents/drivers/acp/contracts/snapshots/codex-${pins.codex.cli}.json`,
    areas,
    entries
  }
}
