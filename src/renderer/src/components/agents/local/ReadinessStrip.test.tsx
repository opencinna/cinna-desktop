import { render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import type { LocalAgentDto } from '../../../../../shared/localAgents'
import { ReadinessStrip } from './ReadinessStrip'

/**
 * What the top of the page says, and when it says nothing. Readiness is never
 * restated here (the composer's notice panel says it); a legacy folder — which
 * the validator always marks invalid for its missing `id` — gets the one
 * banner that carries the fix.
 */

function agent(overrides: Partial<LocalAgentDto> = {}): LocalAgentDto {
  return {
    id: 'folder:alpha',
    name: 'Alpha',
    readiness: 'ok',
    readinessReason: null,
    identity: 'manifest',
    validation: { errors: [], warnings: [], infos: [] },
    ...overrides
  } as unknown as LocalAgentDto
}

describe('ReadinessStrip', () => {
  it('says nothing of the folder’s readiness: the composer’s notice panel does', () => {
    for (const readiness of ['credentials_needed', 'invalid', 'contract_too_new'] as const) {
      const { container, unmount } = render(
        createElement(ReadinessStrip, {
          agent: agent({
            readiness,
            readinessReason: 'Broken.',
            validation: {
              errors: [{ code: 'manifest.slug.mismatch', message: 'Broken.', path: null }],
              warnings: [],
              infos: []
            } as unknown as LocalAgentDto['validation']
          }),
          onShowDetails: () => undefined
        })
      )
      expect(container.innerHTML).toBe('')
      unmount()
    }
  })

  it('renders nothing for a ready folder', () => {
    const { container } = render(createElement(ReadinessStrip, { agent: agent() }))
    expect(container.innerHTML).toBe('')
  })

  it('shows one banner for a legacy folder whose only error is the missing id', () => {
    render(
      createElement(ReadinessStrip, {
        agent: agent({
          identity: 'legacy',
          readiness: 'invalid',
          readinessReason: '`id` is required.',
          validation: {
            errors: [{ code: 'manifest.id.missing', message: '`id` is required.', path: null }],
            warnings: [],
            infos: []
          } as unknown as LocalAgentDto['validation']
        }),
        onShowDetails: () => undefined
      })
    )
    expect(screen.getByText(/legacy folder/i)).toBeTruthy()
    expect(screen.queryByText('`id` is required.')).toBeNull()
    // The findings are still one click away.
    expect(screen.getByRole('button', { name: /1 finding/ })).toBeTruthy()
  })

  it('shows one banner for a legacy folder whose other errors are only about skills', () => {
    render(
      createElement(ReadinessStrip, {
        agent: agent({
          identity: 'legacy',
          readiness: 'invalid',
          readinessReason: '`id` is required.',
          validation: {
            errors: [
              { code: 'manifest.id.missing', message: '`id` is required.', path: null },
              { code: 'skills.missing_skill_md', message: 'This folder has no SKILL.md.', path: 'skills/foo' }
            ],
            warnings: [],
            infos: []
          } as unknown as LocalAgentDto['validation']
        }),
        onShowDetails: () => undefined
      })
    )
    expect(screen.getByText(/legacy folder/i)).toBeTruthy()
    expect(screen.queryByText('`id` is required.')).toBeNull()
  })

  it('keeps only the legacy banner, with its findings link, for a legacy folder with a second problem', () => {
    render(
      createElement(ReadinessStrip, {
        agent: agent({
          identity: 'legacy',
          readiness: 'invalid',
          readinessReason: '`slug` must equal the folder name.',
          validation: {
            errors: [
              { code: 'manifest.id.missing', message: '`id` is required.', path: null },
              { code: 'manifest.slug.mismatch', message: 'slug', path: null }
            ],
            warnings: [],
            infos: []
          } as unknown as LocalAgentDto['validation']
        }),
        onShowDetails: () => undefined
      })
    )
    expect(screen.getByText(/legacy folder/i)).toBeTruthy()
    expect(screen.queryByText('`slug` must equal the folder name.')).toBeNull()
    expect(screen.getByRole('button', { name: /2 findings/ })).toBeTruthy()
  })
})
