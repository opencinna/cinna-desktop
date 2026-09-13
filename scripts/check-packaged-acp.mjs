import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

// Run against an actual packaged build, using its own Electron/Node runtime.
// Example: npm run test:packaged:acp -- "dist/mac-arm64/Cinna Desktop.app/Contents/MacOS/Cinna Desktop" "dist/mac-arm64/Cinna Desktop.app/Contents/Resources"
const [executable, resources] = process.argv.slice(2).map((path) => resolve(path))
if (!executable || !resources) {
  throw new Error('Usage: npm run test:packaged:acp -- <app executable> <resources directory>')
}

const scratch = await mkdtemp(join(tmpdir(), 'cinna-packaged-acp-'))
try {
  // Builds inside the repository could otherwise resolve missing packages from
  // the repository's node_modules. Copy only the shipped unpacked tree outside it.
  const unpacked = join(scratch, 'app.asar.unpacked')
  await cp(join(resources, 'app.asar.unpacked'), unpacked, { recursive: true })
  // Codex starts its app-server during initialize. Reuse the integration-test
  // peer so the packaged adapter is real but no installed CLI/login is needed.
  const codex = join(scratch, process.platform === 'win32' ? 'codex.cmd' : 'codex')
  const fakeServer = await readFile(new URL('../src/main/agents/drivers/acp/testSupport/fakeCodexAppServer.mjs', import.meta.url), 'utf8')
  const serverEntry = join(scratch, 'fake-codex.mjs')
  await writeFile(serverEntry, fakeServer)
  // A raw Node shebang fails when its installation path contains spaces.
  // Keep paths in environment values, quoted by the target platform's shell.
  const launcher = process.platform === 'win32'
    ? '@echo off\r\nsetlocal DisableDelayedExpansion\r\n"%CINNA_TEST_NODE%" "%CINNA_TEST_SERVER%" %*\r\n'
    : '#!/bin/sh\nexec "$CINNA_TEST_NODE" "$CINNA_TEST_SERVER" "$@"\n'
  await writeFile(codex, launcher, { mode: 0o755 })
  for (const adapter of ['claude-agent-acp', 'codex-acp']) {
    const entry = join(unpacked, 'node_modules/@agentclientprotocol', adapter, 'dist/index.js')
    // A clean environment and cwd prevent developer dependencies or credentials
    // from masking a broken package. Initialize makes no model request.
    const child = spawn(executable, [entry], {
      cwd: scratch,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: scratch,
        USERPROFILE: scratch,
        TMPDIR: scratch,
        CLAUDE_CONFIG_DIR: scratch,
        CODEX_HOME: scratch,
        ELECTRON_RUN_AS_NODE: '1',
        CLAUDE_CODE_EXECUTABLE: join(scratch, 'unused-claude'),
        CODEX_PATH: codex,
        CINNA_TEST_NODE: process.execPath,
        CINNA_TEST_SERVER: serverEntry
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const closed = new Promise((resolve) => child.once('close', resolve))
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    const lines = createInterface({ input: child.stdout })
    let timer
    try {
      const response = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${adapter}: initialize timed out\n${stderr}`)), 15_000)
        child.once('error', reject)
        child.once('exit', (code, signal) => reject(new Error(`${adapter}: exited (${code ?? signal}) before initialize\n${stderr}`)))
        child.stdin.on('error', reject)
        lines.on('line', (line) => {
          try {
            const message = JSON.parse(line)
            if (message.id === 1) resolve(message)
          } catch (error) {
            reject(error)
          }
        })
        child.stdin.write(JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'cinna-package-check', version: '1' } }
        }) + '\n')
      })
      assert.equal(response.error, undefined, JSON.stringify(response.error))
      assert.equal(response.result?.protocolVersion, 1)
      console.log(`${adapter}: packaged initialize passed`)
    } finally {
      clearTimeout(timer)
      lines.close()
      child.kill('SIGKILL')
      await closed
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}
