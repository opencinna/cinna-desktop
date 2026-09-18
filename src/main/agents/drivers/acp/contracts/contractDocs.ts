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
import type { ContractArea, ContractEntry, ContractFlow } from './codex.contract'

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
  /** Which Level 2 variants walk those steps **for this engine** — a markdown sentence. The no-billing spec does not cover every engine. */
  flowVariants: string
  /** The Level 2 steps and what each is, `none` excluded — `FLOW_STEPS`, passed in because this module imports nothing at runtime. */
  flowSteps: readonly (readonly [string, string])[]
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

/** `A, B — note`, or `— note` when no step covers the entry. */
function flowCell(flow: ContractFlow): string {
  const steps = flow.steps.filter((step) => step !== 'none')
  const head = steps.length > 0 ? `**${steps.join(', ')}**` : '—'
  return flow.note ? `${head} ${steps.length > 0 ? '— ' : ''}${cell(flow.note)}` : head
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
  lines.push(
    `**Flow step** names the step of the Level 2 whole flow that exercises the entry — ${input.flowSteps.map(([step, what]) => `**${step}** ${what}`).join('; ')}. A dash means no step does, and the note says why. ${input.flowVariants}`,
    ''
  )
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
      lines.push(`| \`${entry.id}\` | ${cell(entry.surface)}: \`${cell(entry.name)}\` | ${cell(expectation)} | ${entry.owners.map(owner).join('<br>')} | ${cell(entry.feature)} | ${flowCell(entry.flow)} |`)
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
  areas: readonly ContractArea[],
  steps: Readonly<Record<string, string>>
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
    flowSteps: Object.entries(steps).filter(([step]) => step !== 'none'),
    engine: 'codex',
    flowVariants: 'Two variants walk the same steps: `make e2e-one SPEC=runtime-flow` (the built app and the real pinned CLI against a loopback fake provider, no billing, opt-in) and `make live-flow ENGINE=codex` (the user’s real login, billed, manual).',
    adapterPhrase: 'real patched adapter',
    evidenceLinks: '[The ACP Engine Contract](../acp_contract.md) and [The Codex Engine — Technical Details](../codex_engine_tech.md)'
  }
}

export const CLAUDE_INTERFACE_DOC = 'docs/agents/local_agents/contracts/claude_interface.md'

/** The Claude doc's parameters, on the same terms. */
export function claudeContractDocInput(
  pins: { claude: { cli: string; adapter: string } },
  entries: readonly ContractEntry[],
  areas: readonly ContractArea[],
  steps: Readonly<Record<string, string>>
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
    flowSteps: Object.entries(steps).filter(([step]) => step !== 'none'),
    engine: 'claude',
    flowVariants: 'For Claude Code only the billed variant walks them: `make live-flow ENGINE=claude` (the user’s real login, manual). The no-billing `e2e/specs/runtime-flow.spec.ts` covers Codex alone — Cinna strips `ANTHROPIC_BASE_URL` and the key variables from every Claude child by design, so an app-spawned session cannot be sent to a fake provider without a new production seam.',
    adapterPhrase: 'real adapter',
    evidenceLinks: '[The ACP Engine Contract](../acp_contract.md) and [The Claude Engine Contract](../claude_contract.md)'
  }
}
