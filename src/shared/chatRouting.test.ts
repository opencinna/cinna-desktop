import { describe, it, expect } from 'vitest'
import { newChatRouter, routerOf, routingOf, type RoutableChat } from './chatRouting'

/**
 * The one routing rule, which used to be five.
 *
 * `chat.agentId && !chat.orchestrated` was written out by hand in the composer,
 * the attachment scope, the new-chat flow, the example prompts and the job
 * runner, and `derivePattern` answered a differently-shaped version of the same
 * question for the badge. This file is the whole rule now, so it is tested as
 * a table over every combination rather than through the surfaces that ask it.
 */

const HUMAN: RoutableChat = { router: 'human', agentId: null }

describe('routerOf — reading the router off a chat', () => {
  it('reads the column when it holds a value this build knows', () => {
    expect(routerOf({ router: 'human' })).toBe('human')
    expect(routerOf({ router: 'coordinator' })).toBe('coordinator')
    expect(routerOf({ router: 'direct' })).toBe('direct')
  })

  it('uses the default when the router is absent', () => {
    expect(routerOf({})).toBe('direct')
  })

  it('treats a value it does not know as no value at all', () => {
    expect(routerOf({ router: 'switchboard' })).toBe('direct')
    expect(routerOf({ router: null })).toBe('direct')
  })
})

describe('routingOf — who answers', () => {
  it('sends a direct chat to its bound agent', () => {
    const routing = routingOf({ router: 'direct', agentId: 'a-1' })
    expect(routing.rootAgentId).toBe('a-1')
    expect(routing.answerer()).toEqual({ kind: 'agent', agentId: 'a-1' })
    expect(routing.needsModel).toBe(false)
    expect(routing.attachmentTarget).toBe('cinna')
  })

  it('sends a direct chat with no agent to the model', () => {
    const routing = routingOf({ router: 'direct', agentId: null })
    expect(routing.answerer()).toEqual({ kind: 'model' })
    expect(routing.needsModel).toBe(true)
    expect(routing.attachmentTarget).toBe('local')
  })

  it('sends a coordinated chat to the model even when a root is still on the row', () => {
    // The switch detaches the root, but a row read mid-transition can still
    // carry one; the router is what decides, not the leftover column.
    const routing = routingOf({ router: 'coordinator', agentId: 'a-1' })
    expect(routing.rootAgentId).toBeNull()
    expect(routing.answerer({ addressed: 'a-2', attached: ['a-2'] })).toEqual({ kind: 'model' })
    expect(routing.needsModel).toBe(true)
  })

  it('needs no model for a human chat — the whole point of it', () => {
    const routing = routingOf(HUMAN)
    expect(routing.needsModel).toBe(false)
    expect(routing.attachmentTarget).toBe('cinna')
  })
})

describe('routingOf — addressing a human chat', () => {
  const attached = ['a-1', 'a-2', 'a-3']
  const answer = (addressing: Parameters<ReturnType<typeof routingOf>['answerer']>[0]) =>
    routingOf(HUMAN).answerer(addressing)

  it('honours the agent this message addresses', () => {
    expect(answer({ addressed: 'a-2', lastAddressed: 'a-1', attached })).toEqual({
      kind: 'agent',
      agentId: 'a-2'
    })
  })

  it('is sticky: with nothing addressed, whoever answered last answers again', () => {
    expect(answer({ lastAddressed: 'a-3', attached })).toEqual({ kind: 'agent', agentId: 'a-3' })
  })

  it('falls to the first attached agent when nobody has been addressed yet', () => {
    expect(answer({ attached })).toEqual({ kind: 'agent', agentId: 'a-1' })
  })

  it('ignores an addressed agent the chat is not carrying', () => {
    // The composer and the row disagree for a moment after a chip is removed.
    // Sending to an agent the chat no longer has would be a turn nobody asked
    // for — and one whose reply would be labelled with a name that is gone.
    expect(answer({ addressed: 'a-9', lastAddressed: 'a-2', attached })).toEqual({
      kind: 'agent',
      agentId: 'a-2'
    })
  })

  it('ignores a stale sticky default the same way', () => {
    expect(answer({ lastAddressed: 'a-9', attached })).toEqual({ kind: 'agent', agentId: 'a-1' })
  })

  it('honours an addressed agent when the caller cannot say what is attached', () => {
    // `attached: []` from a cache that has not loaded is not the same fact as
    // "this chat has no agents", and refusing the user's own gesture over it
    // would send the message to the wrong agent for one turn.
    expect(answer({ addressed: 'a-2' })).toEqual({ kind: 'agent', agentId: 'a-2' })
  })

  it('falls back to the model when the chat has no agents left', () => {
    expect(answer({ attached: [] })).toEqual({ kind: 'model' })
  })
})

describe('newChatRouter — what the new-chat selection creates', () => {
  const router = (agentIds: string[], mcpIds: string[] = [], coordinate?: boolean) =>
    newChatRouter({ agentIds, mcpIds, coordinate })

  it('is direct with no agents at all — the model answers, its servers are its own tools', () => {
    expect(router([])).toBe('direct')
    expect(router([], ['mcp-1'])).toBe('direct')
  })

  it('is direct for one agent alone', () => {
    expect(router(['a-1'])).toBe('direct')
  })

  it('is human for several agents — no model between them', () => {
    expect(router(['a-1', 'a-2'])).toBe('human')
    expect(router(['a-1', 'a-2', 'a-3'])).toBe('human')
  })

  it('is coordinator once an agent is mixed with an MCP server', () => {
    // An agent cannot call the desktop's MCP servers, so somebody has to.
    expect(router(['a-1'], ['mcp-1'])).toBe('coordinator')
    expect(router(['a-1', 'a-2'], ['mcp-1'])).toBe('coordinator')
  })

  it('lets the explicit toggle win over all of it', () => {
    expect(router(['a-1'], [], true)).toBe('coordinator')
    expect(router([], [], true)).toBe('coordinator')
  })
})
