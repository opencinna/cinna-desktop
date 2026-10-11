/**
 * Proof from the main process's own output that a live test's agent turns ran
 * on the engine `CINNA_E2E_LIVE_ENGINE` chose (`liveEngine.ts`), not only that
 * the runtime field was saved. The fixture (`app.ts`) collects stdout and stderr
 * of every launch, relaunches included, and runs {@link checkLiveEngine} after
 * a passing test whose options set `liveEngineCheck`.
 *
 * The lines, as the logger prints them (`[scope] message { …data }`, the data
 * through `util.inspect`, possibly over several lines) — the same two
 * `scripts/live/runtime-flow.mjs` reads:
 * - `[acp-driver] ACP turn complete { … launcher: 'claude' … }` and
 *   `ACP follow-up turn complete` — a turn that ran, and on which launcher
 *   (`opencode` / `claude` / `codex`, `AcpLauncherId`);
 * - `[engine-binary] runtime binary resolved { tool, source, version, path }`
 *   — which binary that engine resolved to.
 */
export interface LiveEngineCheck {
  /** The launcher every turn must have run on. */
  engine: string
  /** The binary a Claude/Codex run named in Settings; null on OpenCode (the cached managed copy). */
  binary: string | null
}

/** The annotation type a test adds when it runs no agent turn at all (a gate it never answers). */
export const NO_AGENT_TURN = 'live-engine: no agent turn'

interface LogRecord {
  message: string
  fields: Record<string, string>
}

function records(log: string, scope: string): LogRecord[] {
  const pattern = new RegExp(`\\[${scope}\\] ([^{\\n]*?) \\{([^}]*)\\}`, 'g')
  // `util.inspect` colours the values (`\x1b[32m'claude'\x1b[39m`) when it prints to Playwright's pipe.
  const plain = log.replace(/\x1b\[[0-9;]*m/g, '')
  return [...plain.matchAll(pattern)].map((match) => ({
    message: match[1].trim(),
    fields: Object.fromEntries([...match[2].matchAll(/(\w+): '([^']*)'/g)].map(([, key, value]) => [key, value]))
  }))
}

/**
 * Throws when no turn completed on `check.engine` (unless the test runs none),
 * when any `acp-driver` line names another launcher, or when the engine's
 * resolved binary is not the one the run named. Answers the summary line, e.g.
 * `claude 2.1.296 (Claude Code) configured /…/2.1.296 — 1 turn completed on claude`.
 */
export function checkLiveEngine(log: string, check: LiveEngineCheck, expectsTurn: boolean): string {
  const driver = records(log, 'acp-driver').filter((record) => record.fields.launcher !== undefined)
  const turns = driver.filter((record) => /^ACP (follow-up )?turn complete$/.test(record.message))
  const ours = turns.filter((record) => record.fields.launcher === check.engine)
  const others = driver.filter((record) => record.fields.launcher !== check.engine)
  const resolved = records(log, 'engine-binary')
    .filter((record) => record.message === 'runtime binary resolved' && record.fields.tool === check.engine)
    .at(-1)?.fields
  const binary = resolved
    ? `${check.engine} ${resolved.version} ${resolved.source} ${resolved.path}`
    : `${check.engine} (no "runtime binary resolved" line)`
  const summary = `${binary} — ${ours.length} turn${ours.length === 1 ? '' : 's'} completed on ${check.engine}`
  if (others.length > 0) {
    const named = [...new Set(others.map((record) => `${record.fields.launcher} (${record.message})`))].join(', ')
    throw new Error(`the main process ran an agent on another engine than ${check.engine}: ${named}. ${summary}`)
  }
  if (expectsTurn && ours.length === 0) {
    throw new Error(`no agent turn completed on ${check.engine} in the main-process output. ${summary}`)
  }
  if (ours.length > 0 && !resolved) {
    throw new Error(`turns ran on ${check.engine} but its binary resolution was never logged. ${summary}`)
  }
  if (resolved && check.binary !== null && resolved.path !== check.binary) {
    throw new Error(`${check.engine} resolved to ${resolved.path}, not the binary this run named (${check.binary}). ${summary}`)
  }
  return summary
}
