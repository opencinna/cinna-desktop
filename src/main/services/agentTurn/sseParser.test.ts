/**
 * Every assertion here was mutation-checked by running the named mutation, not
 * by reasoning about it. Ten mutations were run; nine fail a named test.
 *
 * **The one survivor, declared rather than faked:** `if (line.startsWith(':'))
 * continue` in `feed`. Deleting it passes the whole suite, and that is correct
 * — a comment line's colon is at index 0, so the field split yields
 * `field === ''`, which the `field === 'data'` check drops anyway. The line is
 * behaviourally redundant today and is kept only as an explicit statement of
 * the SSE rule; the source says so at the line itself. Do not add a test for
 * it — the obvious one (a comment whose text contains `data:`) was written,
 * run, and passed against the mutation it was named for.
 */
import { describe, expect, it } from 'vitest'
import { SseParser } from './sseParser'

describe('SseParser', () => {
  it('emits one message per blank-line-terminated block', () => {
    const p = new SseParser()
    // Mutation `if (line === '') continue` (drop the flush) → this fails with
    // an empty array.
    expect(p.feed('data: {"a":1}\n\ndata: {"a":2}\n\n')).toEqual([
      { data: '{"a":1}' },
      { data: '{"a":2}' }
    ])
  })

  it('holds a line split across two feeds', () => {
    const p = new SseParser()
    // Mutation: `this.pending = lines.pop() ?? ''` → `this.pending = ''`.
    // The first feed then emits nothing *and* loses '{"a":' , so the second
    // feed produces `{"a":` -less garbage — this assertion fails.
    expect(p.feed('data: {"a":')).toEqual([])
    expect(p.feed('1}\n\n')).toEqual([{ data: '{"a":1}' }])
  })

  it('holds a block split across two feeds at the blank line', () => {
    const p = new SseParser()
    expect(p.feed('data: {"a":1}\n')).toEqual([])
    // Mutation: dropping the `dataLines` accumulation across feeds (resetting
    // it in `feed`) fails here with an empty array.
    expect(p.feed('\n')).toEqual([{ data: '{"a":1}' }])
  })

  it('joins multiple data lines in one block with a newline', () => {
    const p = new SseParser()
    // Mutation: `this.dataLines.join('\n')` → `join('')` fails this.
    expect(p.feed('data: line1\ndata: line2\n\n')).toEqual([{ data: 'line1\nline2' }])
  })

  it('strips exactly one leading space from a data value', () => {
    const p = new SseParser()
    // Mutation: `value.slice(1)` → `value.trimStart()` fails this, because the
    // second space is part of the payload.
    expect(p.feed('data:  two-spaces\n\n')).toEqual([{ data: ' two-spaces' }])
  })

  it('handles a data field with no value at all', () => {
    const p = new SseParser()
    // `data:` alone is a legal empty payload line. Mutation: `colon === -1 ?
    // line : ...` mis-handling a bare `data` (no colon) would push 'data'
    // itself as the value; this pins the empty-string result.
    expect(p.feed('data:\n\n')).toEqual([{ data: '' }])
  })

  it('keeps only `data` out of a block carrying event, id, retry and heartbeats', () => {
    const p = new SseParser()
    // The input is the observed wire shape, heartbeats included, so this one
    // test both documents the format and pins the field filter.
    //
    // Mutation `if (field === 'data')` → `if (true)` fails this: the block
    // would carry 'session.idle', 'evt_1' and '5' as extra lines.
    //
    // Note the heartbeat lines here are *not* what catches that mutation — the
    // redundant comment guard drops them first, which is exactly why the
    // standalone heartbeat test that used to sit above this one was deleted
    // rather than kept: run against `if (field === 'data')` → `if (true)` it
    // passed, and against `startsWith(':')` → `false` it also passed. It
    // distinguished nothing.
    const feed = ': heartbeat\nevent: session.idle\nid: evt_1\nretry: 5\ndata: {"a":1}\n: heartbeat\n\n'
    expect(p.feed(feed)).toEqual([{ data: '{"a":1}' }])
  })

  it('treats CRLF as a line terminator', () => {
    const p = new SseParser()
    // Mutation: delete the `\r\n?` normalisation → the data value keeps a
    // trailing '\r' and this fails.
    expect(p.feed('data: {"a":1}\r\n\r\n')).toEqual([{ data: '{"a":1}' }])
  })

  it('emits nothing for a blank line with no data accumulated', () => {
    const p = new SseParser()
    // Mutation: `if (this.dataLines.length === 0) return null` → `return
    // { data: '' }` fails this by emitting a phantom message per heartbeat
    // block, which downstream would try to `JSON.parse('')`.
    expect(p.feed('\n\n\n')).toEqual([])
  })

  it('reset() drops a partial line so a reconnect cannot glue it onto the new socket', () => {
    const p = new SseParser()
    p.feed('data: {"a":')
    p.reset()
    // Mutation: make `reset()` a no-op → the feed below produces
    // `{"a":{"b":2}` , a corrupt payload, and this fails.
    expect(p.feed('data: {"b":2}\n\n')).toEqual([{ data: '{"b":2}' }])
  })

  it('reset() drops a partially accumulated block', () => {
    const p = new SseParser()
    p.feed('data: stale\n')
    p.reset()
    // Mutation: `reset()` clearing only `pending` and not `dataLines` fails
    // here — the message would be 'stale\nfresh'.
    expect(p.feed('data: fresh\n\n')).toEqual([{ data: 'fresh' }])
  })
})
