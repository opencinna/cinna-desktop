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
  /** `codex`, `claude` — the `ENGINE=` of every make target the doc names. */
  engine: string
  /** `real patched adapter` for Codex, whose adapter Cinna patches; `real adapter` otherwise. */
  adapterPhrase: string
  /** Where the hand-written evidence lives: a markdown sentence fragment of links. */
  evidenceLinks: string
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
    `Each entry has exactly one test, titled with its id, in [\`${input.testPath.split('/').pop()}\`](../../../../${input.testPath}). They run the real pinned binary and the ${input.adapterPhrase} over stdio against a loopback fake provider — no login, no provider request — with \`npm run test:contract\` (\`make contract ENGINE=${input.engine}\` installs the binary first). They are not part of \`npm test\`.`,
    '',
    `The raw shapes a run observes are compared with the committed [\`${input.snapshotPath.split('/').pop()}\`](../../../../${input.snapshotPath}), and a difference fails the run; \`make contract-snapshot ENGINE=${input.engine}\` rewrites it once a change is understood. To evaluate a new release, \`make contract-next ENGINE=${input.engine} VERSION=<x.y.z>\` runs the same tests against that version without changing the pin; red entries name their owners below, and the run prints the diff between the pinned snapshot and the candidate's (written to a temp path, never into the tree) — that diff is what changed.`,
    '',
    `Hand-written evidence and reasoning stay in ${input.evidenceLinks}; this file is only the index of what is checked.`,
    ''
  ]
  // Only when there is one to explain: a doc with no live entry stays as it was.
  if (input.entries.some((entry) => entry.live)) {
    lines.push('An entry marked **Live only** cannot be exercised against a fake provider — it needs a real login or the vendor’s servers. Its test is skipped, never faked, and the entry says why; it is checked by the live flow instead.', '')
  }
  for (const area of input.areas) {
    const entries = input.entries.filter((entry) => entry.area === area)
    if (entries.length === 0) continue
    lines.push(`## ${area.charAt(0).toUpperCase()}${area.slice(1)}`, '')
    lines.push('| Id | Surface | Expectation | Owners | Feature at risk | Flow step |', '|---|---|---|---|---|---|')
    for (const entry of entries) {
      const expectation = entry.live ? `**Live only.** ${entry.expectation} *Why not here:* ${entry.live}` : entry.expectation
      lines.push(`| \`${entry.id}\` | ${cell(entry.surface)}: \`${cell(entry.name)}\` | ${cell(expectation)} | ${entry.owners.map(owner).join('<br>')} | ${cell(entry.feature)} | ${cell(entry.flow)} |`)
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
    entries,
    engine: 'codex',
    adapterPhrase: 'real patched adapter',
    evidenceLinks: '[The ACP Engine Contract](../acp_contract.md) and [The Codex Engine — Technical Details](../codex_engine_tech.md)'
  }
}

export const CLAUDE_INTERFACE_DOC = 'docs/agents/local_agents/contracts/claude_interface.md'

/** The Claude doc's parameters, on the same terms. */
export function claudeContractDocInput(
  pins: { claude: { cli: string; adapter: string } },
  entries: readonly ContractEntry[],
  areas: readonly ContractArea[]
): ContractDocInput {
  return {
    toolName: 'Claude Code',
    cliVersion: pins.claude.cli,
    adapterPackage: '@agentclientprotocol/claude-agent-acp',
    adapterVersion: pins.claude.adapter,
    registryPath: 'src/main/agents/drivers/acp/contracts/claude.contract.ts',
    testPath: 'src/main/agents/drivers/acp/contracts/claude.contract.test.ts',
    snapshotPath: `src/main/agents/drivers/acp/contracts/snapshots/claude-${pins.claude.cli}.json`,
    areas,
    entries,
    engine: 'claude',
    adapterPhrase: 'real adapter',
    evidenceLinks: '[The ACP Engine Contract](../acp_contract.md) and [The Claude Engine Contract](../claude_contract.md)'
  }
}
