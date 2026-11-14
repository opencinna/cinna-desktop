/**
 * The guest's vaultd log lives in RAM (`/run/vault/vaultd.log`, tmpfs): it is
 * rotated at a size cap with one older file kept, so a long-running or
 * restarting vaultd never fills the VM's memory.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/config'
import { log, LOG_MAX_BYTES, setLogFile, setQuiet } from '../src/util'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vaultd-log-'))
  setQuiet(false)
})

afterEach(() => {
  setLogFile(null)
  setQuiet(true)
  rmSync(dir, { recursive: true, force: true })
})

describe('the vaultd log', () => {
  it('is the tmpfs file in the guest, rotated at 1 MiB', () => {
    expect(parseArgs([]).logFile).toBe('/run/vault/vaultd.log')
    expect(parseArgs(['--fake', '--root', dir, '--listen', join(dir, 's')]).logFile).toBeNull()
    expect(LOG_MAX_BYTES).toBe(1024 * 1024)
  })

  it('rotates past the cap, keeping one older file, and never grows past it', () => {
    const file = join(dir, 'vaultd.log')
    setLogFile(file, 200)
    for (let i = 0; i < 40; i++) log('info', 'request', { method: 'runtime.status', n: i })
    expect(statSync(file).size).toBeLessThanOrEqual(200)
    expect(statSync(`${file}.1`).size).toBeLessThanOrEqual(200)
    expect(readFileSync(file, 'utf8')).toContain('n=39')
    expect(existsSync(`${file}.2`)).toBe(false)
  })

  it('rotates an oversized file left by the vaultd before (a restart loop)', () => {
    const file = join(dir, 'vaultd.log')
    writeFileSync(file, 'x'.repeat(300))
    setLogFile(file, 200)
    expect(statSync(`${file}.1`).size).toBe(300)
    log('info', 'started')
    expect(readFileSync(file, 'utf8')).toBe('[vaultd] info started\n')
  })
})
