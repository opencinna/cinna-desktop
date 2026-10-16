import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import type { ServiceCredentialBundle } from '../../../shared/serviceCredentials'
const world = vi.hoisted(() => ({ home: '' }))
vi.mock('../../host/runtimeHost', () => ({ runtimeHost: { getPath: () => world.home } }))
import { writeCredentials } from './files'

const folders: string[] = []
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })
/** A kit agent whose credentials/.gitignore is the bundled template, committed. */
function kitAgent(): string {
  const root = mkdtempSync(join(tmpdir(), 'credential-files-')); folders.push(root)
  world.home = join(root, 'userData'); mkdirSync(world.home)
  const agent = join(root, 'agent'); mkdirSync(join(agent, 'credentials'), { recursive: true })
  writeFileSync(join(agent, 'credentials/.gitignore'), readFileSync('resources/cinna-agent-kit/templates/agent/credentials/.gitignore'))
  execFileSync('git', ['init', '-q', agent]); execFileSync('git', ['-C', agent, 'add', 'credentials/.gitignore'])
  return agent
}
const serviceAccount = (id: string): ServiceCredentialBundle => ({ id, revision: '1', ssh_key: null, service_account_file: { type: 'service_account', private_key: 'private-fixture' },
  entry: { id, name: 'SA', type: 'google_service_account', notes: null, service_uri: null, is_placeholder: false, credential_data: { project_id: 'fixture' } } })

it('writes a shared service account into a committed kit agent without touching its ignore file', async () => {
  const agent = kitAgent()
  await writeCredentials(agent, 'kit', [serviceAccount('cloud-id')], [], 'g1')
  const [entry] = JSON.parse(readFileSync(join(agent, 'credentials/credentials.json'), 'utf8'))
  expect(entry.credential_data.file_path).toBe('credentials/cloud-id/credentials.json')
  expect(JSON.parse(readFileSync(join(agent, entry.credential_data.file_path), 'utf8')).private_key).toBe('private-fixture')
  expect(execFileSync('git', ['-C', agent, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' })).toBe('A  credentials/.gitignore\n')
  // Detaching removes the side file and its now-empty folder.
  await writeCredentials(agent, 'kit', [], [], 'g2')
  expect(existsSync(join(agent, 'credentials/cloud-id'))).toBe(false)
})

it('still refuses a credential file git already tracks, naming it', async () => {
  const agent = kitAgent()
  mkdirSync(join(agent, 'credentials/cloud-id')); writeFileSync(join(agent, 'credentials/cloud-id/credentials.json'), '{}\n')
  execFileSync('git', ['-C', agent, 'add', '-f', 'credentials/cloud-id/credentials.json'])
  await expect(writeCredentials(agent, 'kit', [serviceAccount('cloud-id')], [], 'g1')).rejects.toThrow('credentials/cloud-id/credentials.json is tracked by git')
  expect(readFileSync(join(agent, 'credentials/cloud-id/credentials.json'), 'utf8')).toBe('{}\n')
})
