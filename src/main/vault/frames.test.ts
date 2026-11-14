import { describe, expect, it, vi } from 'vitest'
import { HELPER_FRAME_MAX_PAYLOAD, HelperFrameType } from '../../shared/vault/protocol'
import { encodeFrame, FrameDecoder, FrameError, HelperSession, type Frame, type HelperDuplex } from './frames'

const text = (value: string): Uint8Array => new TextEncoder().encode(value)
const str = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

describe('frame codec', () => {
  it('writes length, type, channel and payload big-endian', () => {
    const frame = encodeFrame(HelperFrameType.data, 0x01020304, text('hi'))
    expect([...frame]).toEqual([0, 0, 0, 7, 1, 1, 2, 3, 4, 104, 105])
  })

  it('decodes frames split across chunks and coalesced into one', () => {
    const a = encodeFrame(HelperFrameType.ctl, 0, text('{"id":1}'))
    const b = encodeFrame(HelperFrameType.data, 7, text('payload'))
    const c = encodeFrame(HelperFrameType.eof, 7)
    const all = new Uint8Array([...a, ...b, ...c])
    // One byte at a time.
    const slow = new FrameDecoder()
    const out: Frame[] = []
    for (const byte of all) out.push(...slow.push(new Uint8Array([byte])))
    // All at once.
    const fast = new FrameDecoder().push(all)
    for (const frames of [out, fast]) {
      expect(frames.map((f) => [f.type, f.channel, str(f.payload)])).toEqual([
        [HelperFrameType.ctl, 0, '{"id":1}'], [HelperFrameType.data, 7, 'payload'], [HelperFrameType.eof, 7, '']
      ])
    }
    expect(slow.pending).toBe(0)
  })

  it('holds an incomplete frame until the rest arrives', () => {
    const frame = encodeFrame(HelperFrameType.data, 2, text('abcdef'))
    const decoder = new FrameDecoder()
    expect(decoder.push(frame.subarray(0, 10))).toEqual([])
    expect(decoder.pending).toBe(10)
    expect(decoder.push(frame.subarray(10)).map((f) => str(f.payload))).toEqual(['abcdef'])
  })

  it('carries the maximum payload and refuses one byte more', () => {
    const max = new Uint8Array(HELPER_FRAME_MAX_PAYLOAD).fill(7)
    const frames = new FrameDecoder().push(encodeFrame(HelperFrameType.data, 1, max))
    expect(frames[0].payload.byteLength).toBe(HELPER_FRAME_MAX_PAYLOAD)
    expect(() => encodeFrame(HelperFrameType.data, 1, new Uint8Array(HELPER_FRAME_MAX_PAYLOAD + 1))).toThrow(FrameError)
  })

  it('breaks on a length beyond the maximum, a length too short to hold a header, or an unknown type', () => {
    const tooLong = new Uint8Array(9)
    new DataView(tooLong.buffer).setUint32(0, 5 + HELPER_FRAME_MAX_PAYLOAD + 1)
    const decoder = new FrameDecoder()
    expect(() => decoder.push(tooLong)).toThrow(/Bad frame length/)
    // Stays broken: the framing is lost.
    expect(() => decoder.push(encodeFrame(HelperFrameType.eof, 1))).toThrow(FrameError)

    expect(() => new FrameDecoder().push(new Uint8Array([0, 0, 0, 4, 1, 0, 0, 0]))).toThrow(/Bad frame length/)
    expect(() => new FrameDecoder().push(new Uint8Array([0, 0, 0, 5, 9, 0, 0, 0, 1]))).toThrow(/Unknown frame type/)
  })

  it('refuses control frames off channel 0', () => {
    expect(() => encodeFrame(HelperFrameType.ctl, 3, text('{}'))).toThrow(FrameError)
  })
})

/** A scripted helper on the far side of a duplex. */
function fakeHelper() {
  const decoder = new FrameDecoder()
  let deliver: (bytes: Uint8Array) => void = () => {}
  let close: (error?: Error) => void = () => {}
  const received: Frame[] = []
  const paused = { count: 0, resumed: 0 }
  const duplex: HelperDuplex = {
    write: (bytes) => { received.push(...decoder.push(bytes)) },
    onData: (listener) => { deliver = listener },
    onClose: (listener) => { close = listener },
    pause: () => { paused.count++ },
    resume: () => { paused.resumed++ }
  }
  const control = (): { id: number; method: string; params: unknown }[] =>
    received.filter((f) => f.type === HelperFrameType.ctl).map((f) => JSON.parse(str(f.payload)))
  return {
    duplex,
    received,
    paused,
    control,
    send: (frame: Uint8Array) => deliver(frame),
    reply: (id: number, body: object) => deliver(encodeFrame(HelperFrameType.ctl, 0, text(JSON.stringify({ id, ...body })))),
    die: (error?: Error) => close(error)
  }
}

describe('HelperSession', () => {
  it('matches answers to requests by id, out of order', async () => {
    const helper = fakeHelper()
    const session = new HelperSession(helper.duplex)
    const a = session.request('vault.status', { vaultId: 'a' })
    const b = session.request('vault.lock', { vaultId: 'b' })
    const [first, second] = helper.control()
    expect(first).toMatchObject({ method: 'vault.status', params: { vaultId: 'a' } })
    helper.reply(second.id, { result: { state: 'locked' } })
    helper.reply(first.id, { error: { code: 'not_found', message: 'gone' } })
    await expect(b).resolves.toEqual({ state: 'locked' })
    await expect(a).rejects.toMatchObject({ code: 'not_found', message: 'gone' })
  })

  it('times a request out', async () => {
    vi.useFakeTimers()
    try {
      const session = new HelperSession(fakeHelper().duplex, { requestTimeoutMs: 50 })
      const pending = session.request('availability', {})
      const check = expect(pending).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(60)
      await check
    } finally {
      vi.useRealTimers()
    }
  })

  it('hands events to listeners', () => {
    const helper = fakeHelper()
    const session = new HelperSession(helper.duplex)
    const events: unknown[] = []
    session.onEvent((event) => events.push(event))
    helper.send(encodeFrame(HelperFrameType.ctl, 0, text(JSON.stringify({ event: 'vault.state', vaultId: 'v', state: 'unlocked', until: 5 }))))
    expect(events).toEqual([{ event: 'vault.state', vaultId: 'v', state: 'unlocked', until: 5 }])
  })

  it('fails every pending request and channel when the helper goes away', async () => {
    const helper = fakeHelper()
    const session = new HelperSession(helper.duplex)
    const opening = session.openChannel('v')
    helper.reply(helper.control()[0].id, { result: { channel: 4 } })
    const channel = await opening
    const pending = session.request('vault.list', { dir: '/x' })
    const reader = channel.readable.getReader()
    helper.die()
    await expect(pending).rejects.toMatchObject({ code: 'unavailable' })
    await expect(reader.read()).rejects.toMatchObject({ code: 'unavailable' })
    await expect(session.request('availability', {})).rejects.toBeTruthy()
  })

  it('keeps data the helper sends right behind the channel.open answer', async () => {
    const helper = fakeHelper()
    const session = new HelperSession(helper.duplex)
    const opening = session.openChannel('v')
    const id = helper.control()[0].id
    // Answer and first bytes in one chunk, before the caller has the channel.
    helper.send(new Uint8Array([
      ...encodeFrame(HelperFrameType.ctl, 0, text(JSON.stringify({ id, result: { channel: 9 } }))),
      ...encodeFrame(HelperFrameType.data, 9, text('early')),
      ...encodeFrame(HelperFrameType.eof, 9)
    ]))
    const channel = await opening
    const reader = channel.readable.getReader()
    expect(str((await reader.read()).value!)).toBe('early')
    expect((await reader.read()).done).toBe(true)
  })

  it('writes channel bytes as data frames of at most the maximum payload, and close as eof', async () => {
    const helper = fakeHelper()
    const session = new HelperSession(helper.duplex)
    const opening = session.openChannel('v')
    helper.reply(helper.control()[0].id, { result: { channel: 2 } })
    const channel = await opening
    const writer = channel.writable.getWriter()
    await writer.write(new Uint8Array(HELPER_FRAME_MAX_PAYLOAD * 2 + 10))
    await writer.close()
    const frames = helper.received.filter((f) => f.channel === 2)
    expect(frames.map((f) => [f.type, f.payload.byteLength])).toEqual([
      [HelperFrameType.data, HELPER_FRAME_MAX_PAYLOAD], [HelperFrameType.data, HELPER_FRAME_MAX_PAYLOAD],
      [HelperFrameType.data, 10], [HelperFrameType.eof, 0]
    ])
  })

  it('errors the reader on rst, and sends rst when the caller closes', async () => {
    const helper = fakeHelper()
    const session = new HelperSession(helper.duplex)
    const open = async (n: number) => {
      const opening = session.openChannel('v')
      helper.reply(helper.control().at(-1)!.id, { result: { channel: n } })
      return opening
    }
    const killed = await open(5)
    const reader = killed.readable.getReader()
    helper.send(encodeFrame(HelperFrameType.rst, 5, text('guest went away')))
    await expect(reader.read()).rejects.toThrow('guest went away')
    await expect(killed.writable.getWriter().write(text('x'))).rejects.toBeTruthy()

    const closed = await open(6)
    closed.close('done here')
    expect(helper.received.find((f) => f.channel === 6 && f.type === HelperFrameType.rst)).toBeTruthy()
  })

  it('answers data for an unknown channel with rst', () => {
    const helper = fakeHelper()
    new HelperSession(helper.duplex)
    helper.send(encodeFrame(HelperFrameType.data, 77, text('stray')))
    expect(helper.received.map((f) => [f.type, f.channel])).toEqual([[HelperFrameType.rst, 77]])
  })

  it('pauses the helper output while a channel reader is behind, and resumes once it reads', async () => {
    const helper = fakeHelper()
    const session = new HelperSession(helper.duplex, { channelHighWaterMark: 8 })
    const opening = session.openChannel('v')
    helper.reply(helper.control()[0].id, { result: { channel: 3 } })
    const channel = await opening
    helper.send(encodeFrame(HelperFrameType.data, 3, text('0123456789')))
    expect(helper.paused.count).toBe(1)
    const reader = channel.readable.getReader()
    expect(str((await reader.read()).value!)).toBe('0123456789')
    // The pull after the queue drained resumes the pipe.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(helper.paused.resumed).toBe(1)
  })

  it('a protocol break closes the session', async () => {
    const helper = fakeHelper()
    const session = new HelperSession(helper.duplex)
    const pending = session.request('availability', {})
    helper.send(new Uint8Array([0, 0, 0, 1, 0]))
    await expect(pending).rejects.toMatchObject({ code: 'protocol' })
    expect(session.closed).toBe(true)
  })
})
