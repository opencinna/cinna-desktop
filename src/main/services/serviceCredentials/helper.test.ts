import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { localBundle, validateLocal } from './transforms'
const folders: string[] = []
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })
it('reads refreshed arrays, explicit slots, placeholders and typed env fallbacks without merging', () => {
  const folder = mkdtempSync(join(tmpdir(), 'credential-reader-')); folders.push(folder)
  mkdirSync(join(folder, 'scripts')); mkdirSync(join(folder, 'credentials'))
  copyFileSync('resources/cinna-kit-contract/templates/agent/scripts/cinna_credentials.py', join(folder, 'scripts/cinna_credentials.py'))
  writeFileSync(join(folder, 'cinna-agent.json'), JSON.stringify({ credentials: [{ name: 'Mail', type: 'email_imap', env_prefix: 'MAIL_' }] }))
  writeFileSync(join(folder, 'credentials/.env'), 'MAIL_PORT=993\nMAIL_IS_SSL=true\nMAIL_LOGIN=file\n')
  const code = `
import json
from pathlib import Path
from cinna_credentials import get_credential, by_slot, require_slot, CredentialError
assert get_credential('email_imap') == {'port': 993, 'is_ssl': True, 'login': 'environment'}
p = Path('credentials/credentials.json')
entry = {'id': 'fixture', 'name': 'Mail', 'type': 'email_imap', 'service_uri': 'inbox', 'is_placeholder': False, 'credential_data': {'login': 'attached'}}
p.write_text(json.dumps([entry]))
assert get_credential('Mail') == {'login': 'attached'}
assert require_slot('inbox', 'email_imap') == {'login': 'attached'}
assert by_slot('Mail') is None
entry['credential_data']['login'] = 'rotated'
p.write_text(json.dumps({'credentials': [entry]}))
assert require_slot('inbox')['login'] == 'rotated'
entry['is_placeholder'] = True
p.write_text(json.dumps([entry]))
assert get_credential('Mail') is None
try:
    require_slot('inbox')
    raise AssertionError('placeholder accepted')
except CredentialError:
    pass
p.unlink()
Path('credentials.json').write_text(json.dumps({'Mail': {'login': 'legacy'}}))
assert get_credential('Mail', 'login') == 'legacy'
`
  execFileSync('python3', ['-c', code], { cwd: folder, env: { ...process.env, PYTHONPATH: join(folder, 'scripts'), MAIL_LOGIN: 'environment', CINNA_CREDENTIALS_PATH: '' } })
})
it('matches the Core token and service-account delivery fixtures', () => {
  const token = { name: 'API', type: 'api_token' as const, serviceUri: 'slot', values: { api_token_type: 'custom', api_token_template: 'X-Key: prefix {TOKEN}', api_token: 'fixture-secret' } }
  expect(localBundle('token', token, validateLocal(token)).entry.credential_data).toEqual({ http_header_name: 'X-Key', http_header_value: 'prefix fixture-secret', service_uri: 'slot' })
  const sa = { name: 'SA', type: 'google_service_account' as const, values: { type: 'service_account', project_id: 'fixture', private_key: 'private-fixture', client_email: 'fixture@example.test' } }
  const bundle = localBundle('sa', sa, validateLocal(sa))
  expect(bundle.service_account_file).toEqual(sa.values)
  expect(bundle.entry.credential_data).toEqual({ file_path: 'credentials/sa.json', project_id: 'fixture', client_email: 'fixture@example.test' })
  expect(bundle.entry.is_placeholder).toBe(false)
})

it('does not use a token for a different declared service even when the type matches', () => {
  const folder = mkdtempSync(join(tmpdir(), 'credential-slots-')); folders.push(folder)
  mkdirSync(join(folder, 'scripts')); mkdirSync(join(folder, 'credentials'))
  copyFileSync('resources/cinna-kit-contract/templates/agent/scripts/cinna_credentials.py', join(folder, 'scripts/cinna_credentials.py'))
  const code = `
import json
from pathlib import Path
from cinna_credentials import get_credential
manifest = Path('cinna-agent.json')
manifest.write_text(json.dumps({'credentials': [{'name': 'Slack', 'type': 'api_token'}]}))
entry = {'name': 'GitHub', 'type': 'api_token', 'service_uri': 'github', 'is_placeholder': False, 'credential_data': {'token': 'fixture-github'}}
p = Path('credentials/credentials.json')
p.write_text(json.dumps([entry]))
assert get_credential('Slack') is None
entry['name'] = 'Slack'
p.write_text(json.dumps([entry]))
assert get_credential('Slack') == {'token': 'fixture-github'}
manifest.write_text(json.dumps({'credentials': [{'name': 'Slack', 'type': 'api_token', 'service_uri': 'slack-workspace'}]}))
assert get_credential('Slack') is None
entry['service_uri'] = 'slack-workspace'
p.write_text(json.dumps([entry]))
assert get_credential('Slack') == {'token': 'fixture-github'}
entry['type'] = 'email_imap'
p.write_text(json.dumps([entry]))
assert get_credential('Slack') is None
`
  execFileSync('python3', ['-c', code], { cwd: folder, env: { ...process.env, PYTHONPATH: join(folder, 'scripts'), CINNA_CREDENTIALS_PATH: '' } })
})
