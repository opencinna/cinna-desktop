import { describe, expect, it } from 'vitest'
import { runCinnaCli, type CliProgressLine } from './cliRunner'

/**
 * Driven against a real child process rather than a mocked stream, because the
 * two things worth proving here are both about process boundaries: that a line
 * split across two `data` chunks is still one line, and that a non-zero exit is
 * an *outcome* rather than a rejection. `node -e` stands in for cinna-cli — the
 * protocol is a line format, and a fake that emits it is as good as the real
 * thing for reading it.
 */
const node = process.execPath

function run(script: string, onProgress?: (line: CliProgressLine) => void): ReturnType<typeof runCinnaCli> {
  return runCinnaCli({
    bin: node,
    args: ['-e', script],
    logArgs: ['<script>'],
    env: process.env,
    onProgress,
    timeoutMs: 20_000
  })
}

describe('runCinnaCli', () => {
  it('reads progress lines and the final result line', async () => {
    const seen: CliProgressLine[] = []
    const outcome = await run(
      `process.stdout.write(JSON.stringify({step:1,total:3,status:'start',message:'Authenticating...'})+"\\n");` +
        `process.stdout.write(JSON.stringify({step:1,total:3,status:'ok',message:'done'})+"\\n");` +
        `process.stdout.write(JSON.stringify({result:'ok',workspace:'/tmp/ws',token:'valid'})+"\\n");`,
      (line) => seen.push(line)
    )
    expect(outcome.exitCode).toBe(0)
    expect(seen.map((l) => l.status)).toEqual(['start', 'ok'])
    expect(seen[0].message).toBe('Authenticating...')
    expect(outcome.result).toMatchObject({ result: 'ok', workspace: '/tmp/ws', token: 'valid' })
  })

  it('reassembles a result line that arrives without a trailing newline', async () => {
    // cinna-cli flushes and exits; whether the last newline lands before the
    // stream closes is not something a driver may depend on.
    const outcome = await run(`process.stdout.write(JSON.stringify({result:'ok',token:'expired'}))`)
    expect(outcome.result).toMatchObject({ result: 'ok', token: 'expired' })
  })

  it('reports a non-zero exit as an outcome, with its error line', async () => {
    const outcome = await run(
      `process.stdout.write(JSON.stringify({result:'error',code:'setup_token',detail:'expired'})+"\\n");` +
        `process.exit(10)`
    )
    expect(outcome.exitCode).toBe(10)
    expect(outcome.result).toMatchObject({ result: 'error', code: 'setup_token' })
  })

  it('survives non-JSON noise on stdout', async () => {
    // A library printing over the protocol is a bug on the other side, not a
    // reason to fail a setup that otherwise worked.
    const outcome = await run(
      `process.stdout.write("warning: something\\n");` +
        `process.stdout.write(JSON.stringify({result:'ok'})+"\\n");`
    )
    expect(outcome.exitCode).toBe(0)
    expect(outcome.result).toMatchObject({ result: 'ok' })
  })

  it('captures stderr without letting it decide anything', async () => {
    const outcome = await run(
      `process.stderr.write("Error: nope\\n"); process.exit(1)`
    )
    expect(outcome.exitCode).toBe(1)
    expect(outcome.result).toBeNull()
    expect(outcome.stderr).toContain('nope')
  })

  it('kills a run that overstays and says so', async () => {
    const outcome = await runCinnaCli({
      bin: node,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      logArgs: ['<script>'],
      env: process.env,
      timeoutMs: 300
    })
    expect(outcome.timedOut).toBe(true)
    expect(outcome.exitCode).toBeNull()
  })

  it('reports a binary that does not exist instead of throwing', async () => {
    const outcome = await runCinnaCli({
      bin: '/nonexistent/cinna',
      args: ['account', 'status'],
      logArgs: ['account', 'status'],
      env: process.env,
      timeoutMs: 5_000
    })
    expect(outcome.exitCode).toBeNull()
    expect(outcome.stderr).not.toBe('')
  })
})
