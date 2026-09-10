import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  FakeAcpLogEntry,
  FakeAcpScript
} from '../../src/main/agents/drivers/acp/testSupport/fakeAcp'
import { repoRoot } from '../playwright.config'
import type { CinnaApp } from './app'

/**
 * Run folder agents on the scriptable fake ACP agent instead of a real
 * `opencode acp`.
 *
 * Through the product's own seam, not around it: the engine path a user can set
 * in Settings → Local Agents. The path is kept in the profile database, so it
 * survives `relaunch()`, and everything between the setting and the child is
 * the product — binary resolution, the `--version` probe, the per-agent config
 * the launcher writes, the narrowed child environment, `spawn`, the ACP
 * handshake, `session/new`, the setup calls and `session/prompt`.
 *
 * The path is a `/bin/sh` shim rather than the `.mjs` itself for the two
 * reasons it always was: the resolver spawns the path directly, so it must be
 * executable and answer `--version`, and the child gets a *narrowed*
 * environment (`shellEnvForChild`) in which `node` need not resolve — so the
 * shim names the exact node running this suite. It exports `FAKE_ACP_SCRIPT`
 * and `FAKE_ACP_LOG` itself for the same reason: the app builds the child's
 * whole environment and passes it verbatim, so nothing this process sets can
 * reach the fake.
 *
 * The agent it execs is the one the driver's own contract suite drives —
 * `src/main/agents/drivers/acp/testSupport/fakeAcpAgent.mjs`, a real ACP agent
 * speaking newline-delimited JSON-RPC over stdio, driven by the JSON script
 * written here. See `fakeAcp.ts` for the script format and the log format.
 *
 * Needs a credential with a model to run on, or the OpenCode launcher refuses
 * the turn with a skip reason (`configGenerator`) before any fake is reached.
 */
const FAKE_AGENT = join(
  repoRoot,
  'src',
  'main',
  'agents',
  'drivers',
  'acp',
  'testSupport',
  'fakeAcpAgent.mjs'
)

/** The installed fake, and the reader over what it recorded. */
export interface FakeAcpEngine {
  /** The `/bin/sh` shim the app spawns — the value of `localAgentsEnginePath`. */
  shim: string
  /** Where the script lives; rewrite it with {@link setScript}. */
  scriptPath: string
  logPath: string
  /** Everything the fake has recorded so far, across app restarts. */
  log(): FakeAcpLogEntry[]
  /** What the *agent* was sent, per ACP method (`session/prompt`, …), in order. */
  received(method: string): FakeAcpLogEntry[]
  /**
   * What the *client* answered a request the agent sent — the witness for a
   * `session/request_permission` outcome or an `elicitation/create` action,
   * neither of which any screen shows.
   */
  answers(method: string): FakeAcpLogEntry[]
  /** Replace the script. Read at each process start, so a relaunch picks it up. */
  setScript(script: FakeAcpScript): void
}

export async function installFakeAcpEngine(
  cinna: CinnaApp,
  script: FakeAcpScript = {}
): Promise<FakeAcpEngine> {
  const shim = join(cinna.sandbox.root, 'fake-opencode')
  const scriptPath = join(cinna.sandbox.root, 'fake-acp-script.json')
  const logPath = join(cinna.sandbox.root, 'fake-acp-log.jsonl')
  writeFileSync(scriptPath, JSON.stringify(script, null, 2))
  writeFileSync(
    shim,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "1.18.27-e2e-fake"; exit 0; fi',
      `FAKE_ACP_SCRIPT='${scriptPath}'`,
      `FAKE_ACP_LOG='${logPath}'`,
      'export FAKE_ACP_SCRIPT FAKE_ACP_LOG',
      `exec '${process.execPath}' '${FAKE_AGENT}' "$@"`,
      ''
    ].join('\n')
  )
  chmodSync(shim, 0o755)
  await cinna.page.evaluate((path) => window.api.settings.set('localAgentsEnginePath', path), shim)

  const log = (): FakeAcpLogEntry[] => {
    if (!existsSync(logPath)) return []
    return readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as FakeAcpLogEntry)
  }

  return {
    shim,
    scriptPath,
    logPath,
    log,
    received: (method) => log().filter((entry) => entry.dir === 'in' && entry.method === method),
    answers: (method) => log().filter((entry) => entry.dir === 'answer' && entry.method === method),
    setScript: (next) => writeFileSync(scriptPath, JSON.stringify(next, null, 2))
  }
}
