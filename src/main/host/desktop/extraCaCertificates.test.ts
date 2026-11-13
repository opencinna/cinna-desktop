import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCACertificates } from 'node:tls'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { applyExtraCaCertificates, splitPemCertificates } from '../../../../resources/node-extra-ca/extra-ca.cjs'
import { extraCaChildEnv, extraCaPreloadPath, installExtraCaCertificates } from './extraCaCertificates'
import { getLogEntries } from '../../logger/logger'

const PRELOAD = join(__dirname, '..', '..', '..', '..', 'resources', 'node-extra-ca', 'preload.cjs')
// Real certificates without a key in the repo: Node's own bundled roots.
const [CERT_A, CERT_B, CERT_C] = getCACertificates('bundled')
const scratch = mkdtempSync(join(tmpdir(), 'cinna-extra-ca-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function file(name: string, content: string): string {
  const path = join(scratch, name)
  writeFileSync(path, content)
  return path
}

function fakeTls() {
  const set: string[][] = []
  return { set, tls: { getCACertificates: () => ['DEFAULT'], setDefaultCACertificates: (certs: string[]) => { set.push(certs) } } }
}

describe('splitPemCertificates', () => {
  it('splits a bundle with CRLF line endings and junk around and between the blocks', () => {
    const crlf = (pem: string): string => pem.replace(/\n/g, '\r\n')
    const bundle = `# corporate bundle\r\nsubject=CN=Proxy\r\n${crlf(CERT_A)}\r\nnot a cert\r\n${crlf(CERT_B)}${CERT_C}\ntrailing junk`
    expect(splitPemCertificates(bundle)).toEqual([CERT_A.trim(), CERT_B.trim(), CERT_C.trim()])
  })

  it('finds nothing in empty or certificate-free text', () => {
    expect(splitPemCertificates('')).toEqual([])
    expect(splitPemCertificates('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n')).toEqual([])
  })
})

describe('applyExtraCaCertificates', () => {
  it('does nothing and says nothing when the variable is unset or empty', () => {
    const warn = vi.fn()
    const { set, tls } = fakeTls()
    expect(applyExtraCaCertificates({}, warn, { tls })).toBe(0)
    expect(applyExtraCaCertificates({ NODE_EXTRA_CA_CERTS: '' }, warn, { tls })).toBe(0)
    expect(warn).not.toHaveBeenCalled()
    expect(set).toEqual([])
  })

  it('adds every certificate in the file to the default set', () => {
    const warn = vi.fn()
    const { set, tls } = fakeTls()
    const path = file('bundle.pem', `junk\n${CERT_A}\n${CERT_B}\n`)
    expect(applyExtraCaCertificates({ NODE_EXTRA_CA_CERTS: path }, warn, { tls })).toBe(2)
    expect(set).toEqual([['DEFAULT', CERT_A.trim(), CERT_B.trim()]])
    expect(warn).not.toHaveBeenCalled()
  })

  it('reads CINNA_EXTRA_CA_CERTS first, the name Electron leaves in a run-as-node child', () => {
    const warn = vi.fn()
    const { set, tls } = fakeTls()
    const cinna = file('cinna.pem', CERT_A)
    expect(applyExtraCaCertificates({ CINNA_EXTRA_CA_CERTS: cinna, NODE_EXTRA_CA_CERTS: join(scratch, 'nope.pem') }, warn, { tls })).toBe(1)
    expect(set).toEqual([['DEFAULT', CERT_A.trim()]])
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns once, naming the path, when the file is missing', () => {
    const warn = vi.fn()
    const { set, tls } = fakeTls()
    const path = join(scratch, 'missing.pem')
    expect(applyExtraCaCertificates({ NODE_EXTRA_CA_CERTS: path }, warn, { tls })).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toBe(`Ignoring extra certs from ${path}, load failed: ENOENT`)
    expect(set).toEqual([])
  })

  it('warns once when the file is empty or holds no certificate', () => {
    for (const content of ['', 'just text\n']) {
      const warn = vi.fn()
      const { set, tls } = fakeTls()
      const path = file('empty.pem', content)
      expect(applyExtraCaCertificates({ NODE_EXTRA_CA_CERTS: path }, warn, { tls })).toBe(0)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0][0]).toContain('no PEM certificates found')
      expect(set).toEqual([])
    }
  })

  it('keeps the parseable certificates and warns once, without the certificate text, about the rest', () => {
    const warn = vi.fn()
    const { set, tls } = fakeTls()
    const broken = '-----BEGIN CERTIFICATE-----\nnot base64 at all\n-----END CERTIFICATE-----'
    const path = file('partial.pem', `${broken}\n${CERT_A}`)
    expect(applyExtraCaCertificates({ NODE_EXTRA_CA_CERTS: path }, warn, { tls })).toBe(1)
    expect(set).toEqual([['DEFAULT', CERT_A.trim()]])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).not.toContain('not base64')
    expect(warn.mock.calls[0][0]).not.toContain('BEGIN')
  })

  it('never throws, even when the TLS call or the warning does', () => {
    const path = file('one.pem', CERT_A)
    const tls = { getCACertificates: () => [], setDefaultCACertificates: () => { throw Object.assign(new Error(CERT_A), { code: 'ERR_X' }) } }
    const warn = vi.fn()
    expect(applyExtraCaCertificates({ NODE_EXTRA_CA_CERTS: path }, warn, { tls })).toBe(0)
    expect(warn).toHaveBeenCalledWith(`Ignoring extra certs from ${path}, load failed: ERR_X`)
    expect(() => applyExtraCaCertificates({ NODE_EXTRA_CA_CERTS: path }, () => { throw new Error('x') }, { tls })).not.toThrow()
  })

  it('warns once on a runtime without the CA APIs', () => {
    const warn = vi.fn()
    expect(applyExtraCaCertificates({ NODE_EXTRA_CA_CERTS: file('one.pem', CERT_A) }, warn, { tls: {} as never })).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('main process', () => {
  it('logs the unusable file as a warning in main, not on stderr', () => {
    const path = join(scratch, 'absent.pem')
    expect(installExtraCaCertificates({ NODE_EXTRA_CA_CERTS: path })).toBe(0)
    const entry = getLogEntries().find((e) => e.scope === 'tls' && e.message.includes(path))
    expect(entry?.level).toBe('warn')
    expect(installExtraCaCertificates({})).toBe(0)
  })

  it('hands a run-as-node child the file as CINNA_EXTRA_CA_CERTS, and nothing when there is none', () => {
    expect(extraCaChildEnv({ NODE_EXTRA_CA_CERTS: '/corp/ca.pem' })).toEqual({ CINNA_EXTRA_CA_CERTS: '/corp/ca.pem' })
    expect(extraCaChildEnv({})).toEqual({})
  })

  it('points children at the unpacked preload when packaged, the repo copy in development', () => {
    expect(extraCaPreloadPath({ isPackaged: true, resourcesPath: '/R', appPath: '/R/app.asar' }))
      .toBe(join('/R', 'app.asar.unpacked', 'resources', 'node-extra-ca', 'preload.cjs'))
    expect(extraCaPreloadPath({ isPackaged: false, resourcesPath: '/x', appPath: '/repo' }))
      .toBe(join('/repo', 'resources', 'node-extra-ca', 'preload.cjs'))
  })
})

describe('preload.cjs in a child', () => {
  // Plain Node honours NODE_EXTRA_CA_CERTS itself; its own warning quotes the
  // path in backticks, the preload's does not, so the two are told apart.
  function run(env: Record<string, string>) {
    return spawnSync(process.execPath, ['--require', PRELOAD, '-e', 'process.stdout.write("ran")'], {
      env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8'
    })
  }

  it('starts the child silently when the variable is unset', () => {
    const child = run({})
    expect(child.status).toBe(0)
    expect(child.stdout).toBe('ran')
    expect(child.stderr).toBe('')
  })

  it('starts the child with one warning when the file is missing', () => {
    const path = join(scratch, 'nowhere.pem')
    const child = run({ NODE_EXTRA_CA_CERTS: path })
    expect(child.status).toBe(0)
    expect(child.stdout).toBe('ran')
    expect(child.stderr).toContain(`Warning: Ignoring extra certs from ${path}, load failed: ENOENT\n`)
  })

  it('reads CINNA_EXTRA_CA_CERTS and gives the child\'s own children NODE_EXTRA_CA_CERTS back', () => {
    const path = join(scratch, 'via-cinna.pem')
    const child = spawnSync(process.execPath, ['--require', PRELOAD, '-e', 'process.stdout.write(String(process.env.NODE_EXTRA_CA_CERTS))'], {
      env: { PATH: process.env.PATH ?? '', CINNA_EXTRA_CA_CERTS: path }, encoding: 'utf8'
    })
    expect(child.status).toBe(0)
    expect(child.stdout).toBe(path)
    expect(child.stderr).toContain(`Warning: Ignoring extra certs from ${path}, load failed: ENOENT\n`)
  })

  it('adds a valid file without a warning of its own', () => {
    const child = run({ NODE_EXTRA_CA_CERTS: file('child.pem', CERT_A) })
    expect(child.status).toBe(0)
    expect(child.stderr).not.toContain('Warning: Ignoring extra certs from /')
  })
})
