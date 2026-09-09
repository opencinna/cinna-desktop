import { describe, it, expect } from 'vitest'
import { ClaudeMessageStream, describeClaudeToolCall } from './claudeMessages'
import { StreamPartsAccumulator } from '../../agents/streamPartsAccumulator'
import type { AgentStreamEvent } from '../../../shared/agentStreamEvents'

/**
 * The SDK message stream → A2A-shaped parts.
 *
 * The fixtures below are **the real wire order**, transcribed from a live turn
 * against `claude` 2.1.266 (see `docs/agents/local_agents/claude_contract.md`
 * §2) rather than invented from the type definitions. That matters more here
 * than usual: the published reference and the shipped `sdk.d.ts` disagree about
 * this stream, and the two facts the translator is built around — that
 * `assistant` arrives once per *content block*, and that only `message_start`
 * carries a message id — are in neither.
 *
 * The property under test throughout is the one that cannot be seen by reading
 * either class alone: **fed through `StreamPartsAccumulator`, the result must
 * carry each character exactly once.** The accumulator computes
 * `text.slice(prior.length)` from cumulative text, and the SDK sends true
 * deltas, so the whole risk of this file is double-counting.
 */

/** Drive a stream through the accumulator, as the runner does. */
function run(messages: unknown[]): {
  answer: string
  parts: ReturnType<StreamPartsAccumulator['snapshotParts']>
  deltas: AgentStreamEvent[]
  ended: { isError: boolean; text: string } | undefined
  apiKeySource: string | undefined
} {
  const stream = new ClaudeMessageStream()
  const accumulator = new StreamPartsAccumulator()
  const deltas: AgentStreamEvent[] = []
  const port = { postMessage: (e: AgentStreamEvent): void => void deltas.push(e) }
  let ended: { isError: boolean; text: string } | undefined
  let apiKeySource: string | undefined

  for (const message of messages) {
    const update = stream.apply(message)
    if (update.apiKeySource) apiKeySource = update.apiKeySource
    if (update.ended) ended = update.ended
    if (update.message) accumulator.ingestMessage(update.message, port)
  }
  return {
    answer: accumulator.answerText(),
    parts: accumulator.snapshotParts(),
    deltas,
    ended,
    apiKeySource
  }
}

const MSG = 'msg_011CesnRsBEZc7tpLqjGf8DG'
const MSG2 = 'msg_011CesnSAuqGYRHRjd6DTTpp'
const TOOL = 'toolu_01RWFBUhQ8yLGuibVKnypcL4'

const init = {
  type: 'system',
  subtype: 'init',
  session_id: 'sess-1',
  apiKeySource: 'none',
  model: 'claude-opus-5',
  claude_code_version: '2.1.266'
}
const start = (id: string): unknown => ({
  type: 'stream_event',
  session_id: 'sess-1',
  event: { type: 'message_start', message: { id } }
})
const blockStart = (index: number, type: string, name?: string): unknown => ({
  type: 'stream_event',
  event: { type: 'content_block_start', index, content_block: { type, name } }
})
const textDelta = (index: number, text: string): unknown => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }
})
const blockStop = (index: number): unknown => ({
  type: 'stream_event',
  event: { type: 'content_block_stop', index }
})
const assistantText = (id: string, text: string): unknown => ({
  type: 'assistant',
  message: { id, content: [{ type: 'text', text }] }
})
const result = (over: Record<string, unknown> = {}): unknown => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'done',
  num_turns: 2,
  ...over
})

describe('text', () => {
  it('carries each character exactly once through the accumulator', () => {
    // The one bug this whole class exists to avoid. Both the delta stream and
    // the `assistant` message carry the same text; counting both duplicates it.
    const out = run([
      init,
      start(MSG),
      blockStart(0, 'text'),
      textDelta(0, 'mar'),
      textDelta(0, 'zipan'),
      assistantText(MSG, 'marzipan'),
      blockStop(0),
      result()
    ])
    expect(out.answer).toBe('marzipan')
    expect(out.parts.filter((p) => p.kind === 'text')).toHaveLength(1)
  })

  it('streams the deltas as they arrive, not in one lump at the end', () => {
    const out = run([
      init,
      start(MSG),
      blockStart(0, 'text'),
      textDelta(0, 'mar'),
      textDelta(0, 'zipan'),
      assistantText(MSG, 'marzipan'),
      result()
    ])
    expect(out.deltas.filter((d) => d.type === 'delta').map((d) => (d as { text: string }).text)).toEqual([
      'mar',
      'zipan'
    ])
  })

  it('files two messages’ blocks under their own messages, though only message_start names them', () => {
    // Every `content_block_*` event carries a bare `index`, so both messages'
    // block 0 look identical on the wire and the message id has to be carried
    // across from `message_start`.
    //
    // Asserted on the translator's own output rather than through the
    // accumulator, because the accumulator **merges consecutive same-kind
    // parts** — so a collision and a correct split produce the same
    // `'firstsecond'` there, and the accumulator-level assertion would pass
    // either way. This is the layer the property actually lives at.
    const stream = new ClaudeMessageStream()
    const seen: string[] = []
    for (const m of [
      init,
      start(MSG),
      blockStart(0, 'text'),
      textDelta(0, 'first'),
      start(MSG2),
      blockStart(0, 'text'),
      textDelta(0, 'second')
    ]) {
      const update = stream.apply(m)
      if (update.message) seen.push(`${update.message.messageId}=${update.message.parts?.[0]?.text}`)
    }
    expect(seen).toEqual([`${MSG}=first`, `${MSG2}=second`])
  })

  it('gives each block of one message its own part', () => {
    const stream = new ClaudeMessageStream()
    let last: { parts?: { text?: string }[] } | undefined
    for (const m of [
      init,
      start(MSG),
      blockStart(0, 'text'),
      textDelta(0, 'alpha'),
      blockStart(1, 'text'),
      textDelta(1, 'beta')
    ]) {
      const update = stream.apply(m)
      if (update.message) last = update.message
    }
    expect(last?.parts?.map((p) => p.text)).toEqual(['alpha', 'beta'])
  })

  it('merges the two into one rendered block, and loses nothing doing it', () => {
    // The accumulator's own rule — consecutive same-kind parts become one text
    // block for the renderer. Recorded here so the merge is a decision on
    // record rather than a surprise the next reader has to rediscover.
    const out = run([
      init,
      start(MSG),
      blockStart(0, 'text'),
      textDelta(0, 'alpha'),
      blockStart(1, 'text'),
      textDelta(1, 'beta'),
      result()
    ])
    expect(out.answer).toBe('alphabeta')
    expect(out.parts.filter((p) => p.kind === 'text')).toHaveLength(1)
  })

  it('routes thinking to its own kind', () => {
    const out = run([
      init,
      start(MSG),
      blockStart(0, 'thinking'),
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'hmm' }
        }
      },
      result()
    ])
    expect(out.parts.find((p) => p.kind === 'thinking')?.text).toBe('hmm')
    // Thinking is not the answer.
    expect(out.answer).toBe('')
  })

  it('falls back to the assistant message when nothing streamed', () => {
    // `includePartialMessages` is ours to set, but a turn that somehow produced
    // no deltas must still put its answer in the transcript rather than nothing.
    const out = run([init, start(MSG), assistantText(MSG, 'unstreamed answer'), result()])
    expect(out.answer).toBe('unstreamed answer')
  })

  it('does not let the assistant message overwrite text that streamed', () => {
    // The deliberate asymmetry. If the two ever disagree, the streamed text
    // wins — being wrong about which block an assistant message refers to would
    // write one block's words over another's, which is a corrupted transcript
    // rather than a truncated one.
    const out = run([
      init,
      start(MSG),
      blockStart(0, 'text'),
      textDelta(0, 'streamed'),
      assistantText(MSG, 'COMPLETELY DIFFERENT'),
      result()
    ])
    expect(out.answer).toBe('streamed')
  })
})

describe('tool calls', () => {
  const toolSequence = [
    init,
    start(MSG),
    blockStart(0, 'tool_use', 'Read'),
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"file_p' }
      }
    },
    {
      type: 'assistant',
      message: {
        id: MSG,
        content: [{ type: 'tool_use', id: TOOL, name: 'Read', input: { file_path: '/tmp/hello.txt' } }]
      }
    },
    blockStop(0),
    {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: TOOL, content: '1\tthe-secret-word\n' }]
      }
    },
    start(MSG2),
    blockStart(0, 'text'),
    textDelta(0, 'marzipan'),
    result()
  ]

  it('builds the call from the assistant message, not the partial JSON', () => {
    // `input_json_delta` is partial JSON — meaningless until complete — so
    // accumulating it would put `{"file_p` in the transcript.
    const out = run(toolSequence)
    const tool = out.parts.find((p) => p.kind === 'tool')
    expect(tool?.toolName).toBe('Read')
    expect(tool?.toolId).toBe(TOOL)
    expect(tool?.toolInput).toEqual({ file_path: '/tmp/hello.txt' })
    expect(tool?.text).toBe('Read: /tmp/hello.txt')
    expect(out.parts.map((p) => p.text).join('')).not.toContain('{"file_p')
  })

  it('pairs the result back to the call by tool_use_id', () => {
    // The `user` message carries no message id at all — only `tool_use_id` — so
    // without the lookup the result lands in a message of its own and the
    // renderer cannot fold it into the call's block.
    const out = run(toolSequence)
    const res = out.parts.find((p) => p.kind === 'tool_result')
    expect(res?.toolId).toBe(TOOL)
    expect(res?.text).toBe('1\tthe-secret-word\n')
    expect(res?.toolStream).toBe('stdout')
  })

  it('files a late tool result under the message that made the call', () => {
    // The lookup's whole reason to exist. In the common sequence the result
    // arrives while its own message is still current, so `owner()` would answer
    // correctly by luck — and a test built on that sequence passes with the
    // pairing removed. Here a second message has already started (a slow tool,
    // or a parallel call), and only the `tool_use_id` says where the result
    // belongs. Filed under the wrong message, the renderer cannot fold it into
    // the call's block and the decision shows as a stray terminal dump.
    const stream = new ClaudeMessageStream()
    const updates: { messageId: string; keys: string[] }[] = []
    for (const m of [
      init,
      start(MSG),
      {
        type: 'assistant',
        message: { id: MSG, content: [{ type: 'tool_use', id: TOOL, name: 'Read', input: {} }] }
      },
      start(MSG2),
      blockStart(0, 'text'),
      textDelta(0, 'meanwhile'),
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: TOOL, content: 'the answer' }] }
      }
    ]) {
      const update = stream.apply(m)
      if (update.message) {
        updates.push({
          messageId: update.message.messageId,
          parts: update.message.parts ?? []
        } as never)
      }
    }
    const last = updates[updates.length - 1] as unknown as {
      messageId: string
      parts: { text?: string; metadata?: Record<string, unknown> }[]
    }
    expect(last.messageId).toBe(MSG)
    expect(last.parts.map((p) => p.text)).toContain('the answer')
  })

  it('marks a failed tool result as stderr', () => {
    const out = run([
      init,
      start(MSG),
      {
        type: 'assistant',
        message: { id: MSG, content: [{ type: 'tool_use', id: TOOL, name: 'Bash', input: {} }] }
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: TOOL, content: 'permission denied', is_error: true }
          ]
        }
      },
      result()
    ])
    expect(out.parts.find((p) => p.kind === 'tool_result')?.toolStream).toBe('stderr')
  })

  it('flattens a structured tool result instead of rendering [object Object]', () => {
    const out = run([
      init,
      start(MSG),
      {
        type: 'assistant',
        message: { id: MSG, content: [{ type: 'tool_use', id: TOOL, name: 'Read', input: {} }] }
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: TOOL,
              content: [{ type: 'text', text: 'line one' }, { type: 'image' }]
            }
          ]
        }
      },
      result()
    ])
    const text = out.parts.find((p) => p.kind === 'tool_result')?.text
    expect(text).toBe('line one\n[image]')
    expect(text).not.toContain('object Object')
  })

  it('does not repeat a tool call when the assistant message is seen twice', () => {
    const twice = [...toolSequence, toolSequence[4]]
    expect(run(twice).parts.filter((p) => p.kind === 'tool')).toHaveLength(1)
  })
})

describe('subagents', () => {
  it('keeps a subagent’s stream in its own lane, so it cannot capture the main one', () => {
    // **Verified against the real binary that this does not happen today**: with
    // `forwardSubagentText` off — our default — a subagent's frames arrive only
    // as `assistant`/`user` messages, never as `stream_event`. But that is a
    // property of an option we do not set, not of the protocol, and the failure
    // it would cause is silent: the subagent's `message_start` captures the
    // slot, and the main agent's next delta lands in the subagent's message.
    const stream = new ClaudeMessageStream()
    const updates: { messageId: string; text?: string }[] = []
    const parented = (m: Record<string, unknown>): unknown => ({
      ...m,
      parent_tool_use_id: 'toolu_sub'
    })
    for (const m of [
      init,
      start(MSG),
      blockStart(0, 'text'),
      textDelta(0, 'main '),
      // The subagent starts a message of its own, mid-stream.
      parented(start(MSG2) as Record<string, unknown>),
      parented(blockStart(0, 'text') as Record<string, unknown>),
      parented(textDelta(0, 'subagent') as Record<string, unknown>),
      // …and the main agent carries on. Its delta must land in ITS message.
      textDelta(0, 'answer')
    ]) {
      const update = stream.apply(m)
      if (update.message) {
        updates.push({
          messageId: update.message.messageId,
          text: update.message.parts?.[0]?.text
        })
      }
    }
    const last = updates[updates.length - 1]
    expect(last.messageId).toBe(MSG)
    expect(last.text).toBe('main answer')
    // And the subagent's own text stayed in its own message.
    expect(updates.some((u) => u.messageId === MSG2 && u.text === 'subagent')).toBe(true)
  })

  it('files a subagent’s tool call under its own message, not the main agent’s', () => {
    // Observed shape: the subagent's `assistant` message carries its own
    // `message.id` and a `parent_tool_use_id`, and its `user` tool_result
    // carries no message id at all — only the `tool_use_id` pairing.
    const out = run([
      init,
      start(MSG),
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu_sub',
        message: { id: MSG2, content: [{ type: 'tool_use', id: TOOL, name: 'Read', input: {} }] }
      },
      {
        type: 'user',
        parent_tool_use_id: 'toolu_sub',
        message: { content: [{ type: 'tool_result', tool_use_id: TOOL, content: 'saffron' }] }
      },
      result()
    ])
    expect(out.parts.find((p) => p.kind === 'tool')?.toolId).toBe(TOOL)
    expect(out.parts.find((p) => p.kind === 'tool_result')?.text).toBe('saffron')
  })
})

describe('the wider union', () => {
  it('ignores kinds it does not know rather than failing the turn', () => {
    // 37 members at 0.3.266, and two the plan never mentioned arrived in the
    // first probe turn. A turn must not die because the CLI learned a trick.
    const out = run([
      init,
      { type: 'system', subtype: 'status' },
      { type: 'rate_limit_event' },
      { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
      { type: 'task_started' },
      start(MSG),
      blockStart(0, 'text'),
      textDelta(0, 'still fine'),
      result()
    ])
    expect(out.answer).toBe('still fine')
  })

  it('survives malformed input without throwing', () => {
    const stream = new ClaudeMessageStream()
    for (const junk of [null, undefined, 'string', 42, [], {}, { type: 'stream_event' }]) {
      expect(() => stream.apply(junk)).not.toThrow()
    }
  })
})

describe('the facts off the init and result messages', () => {
  it('reports apiKeySource, which is what says who paid', () => {
    expect(run([init, result()]).apiKeySource).toBe('none')
  })

  it('reports an apiKeySource other than none rather than swallowing it', () => {
    // A value here means something reached the child that we intended to strip,
    // and the user is being billed somewhere they did not choose.
    expect(run([{ ...init, apiKeySource: 'ANTHROPIC_API_KEY' }, result()]).apiKeySource).toBe(
      'ANTHROPIC_API_KEY'
    )
  })

  it('treats a missing apiKeySource as unknown, never as a subscription', () => {
    const { apiKeySource, ...rest } = init
    void apiKeySource
    expect(run([rest, result()]).apiKeySource).toBe('unknown')
  })

  it('ends on result, carrying the error flag', () => {
    expect(run([init, result()]).ended).toMatchObject({ isError: false, text: 'done' })
    expect(
      run([init, result({ is_error: true, subtype: 'error_during_execution' })]).ended
    ).toMatchObject({ isError: true })
  })

  it('does not end on anything but a result', () => {
    expect(run([init, start(MSG), blockStart(0, 'text'), textDelta(0, 'x')]).ended).toBeUndefined()
  })
})

describe('describeClaudeToolCall', () => {
  it('names the tool and its most identifying argument', () => {
    expect(describeClaudeToolCall('Bash', { command: 'ls -la' })).toBe('Bash: ls -la')
    expect(describeClaudeToolCall('Read', { file_path: '/tmp/x' })).toBe('Read: /tmp/x')
    expect(describeClaudeToolCall('WebFetch', { url: 'https://example.com' })).toBe(
      'WebFetch: https://example.com'
    )
  })

  it('falls back to the bare name when nothing identifies the call', () => {
    expect(describeClaudeToolCall('Read', undefined)).toBe('Read')
    expect(describeClaudeToolCall('Read', { unexpected: 1 })).toBe('Read')
  })

  it('truncates a long argument rather than pasting a script into the transcript', () => {
    const described = describeClaudeToolCall('Bash', { command: 'x'.repeat(500) })
    expect(described.length).toBeLessThanOrEqual(166)
    expect(described.endsWith('…')).toBe(true)
  })
})
