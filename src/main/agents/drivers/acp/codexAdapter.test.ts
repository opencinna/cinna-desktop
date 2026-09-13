import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { createCodexLauncher } from './codexLauncher'
import { isRefusal, newSessionParams } from './acpLaunchers'
import { toInputQuestions, toElicitationContent } from './acpQuestions'
import { toAcpPermissionRequest } from './acpPermissions'
import { startAcpConnection } from './acpConnection'
import type { SessionNotification } from '@agentclientprotocol/sdk'

describe('pinned Codex adapter over real stdio', () => {
  it('launches the selected CLI, streams a turn and resumes with current instructions and approval mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cinna-codex-adapter-'))
    const log = join(dir, 'requests.jsonl')
    const executable = join(dir, 'codex')
    // No real login or model requests. The adapter is real; only its app-server peer is scripted.
    writeFileSync(executable, `#!${process.execPath}\n${readFileSync(resolve('src/main/agents/drivers/acp/testSupport/fakeCodexAppServer.mjs'), 'utf8')}`, { mode: 0o755 })
    // The packaged adapter runs outside asar, without the excluded bundled Codex dependency.
    const adapter = join(dir, 'adapter.mjs')
    writeFileSync(adapter, readFileSync(createRequire(import.meta.url).resolve('@agentclientprotocol/codex-acp/dist/index.js')))
    const launcher = createCodexLauncher({
      path: async () => executable, auth: async () => ({ state: 'logged_in' }),
      adapterEntry: () => adapter,
      nodeRuntime: () => ({ command: process.execPath, args: [], env: {} }),
      env: async () => ({ HOME: dir, CODEX_HOME: dir, FAKE_CODEX_LOG: log }),
      systemPrompt: () => 'You are the Cinna folder agent.',
      settings: () => ({ model: 'test-model', effort: 'high', approval: 'ask' })
    })
    const plan = await launcher.plan({ userId: 'u', agentId: 'a', folder: { path: dir, name: 'A', slug: 'a', description: '', kind: 'bare' } })
    if (isRefusal(plan)) throw new Error(plan.error)
    let connection: Awaited<ReturnType<typeof startAcpConnection>> | undefined
    try {
      connection = await startAcpConnection(plan.spec, plan.init)
      expect(connection.initialized.agentCapabilities?.loadSession).toBe(true)
      const session = await connection.newSession(newSessionParams(plan, dir))
      const updates: SessionNotification[] = []
      const unbind = connection.bindSession(session.sessionId, {
        onUpdate: (update) => { updates.push(update) },
        onPermission: async (request) => {
          expect(toAcpPermissionRequest('codex', request, undefined).action).toBe('codex:execute')
          const option = request.options.find((option) => option.kind === 'allow_once')!
          return { outcome: { outcome: 'selected', optionId: option.optionId } }
        },
        onElicitation: async (request) => {
          const form = toInputQuestions(request)!
          expect(form.questions).toHaveLength(1)
          return { action: 'accept', content: toElicitationContent(form, [['Staging']]) }
        },
        onExtNotification() {}
      })
      await connection.setSessionMode({ sessionId: session.sessionId, modeId: plan.setup.modeId! })
      const result = await connection.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Hello' }] })
      expect(result.stopReason).toBe('end_turn')
      expect(JSON.stringify(updates)).toContain('Hello from Codex.')
      for (const [prompt, answer] of [['Ask for permission', 'Codex approval: accept.'], ['Ask a question', 'Codex answer: Staging.']]) {
        expect((await connection.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: prompt }] })).stopReason).toBe('end_turn')
        expect(JSON.stringify(updates)).toContain(answer)
      }
      const hanging = connection.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Wait until stopped' }] })
      // Wait for the actual native turn, so cancellation cannot race session setup.
      const deadline = Date.now() + 3000
      while (!readFileSync(log, 'utf8').includes('Wait until stopped')) {
        if (Date.now() > deadline) throw new Error('Codex turn did not start')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      await connection.cancel(session.sessionId)
      expect((await hanging).stopReason).toBe('cancelled')
      unbind()
      await connection.dispose()
      connection = await startAcpConnection(plan.spec, plan.init)
      await connection.loadSession({ ...newSessionParams(plan, dir), sessionId: session.sessionId })
      await connection.setSessionMode({ sessionId: session.sessionId, modeId: 'read-only' })
      const requests = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      const turn = requests.find((request) => request.method === 'turn/start')
      expect(turn.params).toMatchObject({ model: 'test-model', effort: 'high', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false } })
      for (const method of ['thread/start', 'thread/resume']) {
        expect(requests.find((request) => request.method === method)?.params.config).toMatchObject({ developer_instructions: 'You are the Cinna folder agent.', model: 'test-model', model_reasoning_effort: 'high' })
      }
    } finally {
      await connection?.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)
})
