import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { ArtifactPublishToolBlock } from './ArtifactPublishTool'
import { useAuthStore } from '../../stores/auth.store'
import { useArtifactsSupportStore } from '../../hooks/useArtifacts'
import { useArtifactPublishStore } from '../../stores/artifactPublish.store'
import type { ArtifactApprovalSummary } from '../../../../shared/artifacts'

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const LIMITS = { maxRevisionBytes: 1, maxRevisionFiles: 1, maxFileBytes: 1 }
const summary: ArtifactApprovalSummary = {
  requestId: 'art_tc1', chatId: 'chat-1', toolCallId: 'tc1', agentId: 'folder:a', agentName: 'Analyst',
  path: '/agent/reports/q3', relativePath: 'reports/q3', title: 'Q3 churn', description: 'By plan', entry: 'index.html',
  isFolder: true, kind: 'site', kindLine: 'Mini-site · opens index.html',
  files: [{ path: 'index.html', size: 2048 }], excluded: [{ path: '.env', reason: 'secret file' }],
  size: 2048, limits: LIMITS, instanceName: 'Acme', audience: 'only you', update: null
}
const resultJson = JSON.stringify({ artifact_id: ID, revision: 4, url: `http://core/artifact/${ID}`, kind: 'site', file_count: 1, size_bytes: 2048, excluded: ['.env'] })

const approvals = vi.fn()
const answerApproval = vi.fn()
const local = vi.fn()

function mount(props: Partial<React.ComponentProps<typeof ArtifactPublishToolBlock>>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ArtifactPublishToolBlock chatId="chat-1" toolCallId="tc1" input={{ path: 'reports/q3', title: 'Q3 churn' }} status="pending" {...props} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  approvals.mockReset().mockResolvedValue([summary])
  answerApproval.mockReset()
  local.mockReset().mockResolvedValue({ id: ID, title: 'Q3 churn', kind: 'site', revision: 4, visibility: 'instance', liveLinkCount: 0, url: `http://core/artifact/${ID}` })
  window.api = { artifacts: { approvals, answerApproval, local } } as never
  useAuthStore.setState({ currentUser: { id: 'alice' } as never })
  useArtifactsSupportStore.setState({ profileId: 'alice', support: { supported: true, instanceName: 'Acme', limits: LIMITS } })
  useArtifactPublishStore.setState({ request: null, publishing: false, warnings: {} })
})

describe('an agent’s artifacts_publish in the transcript', () => {
  it('waits on an approval card with the dialog’s summary', async () => {
    mount({})
    const card = await screen.findByRole('group', { name: 'Publish request: Q3 churn' })
    expect(card.textContent).toContain('Analyst wants to publish “Q3 churn”')
    expect(card.textContent).toContain('Mini-site · opens index.html')
    expect(screen.getByText('.env').className).toContain('line-through')
    expect(card.textContent).toContain('2 KB · new artifact · visible to only you')
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Deny', 'Edit…', 'Publish'])
    expect(approvals).toHaveBeenCalledWith('chat-1')
  })

  it('publishes with the button busy inline, and says a failure in the card, which stays', async () => {
    let resolve: (value: unknown) => void = () => {}
    answerApproval.mockReturnValueOnce(new Promise((r) => { resolve = r }))
    mount({})
    await screen.findByRole('group', { name: 'Publish request: Q3 churn' })
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    expect(screen.getByRole('button', { name: 'Publishing…' })).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Deny' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => resolve({ ok: false, code: 'too_large', message: 'Over your quota. Nothing was published.' }))
    expect(answerApproval).toHaveBeenCalledWith({ requestId: 'art_tc1', decision: 'publish' })
    expect(screen.getByRole('alert').textContent).toBe('Over your quota. Nothing was published.')
    expect(screen.getByRole('group', { name: 'Publish request: Q3 churn' })).toBeTruthy()
  })

  it('denies, and Edit… opens the Publish dialog on the request', async () => {
    answerApproval.mockResolvedValue({ ok: true })
    mount({})
    await screen.findByRole('group', { name: 'Publish request: Q3 churn' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit…' }))
    expect(useArtifactPublishStore.getState().request).toEqual({
      agentId: 'folder:a', path: '/agent/reports/q3', kind: 'dir', chatId: 'chat-1', messageId: null,
      approval: { requestId: 'art_tc1', title: 'Q3 churn', description: 'By plan', entry: 'index.html', agentName: 'Analyst' }
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Deny' })) })
    expect(answerApproval).toHaveBeenCalledWith({ requestId: 'art_tc1', decision: 'deny' })
  })

  it('after the result (and after a reload): the card from the local row, with the no-card note', async () => {
    mount({ status: 'done', result: resultJson, parts: [{ kind: 'notice', text: 'Updated rev 4' }] })
    expect(await screen.findByText('rev 4 · everyone on Acme')).toBeTruthy()
    // Said once: the card already says the revision.
    expect(screen.getByText('Updated without asking')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Share Q3 churn' })).toBeTruthy()
    expect(local).toHaveBeenCalledWith(ID)
    expect(approvals).not.toHaveBeenCalled()
  })

  it('a new artifact published without a card shows its card and no note', async () => {
    mount({ status: 'done', result: resultJson })
    expect(await screen.findByText('rev 4 · everyone on Acme')).toBeTruthy()
    expect(screen.queryByText('Updated without asking')).toBeNull()
    expect(screen.getByRole('button', { name: 'Share Q3 churn' })).toBeTruthy()
  })

  it('says a refusal in the user’s words from the row’s note, never the agent’s sentence', () => {
    const cases: Array<[string, string, string]> = [
      ['The user declined to publish reports/q3; do not retry unless they ask.', 'artifact-refusal:declined:you declined', 'Not published — you declined'],
      ['Nobody answered the request to publish reports/q3 within an hour, so it was not published. Ask the user before trying again.', 'artifact-refusal:timeout:no answer within an hour', 'Not published — no answer within an hour'],
      ['The request to publish reports/q3 was cancelled before the user answered, so it was not published.', 'artifact-refusal:cancelled:the chat stopped before you answered', 'Not published — the chat stopped before you answered'],
      ['`credentials/x`: credentials/ is never published (credentials). Publish a file or folder outside it.', 'artifact-refusal:refused:credentials/ is never published (credentials)', 'Not published — credentials/ is never published (credentials)']
    ]
    for (const [agentText, note, line] of cases) {
      const { container, unmount } = mount({ status: 'error', result: agentText, parts: [{ kind: 'notice', text: note }] })
      expect(container.textContent).toBe(line)
      unmount()
    }
  })

  it('a live row (no note yet) maps the provider’s own sentences, without a doubled "Not published:"', () => {
    const live: Array<[string, string]> = [
      ['The user declined to publish reports/q3; do not retry unless they ask.', 'Not published — you declined'],
      ['Nobody answered the request to publish reports/q3 within an hour, so it was not published.', 'Not published — no answer within an hour'],
      ['Not published: Over your quota. Nothing was published.', 'Not published — over your quota. Nothing was published'],
      ['`x` is outside your workspace folder. Give a path relative to the workspace root.', 'Not published — the agent’s request could not be carried out']
    ]
    for (const [error, line] of live) {
      const { container, unmount } = mount({ status: 'error', error })
      expect(container.textContent).toBe(line)
      unmount()
    }
  })
})
