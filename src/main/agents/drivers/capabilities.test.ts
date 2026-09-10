import { describe, it, expect } from 'vitest'
import type { AgentRow } from '../../db/agents'
import { capabilitiesFor, hasRunConfig } from './capabilities'

/**
 * What each driver says it can do, from the row alone.
 *
 * Every assertion here replaces a `source` comparison somewhere else: the
 * composer's attach gate (`source === 'remote'`), the Cinna re-auth flag
 * (`isCinnaTokenAuth: source === 'remote'`), the `/run:` interception
 * (`isFolderAgent`), and the command catalog dispatch in `agentService`. A
 * capability that answers differently from the branch it replaced is a
 * behaviour change nobody asked for.
 */

const row = (over: Partial<AgentRow>): AgentRow =>
  ({
    id: 'agent-1',
    driver: null,
    source: 'local',
    accessTokenEncrypted: null,
    cardUrl: null,
    ...over
  }) as AgentRow

const synced = row({ id: 'remote:a', source: 'remote', driver: 'a2a', cardUrl: 'https://x/card' })
const handAdded = row({ source: 'local', driver: 'a2a', cardUrl: 'https://x/card' })
const withToken = row({ source: 'local', driver: 'a2a', accessTokenEncrypted: Buffer.from('t') })
const opencode = row({
  id: 'folder:a',
  source: 'folder',
  driver: 'acp',
  driverConfig: { launcher: 'opencode' }
})
const claude = row({
  id: 'folder:b',
  source: 'folder',
  driver: 'acp',
  driverConfig: { launcher: 'claude' }
})

describe('capabilitiesFor', () => {
  it.each([
    ['a synced A2A row', synced],
    ['a hand-added A2A row', handAdded],
    ['an OpenCode folder', opencode],
    ['a Claude folder', claude]
  ])('is pure and stable for %s', (_label, agent) => {
    const first = capabilitiesFor(agent)
    expect(capabilitiesFor(agent)).toEqual(first)
    // A fresh object every call: a caller that mutates what it was handed
    // must not change the next caller's answer.
    first.input.question = !first.input.question
    first.attachments = 'local'
    expect(capabilitiesFor(agent)).not.toEqual(first)
  })

  it('gives a Cinna-synced agent attachments and the Cinna re-auth flow', () => {
    expect(capabilitiesFor(synced)).toEqual({
      streaming: true,
      cancel: true,
      sessions: 'context',
      input: { permission: false, question: true, auth: true, elicitation: false },
      inputResume: 'next_message',
      attachments: 'cinna',
      auth: 'cinna',
      commands: 'card',
      mcpInjection: false,
      cwd: false
    })
  })

  it('offers a hand-added A2A agent no attach, and a static token only when one is stored', () => {
    // The composer attached only to a remote target before; a hand-added
    // agent has no Cinna backend to upload to.
    expect(capabilitiesFor(handAdded)).toMatchObject({ attachments: 'none', auth: 'none' })
    expect(capabilitiesFor(withToken)).toMatchObject({ attachments: 'none', auth: 'token' })
  })

  it('makes an OpenCode folder answerable in place, with a command catalog and a folder', () => {
    expect(capabilitiesFor(opencode)).toEqual({
      streaming: true,
      cancel: true,
      sessions: 'resumable',
      // **No question path since phase 3**, and it is the engine's doing rather
      // than the driver's: OpenCode's `question` tool is not registered under
      // `OPENCODE_CLIENT=acp`, and its ACP layer bridges no question to
      // `elicitation/create`, so the model asks in prose instead.
      input: { permission: true, question: false, auth: false, elicitation: false },
      inputResume: 'reply',
      attachments: 'none',
      auth: 'none',
      commands: 'catalog',
      mcpInjection: false,
      cwd: true
    })
  })

  it('says a Claude folder can ask a question now, on the CLI’s own login', () => {
    // The capability the transport *gained*: the ACP adapter enables its
    // `AskUserQuestion` tool because the launcher declares `elicitation.form`,
    // where the in-process SDK runner had no question path at all.
    expect(capabilitiesFor(claude)).toMatchObject({
      input: { permission: true, question: true, auth: false, elicitation: false },
      inputResume: 'reply',
      auth: 'cli',
      commands: 'catalog',
      cwd: true
    })
  })

  it('reads the launcher out of driver_config, and falls back by ownership', () => {
    // The config wins: the row's driver says how it runs, its launcher which
    // engine.
    expect(capabilitiesFor(claude).auth).toBe('cli')
    // No driver set: a folder row runs on the ACP driver, anything else on A2A.
    expect(capabilitiesFor(row({ source: 'folder', driver: null })).commands).toBe('catalog')
    expect(capabilitiesFor(row({ source: 'remote', driver: null })).attachments).toBe('cinna')
    // An ACP row with no launcher recorded runs on the default engine, which is
    // the one the desktop pays for rather than the user's own CLI login.
    expect(capabilitiesFor(row({ source: 'folder', driver: 'acp' })).auth).toBe('none')
    // A launcher a newer build wrote, which this one cannot run: described as
    // what it is rather than as the default, so the composer and the turn agree
    // that it takes no credential of ours.
    expect(
      capabilitiesFor(row({ source: 'folder', driver: 'acp', driverConfig: { launcher: 'gemini' } }))
        .auth
    ).toBe('cli')
  })
})

describe('hasRunConfig', () => {
  it('needs a card URL for an A2A row and nothing for a folder row', () => {
    // The folder half is the defect this replaced twice: a bare card check
    // skipped every folder agent, which is inserted with `cardUrl: null`.
    expect(hasRunConfig(row({ driver: 'a2a', cardUrl: null }))).toBe(false)
    expect(hasRunConfig(row({ driver: 'a2a', cardUrl: 'https://x/card' }))).toBe(true)
    expect(hasRunConfig(opencode)).toBe(true)
    expect(hasRunConfig(claude)).toBe(true)
  })
})
