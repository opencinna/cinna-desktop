import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HANDOVER_SETTING,
  HANDOVER_GATE_OPTIONS,
  HANDOVER_HOW_TO_REPORT,
  HANDOVER_REPORT_STATUSES,
  HANDOVER_SCHEMA_VERSION,
  HANDOVER_STATES,
  HANDOVERS_DIR,
  MAX_HANDOVER_DEPTH,
  TERMINAL_REPORT_STATUSES,
  handoverGateQuestion,
  handoverGateRequestId,
  handoverProtocolParagraph,
  HANDOVER_WARNING_KINDS,
  isDepthAllowed,
  isHandoverId,
  isReadyBrief,
  isReportTerminal,
  parseHandoverBrief,
  parseHandoverGateRequestId,
  parseHandoverReport,
  parseHandoverSetting,
  parseHandoverState,
  allowsAuto,
  autoRefusalFor,
  handoverWarningKind,
  buildHandoverReturnPacket,
  buildHandoverGroupPacket,
  buildHandoverRevisionTurn,
  isRevisionFileName,
  parseHandoverRevision,
  revisionOrdinal,
  HANDOVER_PACKET_CAP,
  type HandoverGroupMember,
  type HandoverParseReason,
  type HandoverState
} from './handovers'

/** The failure reason, or `'ok'` — so a matrix row reads as one value. */
const reasonOf = (result: { ok: boolean } & { reason?: HandoverParseReason }): string =>
  result.ok ? 'ok' : (result.reason ?? 'missing-reason')

const brief = (frontmatter: string, body = 'Do the thing.'): string =>
  `---\n${frontmatter}\n---\n${body}\n`

const READY = ['cinna_handover: 1', 'title: Add retry to the uploader', 'status: ready'].join('\n')

describe('parseHandoverBrief — the happy path', () => {
  it('reads every field of a full brief', () => {
    const result = parseHandoverBrief(
      brief(
        [
          'cinna_handover: 1',
          'title: Add retry to the uploader',
          'status: ready',
          'execution: auto',
          'origin:',
          '  agent: agent-folder-external:root:api',
          '  chat: chat_123',
          '  task: task_456',
          'depth: 2',
          'group: release-cut',
          'unknown_key: ignored'
        ].join('\n'),
        'Retry the 5xx path.\n\nTwo tests, please.'
      )
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.brief).toEqual({
      title: 'Add retry to the uploader',
      status: 'ready',
      execution: 'auto',
      origin: {
        agentId: 'agent-folder-external:root:api',
        chatId: 'chat_123',
        taskId: 'task_456'
      },
      depth: 2,
      group: 'release-cut',
      body: 'Retry the 5xx path.\n\nTwo tests, please.'
    })
    expect(isReadyBrief(result)).toBe(true)
  })

  it('defaults execution to ask, depth to 1, and leaves origin and group null', () => {
    const result = parseHandoverBrief(brief(READY))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.brief.execution).toBe('ask')
    expect(result.brief.depth).toBe(1)
    expect(result.brief.origin).toBeNull()
    expect(result.brief.group).toBeNull()
  })

  it('accepts single- and double-quoted values', () => {
    const result = parseHandoverBrief(
      brief(
        [
          'cinna_handover: "1"',
          'title: "Add retry: to the uploader"',
          "status: 'ready'",
          'execution: "ask"',
          'depth: "2"'
        ].join('\n')
      )
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.brief.title).toBe('Add retry: to the uploader')
    expect(result.brief.status).toBe('ready')
    expect(result.brief.depth).toBe(2)
  })

  it('forgives a trailing space on either delimiter', () => {
    const result = parseHandoverBrief(`--- \n${READY}\n--- \nBody.\n`)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.brief.body).toBe('Body.')
  })

  it('accepts a BOM and CRLF line endings', () => {
    const text = `﻿---\r\n${READY.split('\n').join('\r\n')}\r\n---\r\nBody line one.\r\nBody line two.\r\n`
    const result = parseHandoverBrief(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.brief.title).toBe('Add retry to the uploader')
    expect(result.brief.body).toBe('Body line one.\nBody line two.')
  })

  it('keeps a fenced block in the body verbatim, `---` inside it included', () => {
    const body = ['Run this:', '', '```md', '---', 'not: frontmatter', '---', '```', '', 'Then report.'].join('\n')
    const result = parseHandoverBrief(brief(READY, body))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.brief.body).toBe(body)
  })

  it('trims the body but not its inner blank lines', () => {
    const result = parseHandoverBrief(brief(READY, '\n\nFirst.\n\n\nLast.\n\n'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.brief.body).toBe('First.\n\n\nLast.')
  })
})

describe('parseHandoverBrief — the reject matrix', () => {
  const rows: [string, string, HandoverParseReason][] = [
    ['plain markdown', '# Just a document\n\nNo frontmatter here.\n', 'no_frontmatter'],
    [
      'frontmatter that does not start the file',
      ['# Notes', '', '---', 'cinna_handover: 1', 'title: x', 'status: ready', '---', 'body'].join('\n'),
      'no_frontmatter'
    ],
    ['an indented delimiter', '  ---\ncinna_handover: 1\ntitle: x\nstatus: ready\n  ---\nbody\n', 'no_frontmatter'],
    ['an unclosed frontmatter', '---\ncinna_handover: 1\ntitle: x\nstatus: ready\n', 'no_frontmatter'],
    ['no marker', brief('title: Add retry\nstatus: ready'), 'no_marker'],
    ['a newer schema', brief('cinna_handover: 2\ntitle: x\nstatus: ready'), 'bad_schema_version'],
    ['a non-numeric marker', brief('cinna_handover: yes\ntitle: x\nstatus: ready'), 'bad_schema_version'],
    ['an unknown status', brief('cinna_handover: 1\ntitle: x\nstatus: in_progress'), 'bad_status'],
    ['no status at all', brief('cinna_handover: 1\ntitle: x'), 'bad_status'],
    ['an unknown execution', brief(`${READY}\nexecution: always`), 'bad_execution'],
    ['a non-integer depth', brief(`${READY}\ndepth: two`), 'bad_depth'],
    ['a fractional depth', brief(`${READY}\ndepth: 1.5`), 'bad_depth'],
    ['a negative depth', brief(`${READY}\ndepth: -1`), 'bad_depth'],
    ['no title', brief('cinna_handover: 1\nstatus: ready'), 'bad_title'],
    ['an empty title', brief('cinna_handover: 1\ntitle: "  "\nstatus: ready'), 'bad_title'],
    ['a numeric origin value', brief(`${READY}\norigin:\n  agent: 42`), 'bad_origin'],
    ['an empty origin value', brief(`${READY}\norigin:\n  chat:`), 'bad_origin'],
    ['an inline origin', brief(`${READY}\norigin: agent-1`), 'bad_origin'],
    ['an uppercase group', brief(`${READY}\ngroup: Release-Cut`), 'bad_group'],
    ['an empty group', brief(`${READY}\ngroup:`), 'bad_group']
  ]

  for (const [label, text, reason] of rows) {
    it(`rejects ${label} with ${reason}`, () => {
      expect(reasonOf(parseHandoverBrief(text))).toBe(reason)
    })
  }

  it('parses a draft but does not call it ready', () => {
    const result = parseHandoverBrief(brief('cinna_handover: 1\ntitle: x\nstatus: draft'))
    expect(result.ok).toBe(true)
    expect(isReadyBrief(result)).toBe(false)
  })

  it('closes the frontmatter at the first `---`, even inside a fence someone opened there', () => {
    // Documented behaviour, not an accident: tracking fences in the
    // frontmatter would let one stray fence swallow the whole file.
    const result = parseHandoverBrief(
      ['---', 'cinna_handover: 1', '```', '---', 'title: x', 'status: ready', '---', 'body'].join('\n')
    )
    expect(reasonOf(result)).toBe('bad_status')
  })
})

describe('the depth cap', () => {
  it('parses a brief over the cap and refuses it separately', () => {
    const result = parseHandoverBrief(brief(`${READY}\ndepth: ${MAX_HANDOVER_DEPTH + 1}`))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.brief.depth).toBe(MAX_HANDOVER_DEPTH + 1)
    expect(isDepthAllowed(result.brief.depth)).toBe(false)
  })

  it('allows 0 up to the cap and nothing else', () => {
    expect(isDepthAllowed(0)).toBe(true)
    expect(isDepthAllowed(MAX_HANDOVER_DEPTH)).toBe(true)
    expect(isDepthAllowed(MAX_HANDOVER_DEPTH + 1)).toBe(false)
    expect(isDepthAllowed(-1)).toBe(false)
    expect(isDepthAllowed(1.5)).toBe(false)
  })
})

describe('isHandoverId', () => {
  it('accepts the recommended shape', () => {
    expect(isHandoverId('20260917-2000-add-retry')).toBe(true)
    expect(isHandoverId('abc')).toBe(true)
    expect(isHandoverId('a.b_c-1')).toBe(true)
    expect(isHandoverId(`a${'b'.repeat(63)}`)).toBe(true)
  })

  it('rejects the wrong shapes', () => {
    expect(isHandoverId('Add-Retry')).toBe(false) // uppercase
    expect(isHandoverId('.hidden')).toBe(false) // leading dot
    expect(isHandoverId('-lead')).toBe(false) // leading dash
    expect(isHandoverId('ab')).toBe(false) // two characters
    expect(isHandoverId(`a${'b'.repeat(64)}`)).toBe(false) // 65 characters
    expect(isHandoverId('has space')).toBe(false)
    expect(isHandoverId('nested/id')).toBe(false)
    expect(isHandoverId(42)).toBe(false)
    expect(isHandoverId(undefined)).toBe(false)
  })
})

describe('parseHandoverReport', () => {
  const report = (frontmatter: string, body = 'Details.'): string => `---\n${frontmatter}\n---\n${body}\n`

  it('reads status, summary, question and artifacts', () => {
    const result = parseHandoverReport(
      report(
        [
          'cinna_handover: 1',
          'status: blocked',
          'summary: Retry added with backoff; two tests cover the 5xx path',
          'question: Should a 429 retry forever?',
          'artifacts:',
          '  - src/upload/retry.ts',
          '  - "src/upload/retry.test.ts"'
        ].join('\n')
      )
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.report).toEqual({
      status: 'blocked',
      summary: 'Retry added with backoff; two tests cover the 5xx path',
      question: 'Should a 429 retry forever?',
      artifacts: ['src/upload/retry.ts', 'src/upload/retry.test.ts'],
      body: 'Details.'
    })
  })

  it('leaves question null and artifacts empty when absent', () => {
    const result = parseHandoverReport(report('cinna_handover: 1\nstatus: in_progress\nsummary: Starting'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.report.question).toBeNull()
    expect(result.report.artifacts).toEqual([])
  })

  it('accepts an inline empty artifacts list', () => {
    const result = parseHandoverReport(report('cinna_handover: 1\nstatus: done\nsummary: Done\nartifacts: []'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.report.artifacts).toEqual([])
  })

  /*
    A real Claude turn read "one `- path` per line" literally and wrote
    `artifacts:\n  - path: RETRY.md`, which became a task artifact named
    "path: RETRY.md". The protocol text now shows a concrete example, and the
    parser reads the mistake back rather than storing it.
  */
  it('reads an item written as `- path:` or `- file:` as the path it names', () => {
    const result = parseHandoverReport(
      report('cinna_handover: 1\nstatus: done\nsummary: Done\nartifacts:\n  - path: RETRY.md\n  - file: src/upload/retry.ts\n  - docs/plain.md')
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.report.artifacts).toEqual(['RETRY.md', 'src/upload/retry.ts', 'docs/plain.md'])
  })

  it('keeps a quoted item with a colon in it whole', () => {
    const result = parseHandoverReport(
      report('cinna_handover: 1\nstatus: done\nsummary: Done\nartifacts:\n  - "notes: draft.md"')
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.report.artifacts).toEqual(['notes: draft.md'])
  })

  const rows: [string, string, HandoverParseReason][] = [
    ['no frontmatter', 'Just a report.\n', 'no_frontmatter'],
    [
      'an artifact map this contract does not define',
      report('cinna_handover: 1\nstatus: done\nsummary: Done\nartifacts:\n  - name: retry.ts'),
      'bad_artifacts'
    ],
    [
      'a `- path:` entry with nothing after it',
      report('cinna_handover: 1\nstatus: done\nsummary: Done\nartifacts:\n  - path:'),
      'bad_artifacts'
    ],
    ['no marker', report('status: done\nsummary: Done'), 'no_marker'],
    ['a newer schema', report('cinna_handover: 9\nstatus: done\nsummary: Done'), 'bad_schema_version'],
    ['a brief status', report('cinna_handover: 1\nstatus: ready\nsummary: Done'), 'bad_status'],
    ['no status', report('cinna_handover: 1\nsummary: Done'), 'bad_status'],
    ['no summary', report('cinna_handover: 1\nstatus: done'), 'bad_summary'],
    ['an empty summary', report('cinna_handover: 1\nstatus: done\nsummary: ""'), 'bad_summary'],
    ['a scalar artifacts value', report('cinna_handover: 1\nstatus: done\nsummary: Done\nartifacts: retry.ts'), 'bad_artifacts'],
    ['an empty artifact entry', report('cinna_handover: 1\nstatus: done\nsummary: Done\nartifacts:\n  -'), 'bad_artifacts']
  ]

  for (const [label, text, reason] of rows) {
    it(`rejects ${label} with ${reason}`, () => {
      expect(reasonOf(parseHandoverReport(text))).toBe(reason)
    })
  }

  it('knows which statuses finish a handover', () => {
    expect(HANDOVER_REPORT_STATUSES.filter(isReportTerminal)).toEqual([...TERMINAL_REPORT_STATUSES])
    expect(isReportTerminal('in_progress')).toBe(false)
    expect(isReportTerminal('blocked')).toBe(false)
  })
})

describe('desktop-side state', () => {
  it('falls back to seen for an unknown state', () => {
    expect(parseHandoverState('running')).toBe('running')
    expect(parseHandoverState('waiting_external')).toBe('waiting_external')
    expect(parseHandoverState('teleported')).toBe('seen')
    expect(parseHandoverState(null)).toBe('seen')
    expect(parseHandoverState(undefined)).toBe('seen')
    expect(parseHandoverState(1)).toBe('seen')
  })

  it('lists every state exactly once', () => {
    expect(new Set(HANDOVER_STATES).size).toBe(HANDOVER_STATES.length)
  })

  it('falls back to ask for an unknown setting', () => {
    expect(parseHandoverSetting('auto')).toBe('auto')
    expect(parseHandoverSetting('ask')).toBe('ask')
    expect(parseHandoverSetting('always')).toBe(DEFAULT_HANDOVER_SETTING)
    expect(parseHandoverSetting(undefined)).toBe('ask')
  })
})

describe('the gate', () => {
  it('is a single-choice question with the three options in order', () => {
    const question = handoverGateQuestion({ title: 'Add retry', folderName: 'uploader' })
    expect(question.multiSelect).toBe(false)
    expect(question.header).toBe('Handover')
    expect(question.question).toContain('Add retry')
    expect(question.question).toContain('uploader')
    expect(question.options.map((option) => option.label)).toEqual([
      HANDOVER_GATE_OPTIONS.run,
      HANDOVER_GATE_OPTIONS.runAndAuto,
      HANDOVER_GATE_OPTIONS.skip
    ])
  })

  it('offers only Run and Skip where auto could not be granted', () => {
    // Offering a standing permission that would be refused on the way back is
    // worse than not offering it: the user clicks, and the app says no.
    const question = handoverGateQuestion({ title: 'Add retry', folderName: 'uploader', offerAuto: false })
    expect(question.options.map((option) => option.label)).toEqual([
      HANDOVER_GATE_OPTIONS.run,
      HANDOVER_GATE_OPTIONS.skip
    ])
  })

  it('never renders an empty title or folder', () => {
    const question = handoverGateQuestion({ title: '   ', folderName: '' })
    expect(question.question).toContain('Untitled handover')
    expect(question.question).toContain('this project')
  })

  it('round-trips a request id', () => {
    const requestId = handoverGateRequestId('hov_abc123')
    expect(parseHandoverGateRequestId(requestId)).toBe('hov_abc123')
  })

  it('does not claim somebody else’s request id', () => {
    expect(parseHandoverGateRequestId('runner:attempt:run:call')).toBeNull()
    expect(parseHandoverGateRequestId('handover:')).toBeNull()
    expect(parseHandoverGateRequestId('')).toBeNull()
  })
})

describe('the words the protocol is taught in', () => {
  it('teaches the requester the report vocabulary and the claim rule', () => {
    for (const status of HANDOVER_REPORT_STATUSES) expect(HANDOVER_HOW_TO_REPORT).toContain(status)
    expect(HANDOVER_HOW_TO_REPORT).toContain(`cinna_handover: ${HANDOVER_SCHEMA_VERSION}`)
    expect(HANDOVER_HOW_TO_REPORT).toContain('report.md')
    expect(HANDOVER_HOW_TO_REPORT).toContain('before you start')
  })

  it('sends a Cinna-run executor to the brief, in one short paragraph', () => {
    /*
      The Description a UX review read was this paragraph: ~250 words of the
      report schema with the same absolute path in it three times, above a task
      whose own goal was two lines (`ux_rules.md` §7). The vocabulary belongs to
      the brief's own footer — which the executor is being told to read — so
      what is left here is the pointer and the one instruction about reporting.
      Mutation: restore the long paragraph and the word count fails.
    */
    const paragraph = handoverProtocolParagraph({
      briefPath: `${HANDOVERS_DIR}/20260917-2000-add-retry/brief.md`
    })
    expect(paragraph.split(/\s+/).length).toBeLessThanOrEqual(60)
    expect(paragraph).toContain('20260917-2000-add-retry/brief.md')
    // Once. The path is 90 characters of noise the second time it is read.
    expect(paragraph.split('20260917-2000-add-retry/brief.md')).toHaveLength(2)
    expect(paragraph).toContain('report.md')
    expect(paragraph).toContain('before you start')
    expect(paragraph).not.toContain('\n')
  })

  it('names the report format instead of promising the brief ends with it', () => {
    /*
      It used to say the brief "ends with the exact format". True of a brief
      written from this app's own template and of nothing else: anything can
      write a brief, the footer is a recommendation, and an executor sent to
      look for a format that is not there has been told something false about a
      file (`ux_rules.md` §9). Mutation: point at the brief again and the three
      field expectations fail.
    */
    const paragraph = handoverProtocolParagraph({ briefPath: 'a/brief.md' })
    expect(paragraph).toContain('cinna_handover: 1')
    expect(paragraph).toContain('status: in_progress | blocked | done | failed')
    expect(paragraph).toContain('summary')
    expect(paragraph).not.toContain('the brief ends with')
    expect(paragraph.split(/\s+/).length).toBeLessThanOrEqual(60)
  })

  it('shows a real path instead of a placeholder an agent could copy', () => {
    // The placeholder *was* copied: `- path` arrived as a YAML key and the
    // artifact became "path: RETRY.md". The brief's footer is where the
    // `artifacts:` example lives now; neither text may say `- path`.
    const paragraph = handoverProtocolParagraph({ briefPath: 'a/brief.md' })
    for (const text of [HANDOVER_HOW_TO_REPORT, paragraph]) expect(text).not.toContain('- path')
    expect(HANDOVER_HOW_TO_REPORT).toContain('- src/upload/retry.ts')
  })

  it('has a sentence for every warning kind, with no token left over', () => {
    // The list is the union written out; `handoverText.test.ts` is what walks
    // it against the renderer's sentences. Here: it stays in step with the
    // kinds main can write, which is the `HandoverWarning` union itself.
    expect(HANDOVER_WARNING_KINDS).toContain('report_missing')
    expect(new Set(HANDOVER_WARNING_KINDS).size).toBe(HANDOVER_WARNING_KINDS.length)
    for (const kind of HANDOVER_WARNING_KINDS) expect(kind).not.toContain(':')
  })

  it('round-trips its own footer through the brief parser', () => {
    const result = parseHandoverBrief(brief(READY, `Do the work.\n\n${HANDOVER_HOW_TO_REPORT}`))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.brief.body).toContain('## How to report')
  })
})

describe('the git-ignore verdict', () => {
  it('allows auto only where nothing can arrive by pull', () => {
    expect(allowsAuto({ result: 'ignored' })).toBe(true)
    expect(allowsAuto({ result: 'not_a_repo' })).toBe(true)
    // `unknown` is not `ignored`: a check that could not be made is not a
    // permission, and neither is a directory one `git add -A` from travelling.
    expect(allowsAuto({ result: 'unknown' })).toBe(false)
    expect(allowsAuto({ result: 'not_ignored' })).toBe(false)
    expect(allowsAuto({ result: 'tracked' })).toBe(false)
    expect(allowsAuto(null)).toBe(false)
    expect(allowsAuto(undefined)).toBe(false)
  })

  it('names the reason a refused auto is refused for', () => {
    expect(autoRefusalFor({ result: 'tracked' })).toBe('tracked')
    expect(autoRefusalFor({ result: 'not_ignored' })).toBe('not_ignored')
    expect(autoRefusalFor({ result: 'unknown' })).toBe('unknown')
  })
})

describe('warnings', () => {
  it('reads the kind out of a warning that carries a detail', () => {
    expect(handoverWarningKind('brief_edited')).toBe('brief_edited')
    expect(handoverWarningKind('auto_not_allowed:tracked')).toBe('auto_not_allowed')
    expect(handoverWarningKind('start_refused:That agent is unavailable: choose another.')).toBe('start_refused')
  })
})

describe('the return packet', () => {
  const base = {
    handoverId: '20260917-1200-retry',
    folderPath: '/projects/uploader',
    taskId: 'task-7',
    summary: 'Retry added with backoff'
  }

  it('opens with the id, what happened and the summary', () => {
    const done = buildHandoverReturnPacket({ ...base, status: 'done' })
    expect(done.split('\n')[0]).toBe('Handover `20260917-1200-retry` finished: Retry added with backoff')
    expect(done).toContain('Project: /projects/uploader')
    expect(done).toContain('Task: task-7')

    expect(buildHandoverReturnPacket({ ...base, status: 'failed', summary: 'The upload API changed' }).split('\n')[0])
      .toBe('Handover `20260917-1200-retry` failed: The upload API changed')
    expect(buildHandoverReturnPacket({ ...base, status: 'blocked' }).split('\n')[0])
      .toBe('Handover `20260917-1200-retry` is blocked: Retry added with backoff')
  })

  it('carries the question, and says how to answer it, only when blocked', () => {
    const blocked = buildHandoverReturnPacket({ ...base, status: 'blocked', question: 'Retry 4xx as well?' })
    expect(blocked).toContain('Question: Retry 4xx as well?')
    expect(blocked).toContain('Answer by writing a new brief or a revision in the handover folder.')

    // A `question` on a terminal report is noise: the work is over.
    expect(buildHandoverReturnPacket({ ...base, status: 'done', question: 'Retry 4xx as well?' }))
      .not.toContain('Question:')
  })

  it('says so when a blocked report forgot to ask anything', () => {
    // Otherwise the origin is told "blocked" and has to open the file to learn
    // that there is nothing in it to answer.
    const blocked = buildHandoverReturnPacket({ ...base, status: 'blocked', question: '  ' })
    expect(blocked).toContain('The executor did not say what it needs.')
  })

  it('lists artifacts exactly as the report wrote them, and omits an empty list', () => {
    const packet = buildHandoverReturnPacket({
      ...base, status: 'done', artifacts: ['src/upload/retry.ts', '  ', 'test/retry.test.ts']
    })
    expect(packet).toContain('Artifacts:\n- src/upload/retry.ts\n- test/retry.test.ts')
    expect(buildHandoverReturnPacket({ ...base, status: 'done', artifacts: [] })).not.toContain('Artifacts:')
    expect(buildHandoverReturnPacket({ ...base, status: 'done' })).not.toContain('Artifacts:')
  })

  it('caps the body from the end — a report is written top-down', () => {
    // The opposite of the catch-up packet, and the reason this is its own
    // function: a report leads with the answer, so cutting the front would send
    // back a fragment of its own appendix.
    const body = `${'A'.repeat(50)}${'B'.repeat(200)}`
    const packet = buildHandoverReturnPacket({ ...base, status: 'done', body, cap: 60 })
    expect(packet).toContain('A'.repeat(50))
    expect(packet).not.toContain('B'.repeat(20))
    expect(packet).toContain('[…report truncated; read report.md]')
  })

  it('keeps a body that fits verbatim, marker and all', () => {
    const body = 'Two tests cover the 5xx path.\n\n- one\n- two'
    const packet = buildHandoverReturnPacket({ ...base, status: 'done', body })
    expect(packet.endsWith(body)).toBe(true)
    expect(packet).not.toContain('truncated')
  })

  it('never returns only a header when there is nothing to say', () => {
    const packet = buildHandoverReturnPacket({
      ...base, taskId: null, status: 'failed', summary: '   ', body: '   '
    })
    expect(packet).toBe('Handover `20260917-1200-retry` failed: No summary was given.\n\nProject: /projects/uploader')
  })

  it('defaults the cap to the catch-up packet’s number', () => {
    expect(HANDOVER_PACKET_CAP).toBe(4000)
    const body = 'x'.repeat(HANDOVER_PACKET_CAP + 10)
    expect(buildHandoverReturnPacket({ ...base, status: 'done', body })).toContain('truncated')
    expect(buildHandoverReturnPacket({ ...base, status: 'done', body: 'x'.repeat(HANDOVER_PACKET_CAP) }))
      .not.toContain('truncated')
  })
})

describe('revisions', () => {
  const revision = (frontmatter: string, body = 'Also retry 429.'): string =>
    `---\n${frontmatter}\n---\n${body}\n`

  it('names the files that are revisions, and the ones that are not', () => {
    expect(['001.md', '002.md', '0010.md'].every(isRevisionFileName)).toBe(true)
    // Two digits, no digits, another extension, a backup an editor left behind.
    expect(['01.md', 'notes.md', '001.txt', '001.md~', 'README.md'].some(isRevisionFileName)).toBe(false)
    expect(revisionOrdinal('001.md')).toBe('001')
    expect(revisionOrdinal('012.md')).toBe('012')
    expect(revisionOrdinal('brief.md')).toBeNull()
  })

  it('reads a revision with a title and one without', () => {
    const titled = parseHandoverRevision(revision('cinna_handover: 1\ntitle: Retry 429 too'))
    expect(titled.ok).toBe(true)
    if (!titled.ok) return
    expect(titled.revision).toEqual({ title: 'Retry 429 too', body: 'Also retry 429.' })

    const bare = parseHandoverRevision(revision('cinna_handover: 1'))
    expect(bare.ok).toBe(true)
    if (!bare.ok) return
    expect(bare.revision).toEqual({ title: null, body: 'Also retry 429.' })
  })

  it('ignores the brief-only keys rather than letting a revision change them', () => {
    // A revision that could flip `execution: auto` would be an edit-after-ready
    // with another name, so those keys are read by nobody.
    const result = parseHandoverRevision(revision('cinna_handover: 1\nstatus: ready\nexecution: auto\ndepth: 9'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.revision).sort()).toEqual(['body', 'title'])
  })

  const badRevisions: [string, string, HandoverParseReason][] = [
    ['no frontmatter', 'Just markdown.\n', 'no_frontmatter'],
    ['no marker', revision('title: Retry 429 too'), 'no_marker'],
    ['a newer schema', revision('cinna_handover: 2'), 'bad_schema_version'],
    ['an empty body', revision('cinna_handover: 1', '   \n\n'), 'bad_body']
  ]

  for (const [label, text, reason] of badRevisions) {
    it(`rejects ${label} with ${reason}`, () => {
      expect(reasonOf(parseHandoverRevision(text))).toBe(reason)
    })
  }

  it('builds a turn that says which handover moved, what changed and how to answer', () => {
    const turn = buildHandoverRevisionTurn({
      handoverId: '20260917-1200-retry',
      ordinal: '002',
      title: 'Retry 429 too',
      body: 'Also retry 429, with a longer backoff.',
      reportPath: '.cinna/handovers/20260917-1200-retry/report.md'
    })
    expect(turn).toContain('Revision 002 of handover `20260917-1200-retry`: Retry 429 too')
    expect(turn).toContain('Also retry 429, with a longer backoff.')
    expect(turn).toContain('.cinna/handovers/20260917-1200-retry/report.md')
  })

  it('leaves the title out when the revision had none', () => {
    const turn = buildHandoverRevisionTurn({
      handoverId: 'h',
      ordinal: '001',
      title: null,
      body: 'More.',
      reportPath: 'report.md'
    })
    expect(turn.startsWith('Revision 001 of handover `h`. ')).toBe(true)
  })
})

describe('the group packet', () => {
  const member = (
    handoverId: string,
    state: HandoverState,
    summary: string | null = 'Done it'
  ): HandoverGroupMember => ({ handoverId, state, summary })

  it('lists every member with its id, how it ended and its summary', () => {
    const packet = buildHandoverGroupPacket({
      groupId: 'rollout-42',
      members: [
        member('20260917-1200-api', 'done', 'Retry added'),
        member('20260917-1200-web', 'failed', 'The build was already broken'),
        member('20260917-1200-docs', 'skipped', null)
      ]
    })
    expect(packet).toContain('Handover group `rollout-42` has finished — 3 handovers:')
    expect(packet).toContain('- `20260917-1200-api` — done: Retry added')
    expect(packet).toContain('- `20260917-1200-web` — failed: The build was already broken')
    // A member with nothing to say still appears: "all of them" is the point.
    expect(packet).toContain('- `20260917-1200-docs` — skipped')
  })

  it('counts a single member in the singular — a late arrival wakes alone', () => {
    const packet = buildHandoverGroupPacket({ groupId: 'g', members: [member('late', 'done', 'Fine')] })
    expect(packet).toContain('1 handover:')
    expect(packet).not.toContain('handovers:')
  })

  it('names the task when the member has one', () => {
    const packet = buildHandoverGroupPacket({
      groupId: 'g',
      members: [{ handoverId: 'h', state: 'done', summary: 'Fine', taskId: 'task-7' }]
    })
    expect(packet).toContain('(task task-7)')
  })

  it('drops members from the end when the cap is reached, and says it did', () => {
    const members = Array.from({ length: 20 }, (_, index) =>
      member(`handover-${index}`, 'done', 'A summary long enough to be worth capping over')
    )
    const packet = buildHandoverGroupPacket({ groupId: 'g', members, cap: 300 })
    expect(packet).toContain('- `handover-0`')
    expect(packet).not.toContain('- `handover-19`')
    expect(packet).toContain('more handovers in this group')
  })
})
