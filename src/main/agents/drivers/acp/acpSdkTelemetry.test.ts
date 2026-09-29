import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setDebugEnabled } from '../../../logger/logger'
import { AcpMessageStream } from './acpMessages'
import { RAW_SDK_MESSAGE_FILTER, readSdkMessage, SDK_MESSAGE_METHOD, sdkFrameLabel } from './acpSdkTelemetry'
import {
  assistantMessage,
  compactMessage,
  initMessage,
  resultMessage,
  SDK_SESSION,
  sdkParams
} from './testSupport/sdkMessageFixtures'

// Whatever the environment says (`CINNA_LOG_DEBUG`), frames are read with debug detail off.
beforeEach(() => setDebugEnabled(false))

describe('Claude’s raw SDK frames', () => {
  it('asks for init, compaction, assistant and result frames, in one constant', () => {
    expect(RAW_SDK_MESSAGE_FILTER).toEqual([
      { type: 'system', subtype: 'init' },
      { type: 'system', subtype: 'compact_boundary' },
      { type: 'assistant' },
      { type: 'result' }
    ])
  })

  it('reads system/init into the model, CLI version, betas, effort, fast mode and key source', () => {
    const frame = readSdkMessage(sdkParams(initMessage))
    expect(frame).toMatchObject({
      kind: 'init',
      sessionId: SDK_SESSION,
      model: 'claude-sonnet-5[1m]',
      cliVersion: '2.1.274',
      betas: ['context-1m-2026-01-01'],
      effort: 'high',
      fastMode: 'off',
      apiKeySource: 'none'
    })
    // Not sized unless debug detail is on.
    expect(frame).not.toHaveProperty('bytes')
    // No effort sent is null, not absent.
    expect(readSdkMessage(sdkParams({ ...initMessage, effort: null }))).toMatchObject({ effort: null })
  })

  it('reads a main-agent assistant frame’s id, model and usage with its TTL split, and never its content', () => {
    const frame = readSdkMessage(sdkParams(assistantMessage({ id: 'msg_1', input: 5, cacheRead: 1_000, write5m: 200, write1h: 300 })))
    expect(frame).toEqual({
      kind: 'assistant',
      sessionId: SDK_SESSION,
      main: true,
      messageId: 'msg_1',
      model: 'claude-sonnet-5-20260101',
      usage: { input: 5, output: 50, cacheRead: 1_000, cacheWrite: 500, cacheWrite5m: 200, cacheWrite1h: 300 }
    })
    expect(JSON.stringify(frame)).not.toContain('SECRET')
  })

  it('marks a subagent’s assistant frame as not the main agent’s', () => {
    expect(readSdkMessage(sdkParams(assistantMessage({ id: 'msg_2', parent: 'toolu_agent' })))).toMatchObject({ kind: 'assistant', main: false })
  })

  it('reads a result’s per-model cost, window, max output and basis, its usage, durations and request count', () => {
    const frame = readSdkMessage(sdkParams(resultMessage({
      costs: { 'claude-sonnet-5[1m]': 0.3, 'claude-haiku-4-5-20251001': 0.01 },
      windows: { 'claude-sonnet-5[1m]': 1_000_000 },
      basis: { 'claude-haiku-4-5-20251001': 'managed' },
      numTurns: 3,
      durationMs: 9_000,
      apiDurationMs: 7_000
    })))
    expect(frame).toEqual({
      kind: 'result',
      sessionId: SDK_SESSION,
      usage: { input: 12, output: 300, cacheRead: 20_000, cacheWrite: 1_000, cacheWrite5m: 1_000, cacheWrite1h: 0 },
      models: {
        'claude-sonnet-5[1m]': { costUsd: 0.3, contextWindow: 1_000_000, maxOutputTokens: 64_000 },
        'claude-haiku-4-5-20251001': { costUsd: 0.01, contextWindow: 200_000, maxOutputTokens: 64_000, costBasis: 'managed' }
      },
      durationMs: 9_000,
      apiDurationMs: 7_000,
      numTurns: 3
    })
    expect(JSON.stringify(frame)).not.toContain('SECRET')
  })

  it('reads a compaction boundary, labels anything else by type, and ignores params without a session', () => {
    expect(readSdkMessage(sdkParams(compactMessage))).toMatchObject({ kind: 'compact', sessionId: SDK_SESSION })
    const other = readSdkMessage(sdkParams({ type: 'system', subtype: 'status', status: 'compacting' }))
    expect(other).toMatchObject({ kind: 'other' })
    expect(sdkFrameLabel(other!)).toBe('system/status')
    expect(readSdkMessage({ message: initMessage })).toBeNull()
  })

  it('reads a malformed frame defensively', () => {
    expect(readSdkMessage(sdkParams({ type: 'assistant', message: { usage: 'nope', model: 7 } }))).toEqual({
      kind: 'assistant', sessionId: SDK_SESSION, main: true
    })
    expect(readSdkMessage(sdkParams({ type: 'result', modelUsage: { m: { costUSD: 'x', contextWindow: -1 } } }))).toMatchObject({
      kind: 'result', models: { m: {} }
    })
  })

  describe('the frame’s size', () => {
    afterEach(() => {
      setDebugEnabled(false)
      vi.restoreAllMocks()
    })

    it('is not measured while debug detail is off: the frame is never serialized', () => {
      const params = sdkParams(resultMessage({ costs: { 'claude-sonnet-5[1m]': 0.01 } }))
      const stringify = vi.spyOn(JSON, 'stringify')
      const frame = readSdkMessage(params)
      expect(stringify).not.toHaveBeenCalled()
      expect(frame).toMatchObject({ kind: 'result' })
      expect(frame).not.toHaveProperty('bytes')
    })

    it('is the notification’s JSON length while debug detail is on', () => {
      setDebugEnabled(true)
      const params = sdkParams(initMessage)
      expect(readSdkMessage(params)!.bytes).toBe(JSON.stringify(params).length)
    })
  })

  it('reaches the driver through applyExt as telemetry, never as a message', () => {
    const stream = new AcpMessageStream({ launcher: 'claude' })
    const update = stream.applyExt(SDK_MESSAGE_METHOD, sdkParams(assistantMessage({ id: 'msg_1' })))
    expect(update.message).toBeUndefined()
    expect(update.sdk).toMatchObject({ kind: 'assistant', messageId: 'msg_1' })
    expect(stream.applyExt('_session/steering', { sessionId: SDK_SESSION })).toEqual({})
  })
})
