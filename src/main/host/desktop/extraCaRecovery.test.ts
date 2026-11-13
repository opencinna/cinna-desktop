import { describe, expect, it, vi } from 'vitest'
import { expandWindowsVars, fromProcEnviron, fromRegQuery, recoverExtraCaCertsEnv, type ExtraCaRecoveryDeps } from './extraCaRecovery'
import { getLogEntries } from '../../logger/logger'

function deps(over: Partial<ExtraCaRecoveryDeps>): ExtraCaRecoveryDeps {
  return {
    platform: 'linux',
    env: {},
    readProcEnviron: () => { throw new Error('not read') },
    run: () => { throw new Error('not run') },
    ...over
  }
}

const regOut = (key: string, type: string, value: string): string =>
  `\r\n${key}\r\n    NODE_EXTRA_CA_CERTS    ${type}    ${value}\r\n\r\n`

describe('recoverExtraCaCertsEnv', () => {
  it('keeps a value already in the environment and looks nowhere', () => {
    const env = { NODE_EXTRA_CA_CERTS: '/dev/ca.pem' }
    const readProcEnviron = vi.fn()
    expect(recoverExtraCaCertsEnv(deps({ env, readProcEnviron }))).toBe('/dev/ca.pem')
    expect(readProcEnviron).not.toHaveBeenCalled()
  })

  it('Linux: reads the exact name from /proc/self/environ and puts it back into env', () => {
    const env: NodeJS.ProcessEnv = {}
    const raw = Buffer.from('PATH=/bin\0XNODE_EXTRA_CA_CERTS=/wrong\0NODE_EXTRA_CA_CERTS_OLD=/old\0NODE_EXTRA_CA_CERTS=/etc/corp ca.pem\0')
    expect(recoverExtraCaCertsEnv(deps({ env, readProcEnviron: () => raw }))).toBe('/etc/corp ca.pem')
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/etc/corp ca.pem')
  })

  it('Linux: nothing when the name is absent', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(recoverExtraCaCertsEnv(deps({ env, readProcEnviron: () => 'PATH=/bin\0' }))).toBeUndefined()
    expect('NODE_EXTRA_CA_CERTS' in env).toBe(false)
  })

  it('macOS: asks launchctl, argv only, and drops the trailing newline', () => {
    const env: NodeJS.ProcessEnv = {}
    const run = vi.fn(() => '/Users/me/corp.pem\n')
    expect(recoverExtraCaCertsEnv(deps({ platform: 'darwin', env, run }))).toBe('/Users/me/corp.pem')
    expect(run).toHaveBeenCalledWith('/bin/launchctl', ['getenv', 'NODE_EXTRA_CA_CERTS'])
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/Users/me/corp.pem')
  })

  it('macOS: an empty answer means unset', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(recoverExtraCaCertsEnv(deps({ platform: 'darwin', env, run: () => '\n' }))).toBeUndefined()
    expect('NODE_EXTRA_CA_CERTS' in env).toBe(false)
  })

  it('Windows: the user value wins over the machine value', () => {
    const run = vi.fn((_c: string, args: string[]) => args[1] === 'HKCU\\Environment'
      ? regOut('HKEY_CURRENT_USER\\Environment', 'REG_SZ', 'C:\\user.pem')
      : regOut('HKEY_LOCAL_MACHINE\\...', 'REG_SZ', 'C:\\machine.pem'))
    expect(recoverExtraCaCertsEnv(deps({ platform: 'win32', env: {}, run }))).toBe('C:\\user.pem')
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('C:\\Windows\\System32\\reg.exe', ['query', 'HKCU\\Environment', '/v', 'NODE_EXTRA_CA_CERTS'])
  })

  it('Windows: falls back to the machine value when the user has none (reg exits 1)', () => {
    const run = vi.fn((_c: string, args: string[]) => {
      if (args[1] === 'HKCU\\Environment') throw Object.assign(new Error('exit 1'), { status: 1 })
      return regOut('HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'REG_EXPAND_SZ', '%SystemRoot%\\certs\\%Missing%\\ca.pem')
    })
    const env: NodeJS.ProcessEnv = { SYSTEMROOT: 'C:\\Windows' }
    expect(recoverExtraCaCertsEnv(deps({ platform: 'win32', env, run }))).toBe('C:\\Windows\\certs\\%Missing%\\ca.pem')
    expect(run).toHaveBeenLastCalledWith('C:\\Windows\\System32\\reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', '/v', 'NODE_EXTRA_CA_CERTS'])
  })

  it('never throws: a failed lookup costs one debug line and no value', () => {
    const env: NodeJS.ProcessEnv = {}
    const before = getLogEntries().length
    const run = () => { throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }
    expect(recoverExtraCaCertsEnv(deps({ platform: 'darwin', env, run }))).toBeUndefined()
    expect(recoverExtraCaCertsEnv(deps({ platform: 'linux', env }))).toBeUndefined()
    expect('NODE_EXTRA_CA_CERTS' in env).toBe(false)
    const added = getLogEntries().slice(before).filter((e) => e.scope === 'tls')
    expect(added.map((e) => e.level)).toEqual(['debug', 'debug'])
    expect(added[0].data).toEqual({ platform: 'darwin', error: 'ETIMEDOUT' })
  })

  it('does nothing on other platforms', () => {
    expect(recoverExtraCaCertsEnv(deps({ platform: 'freebsd', env: {} }))).toBeUndefined()
  })
})

describe('parsers', () => {
  it('fromProcEnviron matches the exact name only', () => {
    expect(fromProcEnviron('A=1\0NODE_EXTRA_CA_CERTS=/x=y\0', 'NODE_EXTRA_CA_CERTS')).toBe('/x=y')
    expect(fromProcEnviron('', 'NODE_EXTRA_CA_CERTS')).toBeUndefined()
  })

  it('fromRegQuery keeps REG_SZ literal and ignores other values', () => {
    expect(fromRegQuery(regOut('HKCU', 'REG_SZ', '%USERPROFILE%\\ca.pem'), 'NODE_EXTRA_CA_CERTS', { USERPROFILE: 'C:\\u' })).toBe('%USERPROFILE%\\ca.pem')
    expect(fromRegQuery(regOut('HKCU', 'REG_DWORD', '0x1'), 'NODE_EXTRA_CA_CERTS', {})).toBeUndefined()
    expect(fromRegQuery('\r\nHKCU\r\n    Path    REG_SZ    C:\\bin\r\n', 'NODE_EXTRA_CA_CERTS', {})).toBeUndefined()
  })

  it('expandWindowsVars is case-insensitive and leaves unknown names', () => {
    expect(expandWindowsVars('%userprofile%\\%NOPE%\\a.pem', { USERPROFILE: 'C:\\Users\\me' })).toBe('C:\\Users\\me\\%NOPE%\\a.pem')
  })
})
