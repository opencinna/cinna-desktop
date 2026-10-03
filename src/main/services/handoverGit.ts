import { execFile as execFileCb } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { HANDOVERS_DIR, type HandoverIgnoreCheck } from '../../shared/handovers'
import { getShellEnv, usableTool } from '../shell/env'
import { createLogger } from '../logger/logger'

const logger = createLogger('handover-git')

/** Long enough for a cold `git` on a large repository, short enough to scan. */
const GIT_TIMEOUT_MS = 5_000

export type ExecFile = (
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }
) => Promise<{ stdout: string; stderr: string }>

const nodeExecFile = promisify(execFileCb) as unknown as ExecFile

export interface HandoverGitDeps {
  execFile: ExecFile
  /** The app's login shell PATH, so a `git` installed by brew is found. */
  env: () => Promise<NodeJS.ProcessEnv>
  /** Is the folder there at all? A path that is gone is never a permission. */
  exists: (path: string) => boolean
  /**
   * The git to run, or null when there is none worth running. On a Mac without
   * the command line developer tools `/usr/bin/git` is a stub that pops the
   * install dialog instead of answering, so it counts as no git at all. Absent,
   * the bare name is run and a missing binary surfaces as ENOENT.
   */
  resolveGit?: () => Promise<string | null>
}

/** A non-zero exit is an answer here, not a failure — so the code is what matters. */
function exitCodeOf(error: unknown): number | null {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'number' ? code : null
}

function errnoOf(error: unknown): string | null {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string' ? code : null
}

export function createHandoverGit(deps: HandoverGitDeps) {
  /**
   * The answer for a machine with no usable `git` binary (a bare Mac without
   * the command line tools, say).
   *
   * **Only "no repository at all" is a permission here.** Without git nothing
   * can tell whether `.cinna/handovers` is already committed, and a committed
   * brief pulled by GitHub Desktop would then run unasked — so a `.gitignore`
   * line proves nothing, and any `.git` entry in the folder or a parent up to
   * the root is `unknown`. `.git` is a directory in a clone and a file in a
   * worktree or submodule; both count. A folder that is gone is never a
   * permission either.
   */
  function staticCheck(dir: string): HandoverIgnoreCheck {
    if (!deps.exists(dir)) return { result: 'unknown', detail: 'That folder is no longer on this machine.' }
    for (let parent = dir; ; parent = dirname(parent)) {
      if (deps.exists(join(parent, '.git'))) {
        return {
          result: 'unknown',
          detail: 'This folder is in a git repository, and git isn’t available to confirm its handovers are not committed.'
        }
      }
      if (dirname(parent) === parent) break
    }
    return { result: 'not_a_repo' }
  }

  return {
    /**
     * What git says about `.cinna/handovers` in a folder (§3.4).
     *
     * Three questions in order, because they are not interchangeable:
     * **is this a repository at all** (if not, nothing can arrive by pull, and
     * `auto` is allowed), **is the directory already tracked** (the worst case:
     * ignoring it now would not untrack it), and only then **is it ignored**.
     * Asking `check-ignore` first would answer `not_ignored` for a tracked
     * directory and lose the distinction the user most needs to see.
     *
     * Never throws. Every failure is `unknown`, which forbids `auto`.
     */
    async check(agentDir: string, relativePath: string = HANDOVERS_DIR): Promise<HandoverIgnoreCheck> {
      const noGit = (): HandoverIgnoreCheck =>
        relativePath === HANDOVERS_DIR ? staticCheck(agentDir) : { result: 'unknown', detail: 'Git is required to verify credential paths.' }
      const resolveGit = deps.resolveGit
      const git = resolveGit ? await Promise.resolve().then(resolveGit).catch(() => null) : 'git'
      // Not spawned at all: a macOS stub would pop the install dialog per check.
      if (!git) return noGit()
      const env = await deps.env().catch(() => process.env)
      const run = (args: string[]): Promise<{ stdout: string; stderr: string }> =>
        deps.execFile(git, ['-C', agentDir, ...args], { env, timeout: GIT_TIMEOUT_MS })

      try {
        await run(['rev-parse', '--is-inside-work-tree'])
      } catch (error) {
        if (errnoOf(error) === 'ENOENT') return noGit()
        // **A git that never answered is not a git that said "no repository".**
        // The 5 s timeout kills the child with a signal and no exit code, and so
        // does an OOM killer; `index.lock` contention and a slow network mount
        // both reach it. Reading that as `not_a_repo` would grant `auto` to a
        // repository with `.cinna/handovers` committed — the exact case the
        // check exists to catch — so an answerless git is `unknown`, like the
        // two arms below.
        if (exitCodeOf(error) === null) {
          logger.warn('git rev-parse did not answer', { agentDir })
          return { result: 'unknown', detail: 'git could not be asked about this folder.' }
        }
        // A real non-zero exit means "not a working tree": a folder outside a
        // repository, or a `.git` that is broken. Both are "a pull cannot plant
        // a brief here" — **but only if the folder is there**. `git -C` exits
        // the same way for a path that has gone, and a folder nothing can
        // inspect must never come back as a permission.
        if (!deps.exists(agentDir)) {
          return { result: 'unknown', detail: 'That folder is no longer on this machine.' }
        }
        if (relativePath !== HANDOVERS_DIR) {
          // A broken repository is unsafe for secret delivery. Inspect every
          // ancestor because a kit can sit inside a larger working tree.
          for (let parent = agentDir; ; parent = dirname(parent)) {
            if (deps.exists(join(parent, '.git'))) return { result: 'unknown', detail: 'The repository could not be verified.' }
            if (dirname(parent) === parent) break
          }
        }
        return { result: 'not_a_repo' }
      }

      try {
        await run(['ls-files', '--error-unmatch', '--', relativePath])
        return {
          result: 'tracked',
          detail: 'This folder’s handovers are committed to git, so anything that can land a commit can plant one.'
        }
      } catch (error) {
        if (errnoOf(error) === 'ENOENT') return noGit()
        if (exitCodeOf(error) === null || (relativePath !== HANDOVERS_DIR && exitCodeOf(error) !== 1)) {
          logger.warn('git ls-files did not answer', { agentDir })
          return { result: 'unknown', detail: 'git could not be asked about this folder.' }
        }
      }

      try {
        await run(['check-ignore', '-q', '--', relativePath])
        return { result: 'ignored' }
      } catch (error) {
        if (errnoOf(error) === 'ENOENT') return noGit()
        // `check-ignore -q`: 0 is ignored, 1 is not, anything else is an error.
        if (exitCodeOf(error) === 1) {
          return {
            result: 'not_ignored',
            detail: 'Add `.cinna/` to this project’s .gitignore before running handovers automatically.'
          }
        }
        logger.warn('git check-ignore did not answer', { agentDir })
        return { result: 'unknown', detail: 'git could not be asked about this folder.' }
      }
    }
  }
}

export type HandoverGit = ReturnType<typeof createHandoverGit>

export const handoverGit = createHandoverGit({
  execFile: nodeExecFile,
  env: async () => ({ ...process.env, ...(await getShellEnv()) }),
  exists: (path) => existsSync(path),
  resolveGit: () => usableTool('git')
})
