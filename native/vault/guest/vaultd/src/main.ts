/**
 * cinna-vaultd entry point. In the guest, vault-init starts it with no
 * arguments; fake mode (`--fake --root DIR --listen SOCK --approval-key HEX
 * [--vault-id ID] [--helper-listen SOCK]`) runs it as a plain Node process
 * for tests and the fake backend. Bundled to out/main/vaultd.js.
 */
import { parseArgs, UsageError } from './config'
import { createVaultd } from './server'
import { log, setLogFile } from './util'

async function main(): Promise<void> {
  let config
  try {
    config = parseArgs(process.argv.slice(2))
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`cinna-vaultd: ${err.message}\n`)
      process.exit(2)
    }
    throw err
  }
  setLogFile(config.logFile)
  // Guest: group `vault` may write what agent and build create in the setgid agent folder (D36).
  process.umask(config.fake ? 0o022 : 0o002)
  const vaultd = createVaultd(config)
  await vaultd.listen()
  const stop = (): void => {
    log('info', 'stopping')
    void vaultd.close().then(() => process.exit(0))
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  // An unattached child stream must not kill the daemon.
  process.on('uncaughtException', (err) => log('error', 'uncaught exception', { name: err.name }))
}

void main().catch((err: Error) => {
  log('error', 'failed to start', { name: err.name, message: err.message })
  process.exit(1)
})
