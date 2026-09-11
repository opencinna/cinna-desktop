/**
 * A fake A2A agent at the **`fetch`** level, and a fake `a2aSessionRepo`.
 *
 * `runAgentTurn` never takes a transport as a parameter: `createA2AClient`
 * builds its fetch from the global `fetch` (`buildLoggingFetch(fetch)`, and
 * `buildAuthFetch` looks `fetch` up again on every call). So the lowest seam
 * that needs no production change is the global itself — and it is the one
 * worth taking, because everything above it then runs for real:
 *
 * - `a2a-client.ts`'s card fetch, bearer injection, and the 401/403 intercept
 *   that turns a rejection into `A2aHttpError` before the SDK sees it;
 * - the SSE tee `buildLoggingFetch` puts on every stream;
 * - the SDK's `JsonRpcTransport`: request ids, the `text/event-stream` check,
 *   `parseSseStream` framing real bytes, the id-mismatch and `error`-frame
 *   throws, and `A2AClient.invokeJsonRpc` handing a JSON-RPC error back as a
 *   value instead of throwing it (which `nonstreaming_rpc_error` depends on).
 *
 * A mocked `A2AClient` yielding pre-parsed events would pin none of that, and
 * phase 2 is precisely when the client construction moves.
 *
 * A fixture frame is the JSON-RPC response *minus* `jsonrpc` and `id`: the fake
 * fills both from the request it is answering, because the SDK numbers its own
 * requests and rejects a frame whose id does not match.
 */

export interface FixtureInput {
  chatId: string
  agentId: string
  agentName: string
  endpointUrl: string
  cardUrl: string
  accessToken?: string
  wireContent: string
  fileIds?: string[]
  isCinnaTokenAuth?: boolean
}

/** One JSON-RPC response body, without `jsonrpc`/`id` (see the header). */
export type Frame =
  | { result: unknown }
  | { error: { code: number; message: string; data?: unknown } }

/** How the fake answers one HTTP request. */
export type Reply =
  /** A plain HTTP response — a card, or a bare 401. */
  | { status: number; statusText?: string; json?: unknown }
  /** `fetch` itself rejects, the way undici does when the socket never opens. */
  | { network: { message: string; causeCode?: string; causeMessage?: string } }
  /**
   * A `text/event-stream` body, one `data:` frame per entry. With `hold` the
   * body stays open after the last frame until {@link FakeAgent.close} or the
   * signal handed to {@link FakeAgent.closeOnAbort} fires.
   */
  | { sse: Frame[]; hold?: boolean }
  /** A `message/send` answer: one JSON-RPC body with the request's id. */
  | { rpc: Frame }

export interface SessionRow {
  contextId: string | null
  taskId: string | null
  taskState: string | null
}

export interface A2aFixture {
  recorded_from: string
  description: string
  input: FixtureInput
  /** The `a2a_sessions` row this (chat, agent) already has; absent for none. */
  session?: SessionRow
  http: {
    /** `GET` of the agent card (`createA2AClient` fetches it every turn). */
    card: Reply
    /** `POST` to the endpoint: `message/stream` or `message/send`. */
    rpc?: Reply
  }
  script?: {
    /** Abort the turn's signal synchronously inside the Nth `onEvent` call. */
    abortAfterEmitted?: number
  }
}

export interface RecordedRequest {
  method: string
  url: string
  authorization: string | null
  /** Whether this HTTP request carries its turn or independent cancel signal. */
  signal: boolean
  /** Parsed JSON body; absent for a `GET`. */
  body?: { jsonrpc?: string; id?: unknown; method?: string; params?: unknown }
}

export interface FakeAgent {
  fetch: typeof fetch
  requests: RecordedRequest[]
  /** Close a held stream now. */
  close(): void
  /** Close a held stream when `signal` aborts — what the server does once cancelled. */
  closeOnAbort(signal: AbortSignal): void
}

const JSON_HEADERS = { 'content-type': 'application/json' }
const enc = new TextEncoder()

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

export function fakeA2aAgent(fixture: A2aFixture): FakeAgent {
  const requests: RecordedRequest[] = []
  let held: ReadableStreamDefaultController<Uint8Array> | null = null
  let closed = false
  let removeAbort = (): void => {}

  const close = (): void => {
    if (closed || !held) return
    closed = true
    removeAbort()
    held.close()
  }

  const answer = (reply: Reply, rpcId: unknown, signal?: AbortSignal | null): Response => {
    if ('network' in reply) {
      const cause = Object.assign(new Error(reply.network.causeMessage ?? reply.network.message), {
        code: reply.network.causeCode
      })
      throw new TypeError(reply.network.message, { cause })
    }
    if ('sse' in reply) {
      const frames = reply.sse
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) {
            const body = { jsonrpc: '2.0', id: rpcId, ...frame }
            controller.enqueue(enc.encode(`data: ${JSON.stringify(body)}\n\n`))
          }
          if (reply.hold) {
            held = controller
            const abort = (): void => {
              if (closed) return
              closed = true
              removeAbort()
              controller.error(signal?.reason)
            }
            removeAbort = () => signal?.removeEventListener('abort', abort)
            signal?.addEventListener('abort', abort, { once: true })
            if (signal?.aborted) abort()
          } else controller.close()
        }
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    if ('rpc' in reply) {
      const body = { jsonrpc: '2.0', id: rpcId, ...reply.rpc }
      return new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS })
    }
    return new Response(reply.json === undefined ? null : JSON.stringify(reply.json), {
      status: reply.status,
      statusText: reply.statusText,
      headers: reply.json === undefined ? undefined : JSON_HEADERS
    })
  }

  const fakeFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    init?.signal?.throwIfAborted()
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as RecordedRequest['body']) : undefined
    requests.push({
      method,
      url: urlOf(input),
      authorization: new Headers(init?.headers).get('authorization'),
      signal: init?.signal != null,
      ...(body ? { body } : {})
    })
    if (method === 'GET') return answer(fixture.http.card, undefined, init?.signal)
    if (body?.method === 'tasks/cancel') return answer({ rpc: { result: {
      kind: 'task', id: (body.params as { id: string }).id, contextId: 'cancel-context', status: { state: 'canceled' }
    } } }, body.id, init?.signal)
    if (!fixture.http.rpc) throw new Error(`fake agent: unexpected ${method} ${urlOf(input)}`)
    return answer(fixture.http.rpc, body?.id, init?.signal)
  }) as typeof fetch

  return {
    fetch: fakeFetch,
    requests,
    close,
    closeOnAbort(signal) {
      if (signal.aborted) close()
      else signal.addEventListener('abort', close, { once: true })
    }
  }
}

export type SessionPatch = SessionRow & { chatId: string; agentId: string }

export interface FakeSessionRepo {
  getByChatAndAgent(chatId: string, agentId: string): SessionPatch | undefined
  upsert(patch: SessionPatch): void
  /** What each `getByChatAndAgent` call returned, in order (`null` for none). */
  reads: (SessionRow | null)[]
  /** Every patch `upsert` was handed, verbatim, in order. */
  upserts: SessionPatch[]
}

/**
 * In-memory `a2aSessionRepo` with the real one's merge rule: a `null` field in
 * a patch keeps what the row already had (`patch.x ?? existing.x`).
 */
export function fakeSessionRepo(seed?: SessionPatch): FakeSessionRepo {
  const rows = new Map<string, SessionPatch>()
  const key = (chatId: string, agentId: string): string => `${chatId} ${agentId}`
  if (seed) rows.set(key(seed.chatId, seed.agentId), { ...seed })
  const reads: (SessionRow | null)[] = []
  const upserts: SessionPatch[] = []

  return {
    reads,
    upserts,
    getByChatAndAgent(chatId, agentId) {
      const row = rows.get(key(chatId, agentId))
      reads.push(row ? { contextId: row.contextId, taskId: row.taskId, taskState: row.taskState } : null)
      return row ? { ...row } : undefined
    },
    upsert(patch) {
      upserts.push({ ...patch })
      const existing = rows.get(key(patch.chatId, patch.agentId))
      rows.set(
        key(patch.chatId, patch.agentId),
        existing
          ? {
              ...existing,
              contextId: patch.contextId ?? existing.contextId,
              taskId: patch.taskId ?? existing.taskId,
              taskState: patch.taskState ?? existing.taskState
            }
          : { ...patch }
      )
    }
  }
}
