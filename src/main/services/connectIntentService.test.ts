import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  connectIntentService,
  connectUrlFromArgv,
  normalizeServerOrigin,
  parseConnectUrl
} from '../host/desktop/connectIntentService'
import { CONNECT_INTENT_ARGV_FLAG, CONNECT_INTENT_CHANNEL } from '../../shared/connectIntent'
import { clearLogEntries, getLogEntries } from '../logger/logger'

/**
 * The deep link is the one input to this app that an attacker can supply
 * without already being able to run code as the user: a web page can ask the
 * browser to open a `cinna://` URL. So the accept/refuse table below is the
 * interesting part of the file, and every refusal is written as its own case —
 * a single "rejects bad input" test would pass with half the checks deleted.
 *
 * What it deliberately does not test: that a refused link shows nothing. That
 * is the confirm step's property, and it is enforced by there being no path
 * from an intent to `auth:register` that does not go through
 * `ConnectIntentPanel`.
 */
describe('normalizeServerOrigin', () => {
  it.each([
    ['https://cinna.acme.com', 'https://cinna.acme.com'],
    ['https://cinna.acme.com/', 'https://cinna.acme.com'],
    ['https://cinna.acme.com:8443', 'https://cinna.acme.com:8443'],
    // Default ports are dropped by `URL.origin`, which is what makes two
    // spellings of the same server compare equal against a stored profile.
    ['https://cinna.acme.com:443', 'https://cinna.acme.com'],
    // Path, query and fragment are dropped rather than rejected: the landing
    // page has no reason to send them, and a link that carries one is far more
    // likely to be sloppy than hostile.
    ['https://cinna.acme.com/api/v1?x=1#f', 'https://cinna.acme.com'],
    ['  https://cinna.acme.com  ', 'https://cinna.acme.com'],
    // Loopback over plain http, so a developer can aim the app at their own
    // server without a certificate.
    ['http://localhost:8000', 'http://localhost:8000'],
    ['http://127.0.0.1:8000/', 'http://127.0.0.1:8000']
  ])('accepts %s as %s', (input, expected) => {
    const result = normalizeServerOrigin(input)
    expect(result).toEqual({ ok: true, origin: expected })
  })

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['not a url', 'unparseable'],
    ['ftp://cinna.acme.com', 'a scheme that is not http(s)'],
    ['file:///etc/passwd', 'file'],
    ['javascript:alert(1)', 'javascript'],
    // The one that matters most: plain http off-loopback would send the OAuth
    // bootstrap over a link anyone on the path can read and rewrite.
    ['http://cinna.acme.com', 'plain http off loopback'],
    // Credentials in the URL would be forwarded on every later request by
    // whatever fetches the discovery document.
    ['https://user:pw@cinna.acme.com', 'embedded credentials'],
    [`https://${'a'.repeat(4000)}.com`, 'an oversized URL']
  ])('refuses %s (%s)', (input) => {
    expect(normalizeServerOrigin(input).ok).toBe(false)
  })
})

describe('parseConnectUrl', () => {
  it('reads the server out of the authority form', () => {
    const intent = parseConnectUrl('cinna://connect?server=https://cinna.acme.com')
    expect(intent?.serverUrl).toBe('https://cinna.acme.com')
    expect(typeof intent?.receivedAt).toBe('number')
  })

  it('reads the server out of the path form', () => {
    // Which of the two spellings the OS delivers has depended on the platform
    // and on how the link was written; both mean the same thing.
    const intent = parseConnectUrl('cinna:///connect?server=https://cinna.acme.com')
    expect(intent?.serverUrl).toBe('https://cinna.acme.com')
  })

  it('url-decodes the server parameter', () => {
    const intent = parseConnectUrl(
      'cinna://connect?server=https%3A%2F%2Fcinna.acme.com%3A8443'
    )
    expect(intent?.serverUrl).toBe('https://cinna.acme.com:8443')
  })

  it.each([
    ['a foreign scheme', 'https://connect?server=https://cinna.acme.com'],
    ['an unknown action', 'cinna://disconnect?server=https://cinna.acme.com'],
    ['no server parameter', 'cinna://connect'],
    ['an empty server parameter', 'cinna://connect?server='],
    ['an unusable server', 'cinna://connect?server=http://cinna.acme.com'],
    ['not a URL at all', 'cinna:'],
    ['nonsense', 'hello']
  ])('refuses %s', (_label, url) => {
    expect(parseConnectUrl(url)).toBeNull()
  })
})

describe('connectUrlFromArgv', () => {
  it('finds a bare cinna:// argument anywhere in argv', () => {
    expect(
      connectUrlFromArgv([
        '/Applications/Cinna.app/Contents/MacOS/Cinna',
        '--use-mock-keychain',
        'cinna://connect?server=https://cinna.acme.com'
      ])
    ).toBe('cinna://connect?server=https://cinna.acme.com')
  })

  it('finds the test-only flag form', () => {
    expect(
      connectUrlFromArgv([
        '/repo',
        `${CONNECT_INTENT_ARGV_FLAG}cinna://connect?server=https://cinna.acme.com`
      ])
    ).toBe('cinna://connect?server=https://cinna.acme.com')
  })

  it('ignores an argv with no link', () => {
    // The app is routinely launched with a path argument and Chromium's own
    // switches; neither may be read as an intent.
    expect(connectUrlFromArgv(['/repo', '--use-mock-keychain'])).toBeNull()
  })
})

describe('the pending intent buffer', () => {
  beforeEach(() => connectIntentService.reset())

  it('buffers an accepted intent for a renderer that is not there yet', () => {
    connectIntentService.deliver('cinna://connect?server=https://a.example', 'open-url')
    expect(connectIntentService.getPending()?.serverUrl).toBe('https://a.example')
  })

  it('does not buffer a refused one', () => {
    connectIntentService.deliver('cinna://connect?server=ftp://a.example', 'open-url')
    expect(connectIntentService.getPending()).toBeNull()
  })

  it('replaces rather than queues, so the newest click is what is confirmed', () => {
    connectIntentService.deliver('cinna://connect?server=https://a.example', 'open-url')
    connectIntentService.deliver('cinna://connect?server=https://b.example', 'open-url')
    expect(connectIntentService.getPending()?.serverUrl).toBe('https://b.example')
  })

  it('keeps the buffer until it is consumed', () => {
    connectIntentService.deliver('cinna://connect?server=https://a.example', 'argv')
    connectIntentService.consume()
    expect(connectIntentService.getPending()).toBeNull()
  })

  it('consumes only the named intent when given one, so a newer click survives', () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(2000)
    const first = connectIntentService.deliver('cinna://connect?server=https://a.example', 'clipboard', { push: false })!
    connectIntentService.deliver('cinna://connect?server=https://b.example', 'open-url')
    const newer = connectIntentService.getPending()!
    connectIntentService.consume(first.receivedAt)
    expect(connectIntentService.getPending()?.serverUrl).toBe('https://b.example')
    connectIntentService.consume(newer.receivedAt)
    expect(connectIntentService.getPending()).toBeNull()
  })
})

/**
 * The install handoff's clipboard read. The clipboard is the user's private
 * data, so the cases that matter most are the ones where nothing happens: no
 * second read, no read over a pending link, and nothing that is not a link in
 * the log.
 */
describe('checkClipboardOnce', () => {
  const LINK = 'cinna://connect?server=https://cinna.example.com'
  const send = vi.fn()

  beforeEach(() => {
    connectIntentService.reset()
    clearLogEntries()
    send.mockClear()
    connectIntentService.install(
      () => ({ isDestroyed: () => false, webContents: { send } }) as never
    )
  })

  /** Every log entry, flattened, so a test can ask whether a string leaked. */
  const logged = (): string => JSON.stringify(getLogEntries())

  it('reads the clipboard once per process', () => {
    const source = vi.fn(() => 'nothing to see')
    connectIntentService.installClipboardSource(source)
    connectIntentService.checkClipboardOnce()
    connectIntentService.checkClipboardOnce()
    expect(source).toHaveBeenCalledTimes(1)
  })

  it('does not read again even after the first read found a link and it was consumed', () => {
    const source = vi.fn(() => LINK)
    connectIntentService.installClipboardSource(source)
    expect(connectIntentService.checkClipboardOnce()?.serverUrl).toBe('https://cinna.example.com')
    connectIntentService.consume()
    expect(connectIntentService.checkClipboardOnce()).toBeNull()
    expect(source).toHaveBeenCalledTimes(1)
  })

  it('ignores text that is not a cinna:// link, and does not log it', () => {
    const secret = 'sk-ant-api03-my-private-clipboard-text'
    connectIntentService.installClipboardSource(() => secret)
    expect(connectIntentService.checkClipboardOnce()).toBeNull()
    expect(connectIntentService.getPending()).toBeNull()
    expect(logged()).not.toContain(secret)
    expect(logged()).not.toContain('my-private')
  })

  it('ignores a cinna:// text that is not a connect link, without logging its action', () => {
    connectIntentService.installClipboardSource(() => 'cinna://my-private-token-123?x=1')
    expect(connectIntentService.checkClipboardOnce()).toBeNull()
    expect(logged()).not.toContain('my-private-token')
  })

  it.each(['cinna:///connect?server=https://cinna.example.com', 'CINNA://Connect/?server=https://cinna.example.com'])(
    'still accepts the other spelling %s',
    (text) => {
      connectIntentService.installClipboardSource(() => text)
      expect(connectIntentService.checkClipboardOnce()?.serverUrl).toBe('https://cinna.example.com')
    }
  )

  it('ignores an oversized cinna:// text without parsing or logging it', () => {
    const huge = `${LINK}&pad=${'x'.repeat(4000)}`
    connectIntentService.installClipboardSource(() => huge)
    expect(connectIntentService.checkClipboardOnce()).toBeNull()
    expect(logged()).not.toContain('xxxxxxxx')
    // The pre-filter, not the parser, refused it: the parser logs a warning.
    expect(getLogEntries().filter((e) => e.level === 'warn')).toHaveLength(0)
  })

  it('buffers a valid link from the clipboard, case-insensitively and trimmed, without pushing it', () => {
    connectIntentService.installClipboardSource(() => `  CINNA://connect?server=https://cinna.example.com\n`)
    const intent = connectIntentService.checkClipboardOnce()
    expect(intent?.serverUrl).toBe('https://cinna.example.com')
    expect(connectIntentService.getPending()).toEqual(intent)
    expect(send).not.toHaveBeenCalled()
    expect(getLogEntries().some((e) => JSON.stringify(e.data ?? null).includes('"source":"clipboard"'))).toBe(true)
  })

  it('a pushed delivery does reach the window spy, so the no-push assertion above means something', () => {
    connectIntentService.deliver(LINK, 'open-url')
    expect(send).toHaveBeenCalledWith(CONNECT_INTENT_CHANNEL, expect.objectContaining({ serverUrl: 'https://cinna.example.com' }))
  })

  // Null rather than the clicked link: the renderer consumes a late answer, and
  // a clicked link returned here would be consumed with it.
  it('does not read over a pending intent, and does not return it', () => {
    connectIntentService.deliver('cinna://connect?server=https://clicked.example', 'open-url')
    const source = vi.fn(() => LINK)
    connectIntentService.installClipboardSource(source)
    expect(connectIntentService.checkClipboardOnce()).toBeNull()
    expect(source).not.toHaveBeenCalled()
    expect(connectIntentService.getPending()?.serverUrl).toBe('https://clicked.example')
  })

  it('never reads without a source (the E2E sandbox without its seam)', () => {
    expect(connectIntentService.checkClipboardOnce()).toBeNull()
  })

  it('returns null when the source throws, and logs only the failure', () => {
    connectIntentService.installClipboardSource(() => {
      throw new Error('pasteboard unavailable')
    })
    expect(connectIntentService.checkClipboardOnce()).toBeNull()
    expect(logged()).toContain('pasteboard unavailable')
  })

  it('reset forgets the source and the once flag', () => {
    const first = vi.fn(() => '')
    connectIntentService.installClipboardSource(first)
    connectIntentService.checkClipboardOnce()
    connectIntentService.reset()
    expect(connectIntentService.checkClipboardOnce()).toBeNull()
    expect(first).toHaveBeenCalledTimes(1)
  })
})

describe('a pasted link', () => {
  beforeEach(() => connectIntentService.reset())

  it('goes through the same funnel with source paste', () => {
    const intent = connectIntentService.deliver('cinna://connect?server=https://cinna.example.com', 'paste')
    expect(intent?.serverUrl).toBe('https://cinna.example.com')
    expect(getLogEntries().some((e) => JSON.stringify(e.data ?? null).includes('"source":"paste"'))).toBe(true)
  })

  it('is refused like any other bad link', () => {
    expect(connectIntentService.deliver('cinna://connect?server=http://cinna.example.com', 'paste')).toBeNull()
    expect(connectIntentService.getPending()).toBeNull()
  })
})
