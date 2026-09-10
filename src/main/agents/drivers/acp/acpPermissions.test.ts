/**
 * The permission mapping, against the shapes the two engines actually send.
 *
 * Every `params` object here is copied from a spike recording rather than
 * invented — `spike/acp/opencode/recordings/q2-permission.ndjson` for OpenCode
 * and `spike/acp/claude/recordings/s2-perms-turn.ndjson` for Claude — because
 * the whole risk in this file is a field name: an ask whose resource is read
 * out of the wrong key produces a grant scoped to the *whole action*, which is
 * the widest rule this app can write and looks like a correct one.
 */

import { describe, expect, it } from 'vitest'
import type { PermissionOption, RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { mintAcpRequestId, pickPermissionOption, toAcpPermissionRequest } from './acpPermissions'

/** The three options OpenCode offers, verbatim. Claude offers the same set. */
const OPTIONS: PermissionOption[] = [
  { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
  { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
  { optionId: 'reject', kind: 'reject_once', name: 'Reject' }
]

function ask(toolCall: Record<string, unknown>, options = OPTIONS): RequestPermissionRequest {
  return {
    sessionId: 'ses_1',
    toolCall: toolCall as RequestPermissionRequest['toolCall'],
    options
  }
}

describe('toAcpPermissionRequest — OpenCode', () => {
  it('reads an edit ask’s path out of the lower-case `filepath` the ask uses', () => {
    const request = toAcpPermissionRequest(
      'opencode',
      ask({
        toolCallId: 'call_h5kx0vip',
        title: '/private/tmp/agent1/notes.txt',
        kind: 'edit',
        status: 'pending',
        locations: [{ path: '/private/tmp/agent1/notes.txt' }],
        rawInput: {
          filepath: '/private/tmp/agent1/notes.txt',
          diff: 'Index: notes.txt\n+hello from spike\n'
        }
      }),
      'write'
    )
    expect(request).toEqual({
      action: 'edit',
      resources: ['/private/tmp/agent1/notes.txt'],
      savable: [],
      callId: 'call_h5kx0vip'
    })
  })

  it('maps `execute` to the `bash` a grant on disk was written under', () => {
    const request = toAcpPermissionRequest(
      'opencode',
      ask({
        toolCallId: 'call_dv44kkcu',
        title: 'echo spike > bash_out.txt',
        kind: 'execute',
        status: 'pending',
        locations: [],
        rawInput: { command: 'echo spike > bash_out.txt' }
      }),
      'bash'
    )
    expect(request.action).toBe('bash')
    expect(request.resources).toEqual(['echo spike > bash_out.txt'])
  })

  it('falls back to the tracked tool name for a kind the profile has no word for', () => {
    // An MCP tool arrives as `kind: 'other'`, and its name is the only thing
    // that identifies it — `spike-mcp_secret_number` in the MCP probe.
    const request = toAcpPermissionRequest(
      'opencode',
      ask({
        toolCallId: 'call_z6ammnfg',
        title: 'spike-mcp_secret_number',
        kind: 'other',
        status: 'pending',
        rawInput: { name: 'ada' }
      }),
      'spike-mcp_secret_number'
    )
    expect(request.action).toBe('spike-mcp_secret_number')
  })

  it('takes a location when no input field named the resource', () => {
    const request = toAcpPermissionRequest(
      'opencode',
      ask({
        toolCallId: 'call_1',
        kind: 'edit',
        status: 'pending',
        locations: [{ path: '/tmp/agent1/a.txt' }],
        rawInput: { somethingNew: '/tmp/agent1/a.txt' }
      }),
      'write'
    )
    expect(request.resources).toEqual(['/tmp/agent1/a.txt'])
  })

  it('names the action rather than nothing when the ask carries no resource at all', () => {
    const request = toAcpPermissionRequest(
      'opencode',
      ask({ toolCallId: 'call_2', kind: 'execute', status: 'pending' }),
      'bash'
    )
    expect(request.action).toBe('bash')
    expect(request.resources).toEqual([])
  })
})

describe('toAcpPermissionRequest — Claude', () => {
  it('keeps the CLI’s own tool name, so a grant written under the SDK runner still matches', () => {
    const request = toAcpPermissionRequest(
      'claude',
      ask({
        toolCallId: 'toolu_01',
        name: 'Bash',
        kind: 'execute',
        status: 'pending',
        rawInput: { command: 'ls -la', description: 'List files' }
      }),
      undefined
    )
    expect(request.action).toBe('Bash')
    expect(request.resources).toEqual(['ls -la'])
    expect(request.callId).toBe('toolu_01')
  })

  it('reads the name out of `_meta.claudeCode.toolName` when the extra field is absent', () => {
    const request = toAcpPermissionRequest(
      'claude',
      ask({
        toolCallId: 'toolu_02',
        kind: 'edit',
        status: 'pending',
        _meta: { claudeCode: { toolName: 'Write' } },
        rawInput: { file_path: '/tmp/agent/out.txt', content: 'x' }
      }),
      undefined
    )
    expect(request.action).toBe('Write')
    expect(request.resources).toEqual(['/tmp/agent/out.txt'])
  })

  it('does not translate Claude’s vocabulary into OpenCode’s', () => {
    // The two engines' grants live in one store, keyed by action. Folding
    // `Bash` into `bash` would make a rule the user granted to one engine
    // authorise the other.
    const claude = toAcpPermissionRequest(
      'claude',
      ask({ toolCallId: 't', name: 'Bash', kind: 'execute', rawInput: { command: 'rm -rf x' } }),
      undefined
    )
    const opencode = toAcpPermissionRequest(
      'opencode',
      ask({ toolCallId: 't', kind: 'execute', rawInput: { command: 'rm -rf x' } }),
      'bash'
    )
    expect(claude.action).not.toBe(opencode.action)
  })
})

describe('pickPermissionOption', () => {
  it('answers an allow with `allow_once`', () => {
    expect(pickPermissionOption(OPTIONS, 'allow')).toBe('once')
  })

  it('answers a reject with `reject_once`', () => {
    expect(pickPermissionOption(OPTIONS, 'reject')).toBe('reject')
  })

  it('never selects `allow_always`, even when it is the only allow offered', () => {
    // The whole reason the desktop keeps its own grant store: OpenCode's
    // `always` writes a per-project row that survives the process and silences
    // later sessions, and Claude's writes into the user's own `~/.claude`.
    const onlyAlways: PermissionOption[] = [
      { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
      { optionId: 'reject', kind: 'reject_once', name: 'Reject' }
    ]
    expect(pickPermissionOption(onlyAlways, 'allow')).toBeNull()
  })

  it('never selects `reject_always` either', () => {
    const rejectAlways: PermissionOption[] = [
      { optionId: 'never', kind: 'reject_always', name: 'Never' }
    ]
    expect(pickPermissionOption(rejectAlways, 'reject')).toBeNull()
  })
})

describe('mintAcpRequestId', () => {
  it('prefixes ids the renderer’s read-only replay rule gates on', () => {
    expect(mintAcpRequestId('permission')).toMatch(/^per_acp_/)
    expect(mintAcpRequestId('question')).toMatch(/^que_acp_/)
  })

  it('is unique within a turn', () => {
    const ids = new Set([0, 1, 2, 3].map(() => mintAcpRequestId('permission')))
    expect(ids.size).toBe(4)
  })
})
