import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, type Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { repoRoot } from '../playwright.config'
import { coreCall, type SharingPerson, type TeamFixtureBase } from './liveTeamSharing'

/**
 * cinna-cli, run **from source** against the real local cinna-core, as one
 * person, in a sandbox of its own.
 *
 * The CLI comes from `CINNA_CLI_PATH` (default: `../cinna-cli` beside this
 * repo) through `uv run --project <cli> cinna`, never the `cinna` on PATH,
 * which may be an older install. Every process gets the sandbox's `HOME`
 * (the CLI keeps its machine registry in `~/.cinna`, and Mutagen its daemon
 * in `~/.mutagen`) and `--no-input`, so nothing reads or writes the real
 * home and nothing waits for a prompt. {@link CinnaCli.dispose} stops that
 * home's Mutagen daemon and removes the sandbox.
 *
 * Signing in is the product's own path: an account setup token minted with
 * the person's web token (`POST /cli/account/setup-tokens`, which needs the
 * `agent-developer` role) and `cinna account setup <url>` in the sandbox.
 */

export interface CliResult {
  code: number
  stdout: string
  stderr: string
}

export function cinnaCliPath(): string {
  return resolve(repoRoot, (process.env.CINNA_CLI_PATH ?? '').trim() || join('..', 'cinna-cli'))
}

/** Without ANSI styling: the CLI's spinners and colours still reach a pipe (and ignore NO_COLOR). */
function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '\n')
}

export class CinnaCli {
  readonly root: string
  readonly home: string
  /** The account workspace, where every `cinna` call runs. */
  account = ''

  private constructor(readonly cliPath: string) {
    this.root = mkdtempSync(join(tmpdir(), 'cinna-e2e-cli-'))
    this.home = join(this.root, 'home')
  }

  /** A signed-in account workspace for `person` on the fixture's server. */
  static async signIn(fixture: TeamFixtureBase, person: SharingPerson): Promise<CinnaCli> {
    const path = cinnaCliPath()
    if (!existsSync(join(path, 'pyproject.toml'))) throw new Error(`no cinna-cli checkout at ${path} (set CINNA_CLI_PATH)`)
    const cli = new CinnaCli(path)
    const minted = await coreCall(fixture, person.token, '/cli/account/setup-tokens', { method: 'POST' })
    if (minted.status !== 200) throw new Error(`account setup token: HTTP ${minted.status} ${JSON.stringify(minted.body)}`)
    const url = /(https?:\/\/\S+\/cli-setup\/account\/\S+)/.exec(String(minted.body.setup_command))?.[1]
    if (!url) throw new Error('the setup command carries no /cli-setup/account/ URL')
    const setup = cli.runIn(cli.root, ['account', 'setup', url])
    if (setup.code !== 0) throw new Error(`cinna account setup failed (${setup.code}):\n${setup.stdout}\n${setup.stderr}`)
    const dirs = readdirSync(cli.root, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'home')
    if (dirs.length !== 1) throw new Error(`expected one account workspace in ${cli.root}, found ${dirs.map((d) => d.name)}`)
    cli.account = join(cli.root, dirs[0].name)
    return cli
  }

  /** `cinna <args>` in the account workspace. */
  run(args: string[], timeoutMs = 300_000): CliResult {
    return this.runIn(this.account, args, timeoutMs)
  }

  /** `cinna <args> --json`'s closing `result` line, parsed (the output is one JSON object per line). */
  json(args: string[], timeoutMs = 300_000): { code: number; result: any; raw: CliResult } {
    const raw = this.run([...args, '--json'], timeoutMs)
    const last = raw.stdout.trim().split('\n').filter(Boolean).pop() ?? ''
    let result: any = null
    try {
      result = JSON.parse(last)
    } catch {
      // not JSON: the caller sees raw
    }
    return { code: raw.code, result, raw }
  }

  /** `cinna agent sync <agent>` and the synced agent's `workspace/` folder. */
  syncAgent(agent: string): string {
    const synced = this.run(['agent', 'sync', agent])
    if (synced.code !== 0) throw new Error(`cinna agent sync failed (${synced.code}):\n${synced.stdout}\n${synced.stderr}`)
    // agents/<slug>/<slug>/workspace: the clone, then the agent's subdir.
    const agents = join(this.account, 'agents')
    for (const outer of readdirSync(agents, { withFileTypes: true }) as Dirent[]) {
      if (!outer.isDirectory()) continue
      for (const inner of readdirSync(join(agents, outer.name), { withFileTypes: true }) as Dirent[]) {
        const workspace = join(agents, outer.name, inner.name, 'workspace')
        if (inner.isDirectory() && existsSync(workspace)) return workspace
      }
    }
    throw new Error(`no synced workspace under ${agents}`)
  }

  /** The parent's environment with HOME and Mutagen's data directory pinned to the sandbox (an inherited MUTAGEN_DATA_DIRECTORY would reach the real daemon). */
  private sandboxEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: this.home, MUTAGEN_DATA_DIRECTORY: join(this.home, '.mutagen') }
    return env
  }

  private runIn(cwd: string, args: string[], timeoutMs = 300_000): CliResult {
    const out = spawnSync('uv', ['run', '--quiet', '--project', this.cliPath, 'cinna', '--no-input', ...args], {
      cwd,
      env: { ...this.sandboxEnv(), CINNA_NO_INPUT: '1', NO_COLOR: '1', COLUMNS: '200' },
      encoding: 'utf8',
      timeout: timeoutMs
    })
    return { code: out.status ?? -1, stdout: plain(out.stdout ?? ''), stderr: plain(out.stderr ?? (out.error ? String(out.error) : '')) }
  }

  /** Stop the sandbox's Mutagen daemon (sync started it) and remove everything. */
  dispose(keep = false): void {
    spawnSync('mutagen', ['daemon', 'stop'], { env: this.sandboxEnv(), timeout: 30_000 })
    if (!keep) rmSync(this.root, { recursive: true, force: true })
  }
}
