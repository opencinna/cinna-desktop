/**
 * The OpenCode child tracker on its own: an unmatched child's updates are held
 * and never go out without a lane (the driver replays live recordings in
 * `acpActivity.driver.test.ts`; this is the bound on what it holds).
 */
import { describe, expect, it } from 'vitest'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import { clearLogEntries, getLogEntries } from '../../../logger/logger'
import { HELD_LIMIT, OpencodeChildren } from './opencodeChildren'
import { CINNA_FRAME_META } from './types'

const ROOT = 'ses_root'
const laneOf = (frame: { update: unknown }): unknown =>
  ((frame.update as { _meta?: Record<string, { parentToolCallId?: string }> })._meta?.[CINNA_FRAME_META])?.parentToolCallId
const chunk = (text: string): Record<string, unknown> => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })

describe('OpencodeChildren', () => {
  it('holds an unmatched child’s updates up to the bound, then sends them, in order, under a lane of its own', () => {
    // Mutation: raise the bound out of reach (or drop the overflow release) and nothing comes out.
    clearLogEntries()
    const children = new OpencodeChildren(ROOT)
    children.observe({ sessionId: ROOT, update: { sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'subagent', name: 'subagent', rawInput: {} } } as never)
    expect(children.expand({ rootSessionId: ROOT, childSessionId: 'ses_child', title: 'Other', status: 'running' })).toHaveLength(1)
    const out: SessionNotification[] = []
    for (let i = 0; i < HELD_LIMIT - 1; i++) out.push(...children.expand({ rootSessionId: ROOT, childSessionId: 'ses_child', update: chunk(`t${i}`) }))
    expect(out).toEqual([])
    out.push(...children.expand({ rootSessionId: ROOT, childSessionId: 'ses_child', update: chunk('last') }))
    expect(out).toHaveLength(HELD_LIMIT)
    expect(new Set(out.map(laneOf))).toEqual(new Set(['subagent:ses_child']))
    expect((out.at(-1)!.update as { content: { text: string } }).content.text).toBe('last')
    // Later updates go straight out in the same lane.
    expect(children.expand({ rootSessionId: ROOT, childSessionId: 'ses_child', update: chunk('more') }).map(laneOf)).toEqual(['subagent:ses_child'])
    expect(getLogEntries().filter((entry) => entry.level === 'warn' && entry.message.includes('never matched'))).toHaveLength(1)
  })

  it('a match by title releases what the child held before the frame that matched it', () => {
    const children = new OpencodeChildren(ROOT)
    children.observe({ sessionId: ROOT, update: { sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'subagent', name: 'subagent', rawInput: {} } } as never)
    expect(children.expand({ rootSessionId: ROOT, childSessionId: 'ses_child', title: 'Probe', update: chunk('early') })).toEqual([])
    const released = children.observe({ sessionId: ROOT, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', rawInput: { agent: 'orch', description: 'Probe' } } } as never)
    expect(released.map(laneOf)).toEqual(['call_1'])
    expect(children.expand({ rootSessionId: ROOT, childSessionId: 'ses_child', update: chunk('later') }).map(laneOf)).toEqual(['call_1'])
  })

  it('a call that ended without naming a child names none later: a retry with the same description gets the next child', () => {
    // Mutation: drop `closed` and the retry's child is matched to the dead call_1.
    const children = new OpencodeChildren(ROOT)
    const call = (id: string, extra: Record<string, unknown>): void => {
      children.observe({ sessionId: ROOT, update: { sessionUpdate: 'tool_call_update', toolCallId: id, title: 'subagent', name: 'subagent', rawInput: { agent: 'orch', description: 'Probe' }, ...extra } } as never)
    }
    call('call_1', { status: 'in_progress' })
    call('call_1', { status: 'failed', rawOutput: { error: 'no such agent' } })
    call('call_2', { status: 'in_progress' })
    children.expand({ rootSessionId: ROOT, childSessionId: 'ses_retry', title: 'Probe', status: 'running' })
    expect(children.expand({ rootSessionId: ROOT, childSessionId: 'ses_retry', update: chunk('work') }).map(laneOf)).toEqual(['call_2'])
  })

  it('an ended child of the root goes out at once when the only call left ended without naming it', () => {
    // Mutation: as above; the dead call keeps the child held until the prompt answers.
    const children = new OpencodeChildren(ROOT)
    children.observe({ sessionId: ROOT, update: { sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'subagent', name: 'subagent', rawInput: { description: 'Probe' } } } as never)
    children.expand({ rootSessionId: ROOT, childSessionId: 'ses_child', title: 'Renamed', status: 'running' })
    expect(children.expand({ rootSessionId: ROOT, childSessionId: 'ses_child', update: chunk('work') })).toEqual([])
    children.expand({ rootSessionId: ROOT, childSessionId: 'ses_child', status: 'completed' })
    const released = children.observe({ sessionId: ROOT, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed', rawOutput: {} } } as never)
    expect(released.map(laneOf)).toEqual(['subagent:ses_child'])
  })
  it('at an answer, holds an unmatched child of a background child still running; any other end sends it', () => {
    // Mutation: drain everything at the answer → the grandchild goes out under `subagent:ses_worker` while its call may still name it.
    const children = new OpencodeChildren(ROOT)
    children.observe({ sessionId: ROOT, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', title: 'subagent', name: 'subagent', rawInput: { agent: 'orch', description: 'Probe' } } } as never)
    children.expand({ rootSessionId: ROOT, childSessionId: 'ses_orch', title: 'Probe', status: 'running' })
    children.expand({ rootSessionId: ROOT, childSessionId: 'ses_orch', update: { sessionUpdate: 'tool_call', toolCallId: 'ses_orch:call_2', title: 'subagent', name: 'subagent', rawInput: {} } })
    children.expand({ rootSessionId: ROOT, childSessionId: 'ses_worker', parentSessionId: 'ses_orch', title: 'Launch worker', status: 'running' })
    expect(children.expand({ rootSessionId: ROOT, childSessionId: 'ses_worker', parentSessionId: 'ses_orch', update: chunk('early') })).toEqual([])
    // An unmatched child of the root's goes out at the answer all the same.
    children.expand({ rootSessionId: ROOT, childSessionId: 'ses_stray', title: 'Stray', status: 'running' })
    expect(children.expand({ rootSessionId: ROOT, childSessionId: 'ses_stray', update: chunk('stray') })).toEqual([])
    expect(children.drain(true).map(laneOf)).toEqual(['subagent:ses_stray'])
    // Its parent's call gets its description: the held frame goes out in that lane.
    const released = children.expand({ rootSessionId: ROOT, childSessionId: 'ses_orch', update: { sessionUpdate: 'tool_call_update', toolCallId: 'ses_orch:call_2', rawInput: { agent: 'worker', description: 'Launch worker' } } })
    expect(released.map(laneOf)).toEqual(['call_1', 'ses_orch:call_2'])
  })

  it('outside an answer, sends an unmatched child of a running child under a lane of its own', () => {
    const children = new OpencodeChildren(ROOT)
    children.expand({ rootSessionId: ROOT, childSessionId: 'ses_orch', title: 'Probe', status: 'running' })
    children.expand({ rootSessionId: ROOT, childSessionId: 'ses_worker', parentSessionId: 'ses_orch', title: 'Launch worker', status: 'running' })
    expect(children.expand({ rootSessionId: ROOT, childSessionId: 'ses_worker', parentSessionId: 'ses_orch', update: chunk('early') })).toEqual([])
    expect(children.drain(true)).toHaveLength(0)
    expect(children.drain().map(laneOf)).toEqual(['subagent:ses_worker'])
  })
})
