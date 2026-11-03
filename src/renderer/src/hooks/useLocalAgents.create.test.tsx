import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { APP_SETTINGS_KEY } from './useAppSettings'
import { LOCAL_AGENTS_KEY, useCreateLocalAgent, withCreatedAgent, type LocalAgentsSnapshot } from './useLocalAgents'
import type { LocalAgentDto } from '../../../shared/localAgents'

/**
 * A created agent is written into the folder list before the caller opens its
 * page: the page's composer decides the guided-build invitation from that
 * list, and a refetch only lands after first paint (rule 1).
 */

const ROOT = '/home/u/CinnaAgents'
function agent(id: string, slug: string, rootId = 'home', rootPath = ROOT): LocalAgentDto {
  return { id, slug, rootId, rootPath, path: `${rootPath}/${slug}`, name: slug, unbuilt: true } as LocalAgentDto
}
function snapshot(agents: LocalAgentDto[]): LocalAgentsSnapshot {
  return { roots: [], agents, homeAccess: 'ready', homeMissing: false, homePath: ROOT } as LocalAgentsSnapshot
}

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

it('puts the agent where the next scan will, within its root', () => {
  const list = snapshot([agent('a', 'alpha'), agent('c', 'charlie'), agent('x', 'zulu', 'other', '/elsewhere')])
  expect(withCreatedAgent(list, agent('b', 'bravo')).agents.map((a) => a.id)).toEqual(['a', 'b', 'c', 'x'])
  expect(withCreatedAgent(list, agent('d', 'delta')).agents.map((a) => a.id)).toEqual(['a', 'c', 'd', 'x'])
  // Already there (a watcher refetch won the race): replaced, not doubled.
  expect(withCreatedAgent(list, { ...agent('c', 'charlie'), name: 'New' }).agents.map((a) => a.name)).toEqual(['alpha', 'New', 'zulu'])
})

it('has the created agent in the folder list, and the settings, when the caller’s onSuccess runs', async () => {
  const created = agent('folder:new', 'mail-helper')
  // The refetch never resolves here: only the written cache can answer.
  const list = vi.fn(() => new Promise<LocalAgentsSnapshot>(() => {}))
  ;(window as unknown as { api: unknown }).api = { localAgents: { create: vi.fn(async () => created), list }, settings: { getAll: vi.fn(async () => ({ guidedFirstBuild: true })) } }
  const client = new QueryClient()
  client.setQueryData(LOCAL_AGENTS_KEY, snapshot([agent('a', 'alpha')]))
  let create: ReturnType<typeof useCreateLocalAgent> | null = null
  function Probe(): null {
    create = useCreateLocalAgent()
    return null
  }
  render(createElement(QueryClientProvider, { client }, createElement(Probe)))
  let seen: string[] = []
  let settings: unknown
  await act(async () => {
    await create!.mutateAsync({ name: 'Mail helper' } as never, {
      onSuccess: () => {
        seen = client.getQueryData<LocalAgentsSnapshot>(LOCAL_AGENTS_KEY)!.agents.map((a) => a.id)
        settings = client.getQueryData(APP_SETTINGS_KEY)
      }
    })
  })
  // Mutation: drop the list write and only the per-agent cache has it.
  expect(seen).toEqual(['a', 'folder:new'])
  // Mutation: drop the settings fetch, and an auth reset's empty settings
  // query leaves the page undetermined for its first frames.
  expect(settings).toEqual({ guidedFirstBuild: true })
})
