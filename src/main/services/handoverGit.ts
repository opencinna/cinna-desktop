import { execFile as execFileCb } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { HANDOVERS_DIR, type HandoverIgnoreCheck } from '../../shared/handovers'
import { getShellEnv } from '../shell/env'
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
  readFile: (path: string) => string
  /** Is the folder there at all? A path that is gone is never a permission. */
  exists: (path: string) => boolean
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

/**
 * The static reading of `.gitignore`, for a machine with no `git` binary.
 *
 * Deliberately a short allowlist of *literal* lines rather than a gitignore
 * engine (`src/main/kit/validator.ts` made the same call for `credentials/.env`).
 * A pattern this does not recognise reads as `unknown`, which forbids `auto` —
 * the failure direction that costs the user a question, not a permission.
 */
const IGNORED_LINES = new Set([
  '.cinna',
  '.cinna/',
  '/.cinna',
  '/.cinna/',
  '**/.cinna',
  '.cinna/handovers',
  '.cinna/handovers/',
  '/.cinna/handovers',
  '/.cinna/handovers/'
])

export function createHandoverGit(deps: HandoverGitDeps) {
  /**
   * Read `<dir>/.gitignore` and say whether it plainly excludes the handovers
   * tree. Anything else, including an unreadable file, is `unknown`.
   */
  function staticCheck(dir: string): HandoverIgnoreCheck {
    let text: string
    try {
      text = deps.readFile(join(dir, '.gitignore'))
    } catch {
      return { result: 'unknown', detail: 'git is not available and this folder has no .gitignore.' }
    }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (line === '' || line.startsWith('#')) continue
      if (IGNORED_LINES.has(line)) {
        return { result: 'ignored', detail: 'Read from .gitignore; git itself was not available.' }
      }
    }
    return { result: 'unknown', detail: 'git is not available and .gitignore does not plainly exclude .cinna.' }
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
    async check(agentDir: string): Promise<HandoverIgnoreCheck> {
      const env = await deps.env().catch(() => process.env)
      const run = (args: string[]): Promise<{ stdout: string; stderr: string }> =>
        deps.execFile('git', ['-C', agentDir, ...args], { env, timeout: GIT_TIMEOUT_MS })

      try {
        await run(['rev-parse', '--is-inside-work-tree'])
      } catch (error) {
        if (errnoOf(error) === 'ENOENT') return staticCheck(agentDir)
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
        return { result: 'not_a_repo' }
      }

      try {
        await run(['ls-files', '--error-unmatch', '--', HANDOVERS_DIR])
        return {
          result: 'tracked',
          detail: 'This folder’s handovers are committed to git, so anything that can land a commit can plant one.'
        }
      } catch (error) {
        if (errnoOf(error) === 'ENOENT') return staticCheck(agentDir)
        if (exitCodeOf(error) === null) {
          logger.warn('git ls-files did not answer', { agentDir })
          return { result: 'unknown', detail: 'git could not be asked about this folder.' }
        }
      }

      try {
        await run(['check-ignore', '-q', '--', HANDOVERS_DIR])
        return { result: 'ignored' }
      } catch (error) {
        if (errnoOf(error) === 'ENOENT') return staticCheck(agentDir)
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
  readFile: (path) => readFileSync(path, 'utf8'),
  exists: (path) => existsSync(path)
})
