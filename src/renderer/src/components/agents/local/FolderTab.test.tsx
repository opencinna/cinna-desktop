import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
// invoked here for the reveals (nothing clicks them) but the shape has to
// exist; `openCredentials` is, by the credentials tests below. `app` is for
// the ui store, which the card tree pulls in transitively and which reads the
// theme at import time.
const openPath = vi.fn(async () => undefined)
const openCredentials = vi.fn(async () => ({ created: false, revealed: false }))
;(
  window as unknown as {
    api: {
      app: { setTheme: () => Promise<void> }
      localAgents: {
        openPath: () => Promise<void>
        openCredentials: () => Promise<{ created: boolean; revealed: boolean }>
      }
    }
  }
).api = {
  app: { setTheme: async () => undefined },
  localAgents: { openPath, openCredentials }
}

const { FolderTab } = await import('./FolderTab')

function agent(overrides: Partial<LocalAgentDto> = {}): LocalAgentDto {
  return {
    id: 'folder:external:r1:alpha',
    name: 'Alpha',
    slug: 'alpha',
    kind: 'bare',
    instructionsFile: 'AGENT.md',
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
  it('names the instructions file this folder has, and no other', () => {
    // Mutation: list `AGENT.md` for every bare folder and a `CLAUDE.md` agent's
    // Files card offers to reveal a file that is not there (ux_rules rule 9).
    const { unmount } = renderTab(agent({ instructionsFile: 'CLAUDE.md' }))
    expect(screen.getByText('CLAUDE.md')).toBeTruthy()
    expect(screen.queryByText('AGENT.md')).toBeNull()
    unmount()

    // None right now (between the file going and the rescan): the three names
    // it could have, and a row that reveals the folder rather than a file.
    renderTab(agent({ instructionsFile: null }))
    expect(screen.getByText('AGENT.md, AGENTS.md or CLAUDE.md')).toBeTruthy()
    expect(screen.getByTitle('Reveal the folder')).toBeTruthy()
  })

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

/**
 * `credentials/.env` opens; every other file reveals. Finder hides dotfiles,
 * so a reveal of the credentials folder showed a folder that looked empty, and
 * on a fresh agent the file is not there to reveal at all — main creates it.
 * The two outcomes the click cannot show for itself are said under the card.
 */
describe('FolderTab — credentials/.env opens rather than reveals', () => {
  const kit = (): LocalAgentDto =>
    agent({ kind: 'kit', identity: 'manifest', manifestId: 'uuid-1', manifest: {} })

  afterEach(() => {
    vi.clearAllMocks()
    openCredentials.mockResolvedValue({ created: false, revealed: false })
  })

  const OPEN_TIP = "Open credentials/.env in your text editor, creating it if it isn't there yet"
  /** The card header's link; the Files row below carries the same title. */
  const headerLink = (): HTMLElement => screen.getAllByTitle(OPEN_TIP)[0]

  it('opens the file from the Credentials card header and from the Files list', async () => {
    renderTab(kit())

    fireEvent.click(headerLink())
    await waitFor(() => expect(openCredentials).toHaveBeenCalledTimes(1))
    expect(openCredentials).toHaveBeenCalledWith('folder:external:r1:alpha')

    // The Files row names the same file and does the same thing — not a reveal
    // of a path that may not exist.
    fireEvent.click(screen.getAllByTitle(OPEN_TIP)[1])
    await waitFor(() => expect(openCredentials).toHaveBeenCalledTimes(2))
    expect(openPath).not.toHaveBeenCalled()

    // Its neighbours still reveal.
    fireEvent.click(screen.getByRole('button', { name: 'docs/CLI_COMMANDS.yaml' }))
    await waitFor(() => expect(openPath).toHaveBeenCalledTimes(1))
    expect(openPath).toHaveBeenCalledWith({
      agentId: 'folder:external:r1:alpha',
      relPath: 'docs/CLI_COMMANDS.yaml'
    })
  })

  it('says when only the file manager could show the file, and why a click was refused', async () => {
    openCredentials.mockResolvedValueOnce({ created: false, revealed: true })
    renderTab(kit())

    fireEvent.click(headerLink())
    expect(
      await screen.findByText(
        'Nothing here opens .env, so credentials/.env was shown in the file manager.'
      )
    ).toBeTruthy()

    openCredentials.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'local-agent:open-credentials': The credentials folder could not be created."
      )
    )
    fireEvent.click(headerLink())
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('The credentials folder could not be created.')).toBeTruthy()
    // The next *result* clears the last message — not the click, which must
    // move nothing (rule 1): an editor opened, so there is nothing to say.
    fireEvent.click(headerLink())
    expect(screen.getByRole('alert')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('is one action from both cards: one note at a time, and both links wait on a click in flight', async () => {
    let settle: (r: { created: boolean; revealed: boolean }) => void = () => undefined
    openCredentials.mockImplementationOnce(
      () => new Promise((resolve) => (settle = resolve))
    )
    renderTab(kit())

    fireEvent.click(headerLink())
    // The macOS fallback can take 15 s; a second click from either card would
    // open a second editor.
    await waitFor(() => {
      for (const link of screen.getAllByTitle(OPEN_TIP)) {
        expect((link as HTMLButtonElement).disabled).toBe(true)
      }
    })
    settle({ created: false, revealed: true })
    const note = await screen.findByRole('status')
    // One note, under the card that was clicked — not one per card.
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(note.closest('section')?.textContent).toContain('Credentials')
    for (const link of screen.getAllByTitle(OPEN_TIP)) {
      expect((link as HTMLButtonElement).disabled).toBe(false)
    }

    // A click from the Files row moves the note there and clears the first.
    openCredentials.mockResolvedValueOnce({ created: false, revealed: true })
    fireEvent.click(screen.getAllByTitle(OPEN_TIP)[1])
    await waitFor(() => {
      const notes = screen.getAllByRole('status')
      expect(notes).toHaveLength(1)
      expect(notes[0].closest('section')?.textContent).toContain('Files')
    })
  })

  it('drops a result that lands after the user has switched to another agent', async () => {
    // The page re-renders rather than remounts on a switch, and the macOS
    // fallback can take 15 s: a note about agent A must not appear under B.
    let settle: (r: { created: boolean; revealed: boolean }) => void = () => undefined
    openCredentials.mockImplementationOnce(
      () => new Promise((resolve) => (settle = resolve))
    )
    const client = new QueryClient()
    const { rerender } = render(
      createElement(QueryClientProvider, { client }, createElement(FolderTab, { agent: kit() }))
    )
    fireEvent.click(headerLink())
    await waitFor(() => expect(openCredentials).toHaveBeenCalledTimes(1))

    rerender(
      createElement(
        QueryClientProvider,
        { client },
        createElement(FolderTab, { agent: { ...kit(), id: 'folder:external:r1:beta', slug: 'beta' } })
      )
    )
    settle({ created: false, revealed: true })
    // Give the resolved mutation every chance to write before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
