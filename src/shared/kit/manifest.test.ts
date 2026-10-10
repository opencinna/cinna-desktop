import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { deriveEnvPrefix, slotEnvPrefix } from './manifest'

const SCRIPTS = 'resources/cinna-agent-kit/templates/agent/scripts'

/** The kit's own `derive_env_prefix` on each name; null where it raises. */
function deriveByKit(names: string[]): (string | null)[] {
  const code = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
    'from cinna_credentials import derive_env_prefix, CredentialError',
    'def one(n):',
    '    try: return derive_env_prefix(n)',
    '    except CredentialError: return None',
    'sys.stdout.write(json.dumps([one(n) for n in json.loads(sys.stdin.read())]))'
  ].join('\n')
  return JSON.parse(execFileSync('python3', ['-I', '-c', code], { input: JSON.stringify(names), encoding: 'utf8' }))
}

/** Each name with the prefix the kit derives for it. */
const TABLE: [string, string | null][] = [
  ['Vendor Portal', 'VENDOR_PORTAL_'],
  ['weather', 'WEATHER_'],
  ['acme-api', 'ACME_API_'],
  ['  Mail  (IMAP) ', 'MAIL_IMAP_'],
  ['__x__', 'X_'],
  ['3scale', 'C_3SCALE_'],
  ['_9 lives', 'C_9_LIVES_'],
  ['Ünïcode Straße', 'N_CODE_STRA_E_'],
  ['пароль', null],
  ['', null],
  ['---', null],
  ['a', 'A_'],
  ['MiXeD_case.Name', 'MIXED_CASE_NAME_'],
  ['tab\there\nnewline', 'TAB_HERE_NEWLINE_']
]

describe('the derived .env prefix', () => {
  it('matches the table', () => {
    for (const [name, prefix] of TABLE) expect([name, deriveEnvPrefix(name)]).toEqual([name, prefix])
  })

  it('matches the kit script on the same names', () => {
    expect(TABLE.map(([name]) => deriveEnvPrefix(name))).toEqual(deriveByKit(TABLE.map(([name]) => name)))
  })

  it('uses a declared prefix as it is, and derives only when there is none', () => {
    expect(slotEnvPrefix({ name: 'Vendor Portal', env_prefix: 'VP_' })).toBe('VP_')
    expect(slotEnvPrefix({ name: 'Vendor Portal', env_prefix: '' })).toBe('VENDOR_PORTAL_')
    expect(slotEnvPrefix({ name: 'Vendor Portal' })).toBe('VENDOR_PORTAL_')
    expect(slotEnvPrefix({ name: 7 })).toBeNull()
  })
})
