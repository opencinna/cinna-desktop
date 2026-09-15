import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../stores/logger.store', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { MessageBubble } from './MessageBubble'
import { repairNestedFences } from '../../utils/nestedFences'

const ZW = '\u200B'

const UNESCAPED = [
  "Here's the exact block to drop into the Workflow section:",
  '',
  '```markdown',
  "### Explain a deal's AVB rebate calculation",
  '',
  '```bash',
  'uv run scripts/explain_deal_avb.py --id=DEAL_ID_OR_URL',
  '```',
  '',
  "The script is read-only. It walks a single deal's AVB rebate through:",
  '1. AVB contact resolution',
  '2. The local tier and any matching special rate',
  '```',
  '',
  'Also worth noting for whoever does the edit: the References section is dangling.'
].join('\n')

const ZERO_WIDTH_ESCAPED = [
  'add something like this to the Workflow section yourself:',
  '',
  '```',
  "### Explain a deal's AVB rebate calculation",
  '',
  `${ZW}\`\`\`bash`,
  'uv run scripts/explain_deal_avb.py --id=DEAL_ID_OR_URL',
  `${ZW}\`\`\``,
  '```'
].join('\n')

/** What Copy text and Save to Notes read (`MessageContextMenu`). */
function markdownSource(container: HTMLElement): string {
  return container.querySelector('[data-message-markdown]')?.getAttribute('data-message-markdown') ?? ''
}

describe('nested code fences in a message bubble', () => {
  it('renders an unescaped nested block as one code block with the prose after it outside', () => {
    const { container } = render(<MessageBubble role="assistant" content={UNESCAPED} />)
    const blocks = container.querySelectorAll('pre')
    expect(blocks).toHaveLength(1)
    const code = blocks[0].textContent ?? ''
    expect(code).toContain('```bash\nuv run scripts/explain_deal_avb.py --id=DEAL_ID_OR_URL\n```')
    expect(code).toContain('1. AVB contact resolution')
    expect(container.querySelector('ol')).toBeNull()
    const after = screen.getByText(/Also worth noting/)
    expect(after.tagName).toBe('P')
    expect(after.closest('pre')).toBeNull()
  })

  it('renders zero-width-escaped fence lines without the zero-width space', () => {
    const { container } = render(<MessageBubble role="assistant" content={ZERO_WIDTH_ESCAPED} />)
    const blocks = container.querySelectorAll('pre')
    expect(blocks).toHaveLength(1)
    const code = blocks[0].textContent ?? ''
    expect(code).toContain('```bash\nuv run scripts/explain_deal_avb.py --id=DEAL_ID_OR_URL\n```')
    expect(code).not.toContain(ZW)
  })

  it('hands Copy text and Save to Notes the repaired text', () => {
    const { container } = render(<MessageBubble role="assistant" content={ZERO_WIDTH_ESCAPED} />)
    const source = markdownSource(container)
    expect(source).toBe(repairNestedFences(ZERO_WIDTH_ESCAPED))
    expect(source).toContain('\n````\n')
    expect(source).not.toContain(ZW)
  })

  it('repairs a user bubble too', () => {
    const { container } = render(<MessageBubble role="user" content={UNESCAPED} />)
    expect(container.querySelectorAll('pre')).toHaveLength(1)
    expect(screen.getByText(/Also worth noting/).closest('pre')).toBeNull()
    expect(markdownSource(container)).toContain('\n````markdown\n')
  })
})
