import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import type { LocalAgentDto } from '../../../../../shared/localAgents'

/**
 * The Folder tab is the page's one honest inventory of what is *in* a folder,
 * so every card on it that names a file is a claim about that folder.
 *
 * For a **bare** agent most of those claims were false: it listed the seven kit
 * files with a Reveal button each, reported "legacy manifest" for a folder with
 * no manifest at all, offered a Credentials card over a `credentials/.env` the
 * desktop never creates for such a folder, and named `app-data/desktop.json`
 * for state that deliberately lives outside the folder. Each was an absence
 * presented as a configuration the user had not filled in yet.
 */

// `useOpenAgentPath` is a real react-query mutation over `window.api`, never
// invoked here (nothing clicks Reveal) but the shape has to exist. `app` is for
// the ui store, which the card tree pulls in transitively and which reads the
// theme at import time.
;(
  window as unknown as {
    api: {
      app: { setTheme: () => Promise<void> }
      localAgents: { openPath: () => Promise<void> }
    }
  }
).api = {
  app: { setTheme: async () => undefined },
  localAgents: { openPath: async () => undefined }
}

const { FolderTab } = await import('./FolderTab')

function agent(overrides: Partial<LocalAgentDto> = {}): LocalAgentDto {
  return {
    id: 'folder:external:r1:alpha',
    name: 'Alpha',
    slug: 'alpha',
    kind: 'bare',
    identity: 'external',
    manifestId: '',
    manifest: {},
    publications: [],
    credentials: [],
    commands: [],
    validation: { errors: [], warnings: [], infos: [] },
    desktop: { localApiBaseUrl: null, hasAgentToken: false, sessionCount: 0, lastStatusAt: null },
    ...overrides
  } as LocalAgentDto
}

function renderTab(a: LocalAgentDto): ReturnType<typeof render> {
  const client = new QueryClient()
  return render(
    createElement(QueryClientProvider, { client }, createElement(FolderTab, { agent: a }))
  )
}

describe('FolderTab — a bare agent', () => {
  it('lists the folder’s own two files, not the kit layout', () => {
    renderTab(agent())

    expect(screen.getByText('AGENT.md')).toBeTruthy()
    expect(screen.getByText('README.md')).toBeTruthy()
    for (const kitFile of [
      'docs/WORKFLOW_PROMPT.md',
      'docs/ENTRYPOINT_PROMPT.md',
      'docs/REFINER_PROMPT.md',
      'docs/CLI_COMMANDS.yaml',
      'credentials/.env'
    ]) {
      expect(screen.queryByText(kitFile)).toBeNull()
    }
  })

  it('never reports a folder with no manifest as having an old one', () => {
    // The Kit row read the manifest and fell through to "legacy manifest",
    // which is both false and the wrong story: legacy means a pre-contract kit
    // folder that Stamp identity can repair, and there is nothing here to stamp.
    renderTab(agent())

    expect(screen.queryByText(/legacy manifest/)).toBeNull()
    expect(screen.queryByText('Kit')).toBeNull()
    expect(screen.getByText(/identified by where its folder sits/)).toBeTruthy()
  })

  it('drops the cards that only make sense for a kit folder', () => {
    renderTab(agent())

    expect(screen.queryByText('Credentials')).toBeNull()
    expect(screen.queryByText('Published')).toBeNull()
  })

  it('says where a bare agent’s run state actually lives', () => {
    renderTab(agent())

    expect(screen.queryByText('app-data/desktop.json')).toBeNull()
    expect(screen.getByText(/outside the folder/)).toBeTruthy()
  })

  it('shows infos, which were produced and rendered nowhere', () => {
    renderTab(
      agent({
        validation: {
          errors: [],
          warnings: [],
          infos: [{ code: 'bare.no_manifest', message: 'This folder has no cinna-agent.json.' }]
        }
      })
    )

    expect(screen.getByText('This folder has no cinna-agent.json.')).toBeTruthy()
  })
})

describe('FolderTab — a kit agent keeps every card', () => {
  it('still lists the kit files and the manifest-backed cards', () => {
    renderTab(
      agent({
        kind: 'kit',
        identity: 'manifest',
        manifestId: 'uuid-1',
        manifest: { contract_version: '1.1.0' }
      })
    )

    expect(screen.getByText('docs/WORKFLOW_PROMPT.md')).toBeTruthy()
    expect(screen.getByText('Credentials')).toBeTruthy()
    expect(screen.getByText('Kit')).toBeTruthy()
    expect(screen.getAllByText(/contract 1\.1\.0/).length).toBeGreaterThan(0)
  })
})
