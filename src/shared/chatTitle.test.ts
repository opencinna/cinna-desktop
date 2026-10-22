import { describe, expect, it } from 'vitest'
import { AUTO_TITLE_MAX_FROM_MESSAGE, deriveTitleFromMessage } from './chatTitle'
import { withPathRefs, type ComposerPathRef } from './pathMentions'

/**
 * The fallback title of a new chat, and what main's auto-title takes for
 * "still untouched". Reference chips are sent as lines naming absolute paths;
 * they are never the title.
 */

const site: ComposerPathRef = { path: '/Users/me/website', displayPath: '~/website', kind: 'dir' }
const report: ComposerPathRef = { path: '/Users/me/docs/report.md', displayPath: '~/docs/report.md', kind: 'file' }

describe('deriveTitleFromMessage', () => {
  it('is the message, cut at the limit with an ellipsis', () => {
    expect(deriveTitleFromMessage('Hello')).toBe('Hello')
    const long = 'x'.repeat(AUTO_TITLE_MAX_FROM_MESSAGE + 5)
    expect(deriveTitleFromMessage(long)).toBe('x'.repeat(AUTO_TITLE_MAX_FROM_MESSAGE) + '…')
  })

  it('is the typed text when reference chips went with it', () => {
    expect(deriveTitleFromMessage(withPathRefs('Summarise the report', [report, site]))).toBe('Summarise the report')
  })

  it('is the chip names, joined, when nothing was typed', () => {
    expect(deriveTitleFromMessage(withPathRefs('', [report, site]))).toBe('report.md, website')
  })
})
