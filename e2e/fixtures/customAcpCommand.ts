import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FakeAcpLogEntry, FakeAcpScript } from '../../src/main/agents/drivers/acp/testSupport/fakeAcp'
import type { CustomAgentConfig } from '../../src/shared/customAgents'
import type { CinnaApp } from './app'
import { repoRoot } from '../playwright.config'

export const CUSTOM_NAME = 'Remote Checklist ACP'
export const CUSTOM_VERSION = '2.4.6-fixture'
export const CUSTOM_AUTH = 'Existing SSH agent login'
export const CUSTOM_CWD = '/remote-only/workspaces/checklist'
export const CUSTOM_PROMPT = 'Check the remote deployment notes.'
export const CUSTOM_PARTIAL = 'Remote checklist inspected: cedar-1964.'
export const CUSTOM_ANSWER = 'Remote checklist approved: maple-5281.'
export const CUSTOM_STDERR = 'fixture diagnostic belongs on stderr: birch-9032'
export const CUSTOM_REFUSAL = 'Fixture SSH command refused initialization.'
export const CUSTOM_ARGS = ['literal argument with spaces', 'literal;dollar$and\'quote"']
export const CUSTOM_SCRIPT: FakeAcpScript = {
  stderr: [CUSTOM_STDERR],
  initialize: { response: { agentInfo: { name: CUSTOM_NAME, version: CUSTOM_VERSION },
    authMethods: [{ id: 'fixture-existing-login', name: CUSTOM_AUTH, description: 'A separately configured CLI login.' }] } },
  prompt: { emit: [
    { kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: CUSTOM_PARTIAL } } },
    { kind: 'permission', toolCall: { toolCallId: 'custom-checklist-edit', title: 'Edit remote checklist', kind: 'edit', status: 'pending',
      rawInput: { filepath: `${CUSTOM_CWD}/checklist.txt`, diff: '+ approved' } } },
    { kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: CUSTOM_ANSWER } } }
  ] }
}
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
/** No engine setting or credential: this JSON command is what the user adds. */
export function customAcpCommand(cinna: CinnaApp, initial: FakeAcpScript = CUSTOM_SCRIPT) {
  const dir = join(cinna.sandbox.root, 'custom command fixture'); mkdirSync(dir)
  const scriptPath = join(dir, 'script.json'), logPath = join(dir, 'peer.jsonl'), wirePath = join(dir, 'stdout.ndjson')
  writeFileSync(scriptPath, JSON.stringify(initial))
  const exports = `export FAKE_ACP_SCRIPT=${quote(scriptPath)} FAKE_ACP_LOG=${quote(logPath)} FAKE_ACP_WIRE_LOG=${quote(wirePath)}; exec "$@"`
  const config: CustomAgentConfig = { launcher: 'custom', cwd: CUSTOM_CWD, localCwd: realpathSync(dir),
    command: ['/bin/sh', '-c', exports, 'custom-ssh-fixture', process.execPath,
      join(repoRoot, 'src/main/agents/drivers/acp/testSupport/fakeAcpAgent.mjs'), ...CUSTOM_ARGS] }
  const log = (): FakeAcpLogEntry[] => existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  return { config, scriptPath, logPath, wirePath, log,
    received: (method: string) => log().filter(row => row.dir === 'in' && row.method === method),
    answers: () => log().filter(row => row.dir === 'answer' && row.method === 'session/request_permission'),
    setScript: (script: FakeAcpScript) => writeFileSync(scriptPath, JSON.stringify(script)),
    stdout: () => existsSync(wirePath) ? readFileSync(wirePath, 'utf8').split('\n').filter(Boolean) : [] }
}
export type CustomAcpCommand = ReturnType<typeof customAcpCommand>
