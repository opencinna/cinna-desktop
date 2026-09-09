import type { CinnaApp } from './app'

/**
 * Stub the LLM vendors **below the adapters**, by replacing `globalThis.fetch`
 * in the main process.
 *
 * ## Why this and not a base URL
 *
 * The suite used to redirect the SDKs with `ANTHROPIC_BASE_URL` /
 * `OPENAI_BASE_URL`, and that stopped working for a good reason: a shell
 * variable able to send a stored API key to a host the user never configured is
 * the defect `18e97b2` and its OpenAI counterpart closed, so both adapters now
 * pin their base URL. The fixture had been leaning on the vulnerability.
 *
 * The replacement does not go looking for another redirect. It intercepts the
 * transport itself, which is:
 *
 * - **immune to pinning**, including any future pin nobody has thought of yet —
 *   this sits below the adapter rather than negotiating with it;
 * - **the only option for a keyed credential.** `providerService.upsert` drops
 *   `baseUrl` for every type that requires a key ("key exfiltration with extra
 *   steps", in its own words) and `requiresApiKey` is by *type*, so an empty key
 *   buys no exemption. A keyless Ollama row is the only redirectable one, which
 *   is fine for a catalogue and useless for a spec that is *about* keyed rows;
 * - **the same technique the unit tests already use.** `anthropic.test.ts` and
 *   `openai.test.ts` drive the real SDK client over a stubbed `fetch`. One idea
 *   at two levels beats a second bespoke mechanism.
 *
 * It also makes the guarantee the old env trick only claimed: with this
 * installed, no request reaches a vendor. `credential-switch.spec.ts` has been
 * sending fake keys to `api.anthropic.com` and `api.openai.com` on every run
 * since its guard went inert, and it passed the whole time, because its
 * assertions never touch a catalogue.
 *
 * ## Why it works
 *
 * Both SDKs resolve `fetch` from the global **at client construction**
 * (`getDefaultFetch()` in each package's `internal/shims`), and
 * `providerService` builds a fresh adapter at every call site rather than
 * caching one. So a stub installed at any point before the call is the one that
 * gets used. Neither adapter passes its own `fetch`, so there is nothing else in
 * the way.
 *
 * ## Using it
 *
 * **Re-install after every `relaunch()`** — handlers and globals live in the app
 * process, and a restart is a new one. Same rule as any `electronApp.evaluate`
 * stub in this suite.
 */

/** One model as each vendor's list endpoint returns it. */
export interface StubModel {
  id: string
  /** Anthropic's `display_name`. OpenAI has none and the adapter derives it. */
  name?: string
}

export interface LlmFetchStub {
  /** Models `api.anthropic.com/v1/models` will list. Omit for none. */
  anthropic?: StubModel[]
  /** Models `api.openai.com/v1/models` will list. Omit for none. */
  openai?: StubModel[]
}

/**
 * Install the stub in the app's main process.
 *
 * Anything aimed at a vendor host is answered from `models` — a catalogue on the
 * list endpoint, and a 401 on everything else, which is what an unrecognised
 * request *should* look like to a spec holding a fake key. Every other request
 * is passed to the real `fetch`, so nothing else in main is disturbed.
 */
export async function stubLlmFetch(cinna: CinnaApp, models: LlmFetchStub = {}): Promise<void> {
  await cinna.electronApp.evaluate(async (_electron, stub) => {
    const g = globalThis as typeof globalThis & { __cinnaRealFetch?: typeof fetch }
    // Keep the first real one: re-installing must not wrap a previous stub and
    // build a chain that answers from the wrong layer.
    g.__cinnaRealFetch ??= g.fetch
    const real = g.__cinnaRealFetch as typeof fetch

    const VENDORS = ['api.anthropic.com', 'api.openai.com']
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', 'request-id': 'e2e' }
      })

    g.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const raw =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      let host = ''
      try {
        host = new URL(raw).host
      } catch {
        // Not an absolute URL — nothing a vendor SDK produces. Let it through.
      }
      if (!VENDORS.includes(host)) return real(input as RequestInfo, init)

      const path = new URL(raw).pathname
      if (host === 'api.anthropic.com' && path.startsWith('/v1/models')) {
        return json({
          data: (stub.anthropic ?? []).map((m) => ({
            type: 'model',
            id: m.id,
            display_name: m.name ?? m.id,
            created_at: '2026-01-01T00:00:00Z'
          })),
          has_more: false,
          first_id: null,
          last_id: null
        })
      }
      if (host === 'api.openai.com' && path.startsWith('/v1/models')) {
        return json({
          object: 'list',
          data: (stub.openai ?? []).map((m) => ({
            id: m.id,
            object: 'model',
            created: 1,
            owned_by: 'openai'
          }))
        })
      }
      // A fake key is what these specs hold, so this is the honest answer for
      // anything else — and it is answered *here*, without leaving the machine.
      return json(
        host === 'api.anthropic.com'
          ? { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }
          : { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } },
        401
      )
    }) as typeof fetch
  }, models)
}
