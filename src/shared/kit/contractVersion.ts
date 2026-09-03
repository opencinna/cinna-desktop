/**
 * The contract-version gate (`resources/cinna-kit-contract/CHANGELOG.md`,
 * "Compatibility"). A folder records the contract it was scaffolded against; a
 * tool records the contract it bundles. Comparing the two answers one question:
 * may this tool operate this folder?
 *
 * Rules, applied identically by the desktop, `kit.py validate` and cinna-core:
 *
 * | Folder vs. tool | Result |
 * |-----------------|--------|
 * | same major | `ok` — whatever the minor |
 * | folder major newer | `app_too_old` — "update the app", do not run it |
 * | folder major older | `migratable` — the changelog's Breaking entries apply |
 * | unparseable / absent | `unknown` — legacy folder, read it, ask for a re-stamp |
 *
 * Shared between main and renderer: pure, no dependencies.
 */

export interface SemVer {
  major: number
  minor: number
  patch: number
  /** Pre-release suffix without the leading `-`, if any. */
  prerelease?: string
  /** The string it was parsed from. */
  raw: string
}

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-.]+))?$/

/** Parse a semver string. Returns `null` for anything that is not one. */
export function parseSemver(value: unknown): SemVer | null {
  if (typeof value !== 'string') return null
  const match = SEMVER_PATTERN.exec(value.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
    raw: value.trim()
  }
}

/**
 * Order two versions: `-1` when `a` is older, `1` when newer, `0` when equal.
 * A pre-release sorts before the release it precedes (`1.1.0-rc.1` < `1.1.0`);
 * two pre-releases of the same version compare as strings, which is enough for
 * the "is the workshop copy newer than the bundled one" decision.
 */
export function compareSemver(a: SemVer, b: SemVer): -1 | 0 | 1 {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  const pa = a.prerelease
  const pb = b.prerelease
  if (pa === pb) return 0
  if (pa === undefined) return 1
  if (pb === undefined) return -1
  return pa < pb ? -1 : 1
}

/** Compare two version strings; unparseable sorts before parseable. */
export function compareVersionStrings(a: unknown, b: unknown): -1 | 0 | 1 {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (!left && !right) return 0
  if (!left) return -1
  if (!right) return 1
  return compareSemver(left, right)
}

export type ContractCompatibilityStatus = 'ok' | 'app_too_old' | 'migratable' | 'unknown'

export interface ContractCompatibility {
  status: ContractCompatibilityStatus
  /** The folder's contract version, when it parsed. */
  agent: SemVer | null
  /** The tool's contract version, when it parsed. */
  tool: SemVer | null
  /** One sentence a UI can show as-is. */
  reason: string
}

/**
 * Decide whether a folder recording `agentVersion` may be operated by a tool
 * bundling `toolVersion`.
 *
 * @param agentVersion `contract_version` from `cinna-agent.json`
 * @param toolVersion the active contract's version
 */
export function checkContractCompatibility(
  agentVersion: unknown,
  toolVersion: unknown
): ContractCompatibility {
  const agent = parseSemver(agentVersion)
  const tool = parseSemver(toolVersion)

  if (!agent || !tool) {
    return {
      status: 'unknown',
      agent,
      tool,
      reason: !agent
        ? 'This agent does not record a contract version. It was created before contract 1.0.0 and should be re-stamped.'
        : 'The active contract does not record a usable version.'
    }
  }

  if (agent.major === tool.major) {
    return {
      status: 'ok',
      agent,
      tool,
      reason: `Contract ${agent.raw} runs on this contract ${tool.raw}.`
    }
  }

  if (agent.major > tool.major) {
    return {
      status: 'app_too_old',
      agent,
      tool,
      reason: `This agent needs contract ${agent.major}.x and this app has ${tool.raw}. Update the app.`
    }
  }

  return {
    status: 'migratable',
    agent,
    tool,
    reason: `This agent was built against contract ${agent.raw}; the app is on ${tool.raw}. It can be migrated.`
  }
}
