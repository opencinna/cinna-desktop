/**
 * Which of an Antigravity folder agent's permission asks Cinna answers itself.
 *
 * Antigravity on **Ask for approval** (server mode `default`) raises a
 * `session/request_permission` for every command and every edit, and the
 * server has no allowlist of its own (1.3.0: `_meta.agy` takes only
 * `enabledTools` / `disabledTools`; `auto_edit` approves an edit to any path).
 * Cinna's standing grants are exact `{command,cwd}` strings, so a skill script
 * run with new arguments would ask every time. This module is the narrow rule
 * that settles some of those asks silently, like a standing grant:
 *
 * - **An edit** whose every location is inside the agent's folder and not
 *   protected.
 * - **A command** run in the folder that is one simple command — the agent's
 *   own script (optionally under an interpreter), or one of a few read-only
 *   basics on paths inside the folder.
 *
 * The command half is the neutral own-command rule
 * (`services/localAgents/ownCommandPolicy.ts`), which a message's Run also
 * reads; this module keeps the edit rule and reads the ask's rawInput.
 *
 * Pure apart from the filesystem, which is injectable for tests. **Fails
 * closed**: anything it cannot parse, does not know, or cannot read answers
 * false, and the ask falls through to the grants and then to the user.
 *
 * Containment is decided on real paths: the folder is realpathed, an existing
 * path is realpathed, and a path that does not exist yet is its nearest
 * existing ancestor's real path plus the rest — so a symlink that points out
 * of the folder is outside it, and a dangling one is refused.
 */

import { isAbsolute, resolve } from 'node:path'
import {
  allowedPath,
  nodeOwnCommandFs,
  ownCommandAllowed,
  type OwnCommandFs,
  type OwnCommandPolicy
} from '../../../services/localAgents/ownCommandPolicy'

export { splitCommandLine } from '../../../../shared/commandRun'

/** The plan's policy: the agent's folder, and the folders of its pinned (catalog, marketplace) skills. */
export type AntigravityAutoApprovalPolicy = OwnCommandPolicy

/** The part of the ask the rule reads. */
export interface AntigravityAskedCall {
  kind?: string | null
  rawInput?: unknown
  locations?: readonly { path: string }[] | null
}

/** The filesystem the rule reads, injectable for tests. Each call may throw; `lstat`/`stat` return null for "absent". */
export type AutoApprovalFs = OwnCommandFs

export const nodeAutoApprovalFs: AutoApprovalFs = nodeOwnCommandFs

/**
 * Whether Cinna answers this ask `allow` without asking. Only `edit` and
 * `execute` are ever allowed; every other kind is left alone.
 */
export function antigravityAutoApproves(
  policy: AntigravityAutoApprovalPolicy,
  call: AntigravityAskedCall,
  fs: AutoApprovalFs = nodeAutoApprovalFs
): boolean {
  try {
    if (typeof policy.folder !== 'string' || !isAbsolute(policy.folder)) return false
    const folder = fs.realpath(resolve(policy.folder))
    if (call.kind === 'edit') return editAllowed(folder, call.locations, fs)
    if (call.kind === 'execute') return commandAllowed(policy, call.rawInput, fs)
    return false
  } catch {
    return false
  }
}

/* -------------------------------------------------------------------- edits */

function editAllowed(folder: string, locations: AntigravityAskedCall['locations'], fs: AutoApprovalFs): boolean {
  if (!Array.isArray(locations) || locations.length === 0) return false
  return locations.every((location) =>
    typeof location?.path === 'string' && isAbsolute(location.path) && allowedPath(folder, location.path, 'write', fs) !== null)
}

/* ----------------------------------------------------------------- commands */

function rawString(input: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string') return value
  }
  return null
}

function commandAllowed(policy: AntigravityAutoApprovalPolicy, rawInput: unknown, fs: AutoApprovalFs): boolean {
  if (!rawInput || typeof rawInput !== 'object') return false
  const input = rawInput as Record<string, unknown>
  const line = rawString(input, 'CommandLine', 'command_line')
  const cwd = rawString(input, 'Cwd', 'working_dir')
  if (line === null || cwd === null || !isAbsolute(cwd)) return false
  return ownCommandAllowed(policy, cwd, line, fs)
}
