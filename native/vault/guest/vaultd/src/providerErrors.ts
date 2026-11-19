/**
 * `engine.providerErrors`: what a vault Antigravity server logged about the
 * Gemini API, which it never says on the ACP wire.
 *
 * The pinned server writes a provider error (a 503, a quota) only into the
 * session's transcript, `<home>/.gemini/antigravity-acp/brain/<sessionId>/
 * .system_generated/logs/transcript_full.jsonl` (vaultd starts it with
 * `GEMINI_HOME=<home>/.gemini`, engine.ts). That file is the agent's: the
 * agent user owns the home and may have put anything there, a symlink to a
 * root-only file included. So vaultd never opens it itself: an unprivileged
 * child running as the agent (D36) reads the tail and hands the bytes back.
 * The child opens the final component with O_NOFOLLOW and refuses a file
 * whose real location (the open descriptor's, `/proc/self/fd`) is not under
 * the brain folder, and a brain folder that is itself reached through a link.
 *
 * vaultd then parses the tail with the host's own parser
 * (`src/shared/antigravityProviderErrors.ts`): only SYSTEM error steps of the
 * current turn, each message cleaned, redacted and capped. Nothing else of the
 * file (the user's prompts) leaves vaultd, and only counts and codes are logged.
 */
import { VAULT_PROVIDER_ERRORS_MAX, VAULT_PROVIDER_ERRORS_SINCE_MAX_MS, type VaultProviderErrorEntry } from '../../../../../src/shared/vault/protocol'
import {
  ANTIGRAVITY_SERVER_LOG_TAIL_BYTES,
  antigravityTranscriptSegments,
  parseProviderErrors,
  plainAntigravitySessionId,
  vaultProviderErrorEntries
} from '../../../../../src/shared/antigravityProviderErrors'
import type { Ctx, Handler } from './context'
import { nodeSelfEnv, runCollect } from './procs'
import { spawnIdentity } from './users'
import { invalid, log, VaultdError } from './util'

/** The brain folder below the agent's home, where the server keeps one folder per ACP session. */
export const BRAIN_SEGMENTS = ['.gemini', 'antigravity-acp', 'brain'] as const

/**
 * Runs as the agent user. Input on stdin: `{ home, brain: [...segments],
 * rel: [...segments], maxBytes }`. Prints `{ missing: true }`, `{ refused:
 * true }`, or `{ bytes: <base64>, cut: <the tail starts mid-file> }`.
 *
 * The brain folder must be exactly `realpath(home)/.gemini/antigravity-acp/
 * brain` (no link on the way to it); the file is opened at its lexical path
 * under that with O_NOFOLLOW | O_NONBLOCK (a link as the last component fails,
 * a fifo cannot hold it), must be a regular file, and the descriptor's own
 * path must lie under the brain folder (a parent swapped for a link out is
 * refused). Without /proc (fake mode on macOS) the realpath is compared with
 * the descriptor's dev/ino instead: best effort, the guest never takes it.
 * `beforeOpen` (tests only) runs right before the open.
 */
export function providerErrorsScript(hooks: { beforeOpen?: string } = {}): string {
  return `
const fs = require('fs'), path = require('path')
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => { input += d })
process.stdin.on('end', () => {
  const req = JSON.parse(input)
  const out = (value) => process.stdout.write(JSON.stringify(value))
  let home
  try { home = fs.realpathSync(req.home) } catch { return out({ missing: true }) }
  const brain = path.join(home, ...req.brain)
  let brainReal
  try { brainReal = fs.realpathSync(brain) } catch { return out({ missing: true }) }
  if (brainReal !== brain) return out({ refused: true })
  const file = path.join(brain, ...req.rel)
  const inside = (at) => at.startsWith(brain + path.sep)
  let fd
  try {
    ${hooks.beforeOpen ?? ''}
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    } catch (err) {
      return out(err && err.code === 'ENOENT' ? { missing: true } : { refused: true })
    }
    const opened = fs.fstatSync(fd)
    if (!opened.isFile()) return out({ refused: true })
    let at
    try { at = fs.readlinkSync('/proc/self/fd/' + fd) } catch { at = null }
    if (at === null) {
      if (process.platform === 'linux') return out({ refused: true })
      try { at = fs.realpathSync(file) } catch { return out({ refused: true }) }
      let now
      try { now = fs.statSync(at) } catch { return out({ refused: true }) }
      if (now.dev !== opened.dev || now.ino !== opened.ino) return out({ refused: true })
    }
    if (!inside(at)) return out({ refused: true })
    const length = Math.min(opened.size, req.maxBytes)
    const start = opened.size - length
    const buffer = Buffer.alloc(length)
    let offset = 0
    while (offset < length) {
      const n = fs.readSync(fd, buffer, offset, length - offset, start + offset)
      if (n === 0) break
      offset += n
    }
    out({ bytes: buffer.subarray(0, offset).toString('base64'), cut: start > 0 })
  } catch { out({ refused: true }) }
  finally { if (fd !== undefined) fs.closeSync(fd) }
})
`
}

const SCRIPT = providerErrorsScript()
/** Base64 of the tail plus the JSON around it. */
const OUTPUT_MAX = Math.ceil((ANTIGRAVITY_SERVER_LOG_TAIL_BYTES * 4) / 3) + 1024

type TailAnswer = { missing?: unknown; refused?: unknown; bytes?: unknown; cut?: unknown }

/** The transcript's tail as text (a cut first line dropped), '' when there is none; throws when refused. */
export async function readTranscriptTail(ctx: Ctx, sessionId: string, script = SCRIPT): Promise<string> {
  const r = await runCollect(ctx.config.node, ['-e', script], {
    input: Buffer.from(JSON.stringify({
      home: ctx.layout.home,
      brain: BRAIN_SEGMENTS,
      rel: antigravityTranscriptSegments(sessionId).slice(2),
      maxBytes: ANTIGRAVITY_SERVER_LOG_TAIL_BYTES
    })),
    env: { PATH: ctx.config.path, LANG: 'C.UTF-8', ...nodeSelfEnv() },
    cwd: ctx.layout.home,
    timeoutMs: 15_000,
    maxBytes: OUTPUT_MAX,
    ...spawnIdentity(ctx, 'agent')
  })
  let answer: TailAnswer
  try {
    answer = r.code === 0 ? (JSON.parse(r.stdout) as TailAnswer) : {}
  } catch {
    answer = {}
  }
  if (answer.missing === true) return ''
  if (typeof answer.bytes !== 'string') throw invalid('The transcript cannot be read.')
  const text = Buffer.from(answer.bytes, 'base64').toString('utf8')
  if (answer.cut !== true) return text
  const firstBreak = text.indexOf('\n')
  return firstBreak === -1 ? '' : text.slice(firstBreak + 1)
}

export const engineProviderErrors: Handler = async (ctx, params) => {
  const { stream, sessionId, sinceAgoMs } = params
  if (typeof stream !== 'string' || !ctx.engines.has(stream) || ctx.engineNames.get(stream) !== 'antigravity') {
    throw invalid('Not a running Antigravity engine.')
  }
  if (!plainAntigravitySessionId(sessionId)) throw invalid('Invalid session id.')
  if (typeof sinceAgoMs !== 'number' || !Number.isFinite(sinceAgoMs) || sinceAgoMs < 0 || sinceAgoMs > VAULT_PROVIDER_ERRORS_SINCE_MAX_MS) {
    throw invalid('Invalid sinceAgoMs.')
  }
  // On this clock, the one the server stamps its steps with: the host's may differ.
  const since = Date.now() - sinceAgoMs
  let text: string
  try {
    text = await readTranscriptTail(ctx, sessionId)
  } catch (error) {
    if (error instanceof VaultdError) throw error
    throw new VaultdError('internal', 'The transcript cannot be read.')
  }
  const errors: VaultProviderErrorEntry[] = vaultProviderErrorEntries(parseProviderErrors(text, since)).slice(-VAULT_PROVIDER_ERRORS_MAX)
  if (errors.length > 0) {
    log('info', 'provider errors read', { errors: errors.length, codes: errors.map((error) => error.code ?? '-').join(',') })
  }
  return { errors }
}
