import { describe, expect, it } from 'vitest'
import type { RequestPermissionRequest, CreateElicitationRequest } from '@agentclientprotocol/sdk'
import { toAcpPermissionRequest } from './acpPermissions'
import { toInputQuestions, toElicitationContent } from './acpQuestions'
import { isPermissionGranted, permissionGrantPatterns } from '../../../../shared/localAgentRequests'

function request(toolCall: RequestPermissionRequest['toolCall']): RequestPermissionRequest {
  return { sessionId: 's', options: [], toolCall }
}

describe('Codex permission and question translation', () => {
  it('keeps all files in a patch and cannot reuse another engine’s grants', () => {
    const ask = toAcpPermissionRequest('codex', request({ toolCallId: 'edit', kind: 'edit', locations: [{ path: '/a' }, { path: '/b' }] }), undefined)
    expect(ask.resources).toEqual(['/a', '/b'])
    expect(ask.action).toBe('codex:edit')
    const grants = permissionGrantPatterns(ask).map((p) => ({ ...p, action: ask.action, decidedAt: 1 }))
    expect(isPermissionGranted(ask, grants.slice(0, 1))).toBe(false)
    expect(isPermissionGranted(ask, grants)).toBe(true)
    expect(isPermissionGranted(ask, grants.map((p) => ({ ...p, action: 'edit' })))).toBe(false)
  })

  it('scopes a command grant to its cwd and additional requested privileges', () => {
    const first = toAcpPermissionRequest('codex', request({ toolCallId: 'c1', kind: 'execute', rawInput: { command: 'build', cwd: '/a' } }), undefined)
    const grants = permissionGrantPatterns(first).map((p) => ({ ...p, action: first.action, decidedAt: 1 }))
    for (const rawInput of [{ command: 'build', cwd: '/b' }, { command: 'build', cwd: '/a', url: 'https://example.com' }, { command: 'build', cwd: '/a', additionalPermissions: { network: { enabled: true } } }]) {
      const next = toAcpPermissionRequest('codex', request({ toolCallId: 'c2', kind: 'execute', rawInput }), undefined)
      expect(isPermissionGranted(next, grants)).toBe(false)
    }
  })

  it('cannot combine a command grant with privileges granted to another command', () => {
    const ask = (command: string, elevated: boolean) => toAcpPermissionRequest('codex', request({
      toolCallId: command, kind: 'execute', rawInput: {
        command, cwd: '/a', ...(elevated ? { additionalPermissions: { network: { enabled: true } } } : {})
      }
    }), undefined)
    const granted = [ask('first', false), ask('second', true)].flatMap((r) =>
      permissionGrantPatterns(r).map((p) => ({ ...p, action: r.action, decidedAt: 1 })))
    expect(isPermissionGranted(ask('first', true), granted)).toBe(false)
    expect(isPermissionGranted(ask('second', true), granted)).toBe(true)
  })

  it('keeps SOCKS host and protocol scope that the adapter carries outside rawInput', () => {
    const ask = (host: string, protocol: string, id: string) => toAcpPermissionRequest('codex', request({
      toolCallId: id, kind: 'execute',
      rawInput: { command: 'connect', cwd: '/a' },
      title: `${protocol} network access to ${host}`,
      content: [{ type: 'content', content: { type: 'text', text: `${protocol} access to ${host}` } }]
    }), undefined)
    const first = ask('allowed.example', 'socks5Tcp', 'first')
    const grants = permissionGrantPatterns(first).map((p) => ({ ...p, action: first.action, decidedAt: 1 }))
    expect(isPermissionGranted(ask('allowed.example', 'socks5Tcp', 'second'), grants)).toBe(true)
    expect(isPermissionGranted(ask('other.example', 'socks5Tcp', 'third'), grants)).toBe(false)
    expect(isPermissionGranted(ask('allowed.example', 'socks5Udp', 'fourth'), grants)).toBe(false)
  })

  it('never turns an unknown request into a grant for every action', () => {
    const ask = toAcpPermissionRequest('codex', request({ toolCallId: 'unknown', kind: 'other' }), undefined)
    expect(permissionGrantPatterns(ask)[0].scope).toBe('exact')
  })

  it('maps Codex choice and free-text answers back to the original field IDs', () => {
    const form = toInputQuestions({ sessionId: 's', mode: 'form', message: 'Which deployment?', requestedSchema: {
      type: 'object', properties: {
        deploy: { type: 'string', title: 'Deploy', oneOf: [{ const: 'Staging', title: 'Staging' }] },
        deploy_other: { type: 'string', _meta: { codex: { questionId: 'deploy', isOtherAnswer: true } } }
      }
    } } as unknown as CreateElicitationRequest)!
    expect(form.questions).toHaveLength(1)
    expect(toElicitationContent(form, [['Staging']])).toEqual({ deploy: 'Staging' })
    expect(toElicitationContent(form, [['A private preview']])).toEqual({ deploy: 'A private preview' })
  })
})
