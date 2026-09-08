/**
 * Finding an Ollama the user already has.
 *
 * Every other AI credential starts with the user going somewhere else to get a
 * key. Ollama is already installed, already running, and already has models
 * pulled — asking the user to type a localhost URL to tell us so is asking them
 * to restate something the machine can answer in thirty milliseconds.
 *
 * ## What it probes, and what it deliberately does not
 *
 * `GET /api/version` against, in order: `OLLAMA_HOST` if the environment sets
 * one, then the default `127.0.0.1:11434`. That is the whole *automatic* search.
 * There is no port scan and no LAN sweep: a process listening on an unexpected
 * port is not distinguishable from anything else listening there, and probing a
 * user's network on their behalf is not a thing a chat client should do unasked.
 *
 * ## The probe reaches any http(s) host the renderer names, and that is inherent
 *
 * `detect(host)` accepts an explicit host, because a user's Ollama may
 * legitimately be a box on their LAN — so there is no allow-list to check
 * against without removing the case the parameter exists for. What bounds it is
 * the shape of the answer and the cost of asking, not a filter:
 *
 *  - the reply is `{running, version, models, alreadyConfigured}` and nothing
 *    else — no status code, no body, no headers, no timing detail;
 *  - one request, a 5 s ceiling, and no retry;
 *  - it is never automatic: every probe is caused by a user opening the AI
 *    Credentials screen, choosing Ollama in the Add form, or pressing Test;
 *  - `normaliseOllamaHost` admits only `http:` and `https:`, and drops userinfo,
 *    so a pasted link cannot smuggle a credential into a stored `base_url` that
 *    is later logged and rendered.
 *
 * Stated plainly because the previous version of this paragraph said "there is
 * no port scan and no LAN sweep" full stop, which was true of the default
 * candidate list and had stopped being the whole story.
 *
 * ## When it runs
 *
 * Only when a screen asks — the AI Credentials section on mount, and the
 * Add-credential form when Ollama is picked. **Never on app start and never on a
 * timer.** A background probe would buy nothing (the answer is only interesting
 * while the user is looking at the credentials screen) and would put a socket
 * connection on the startup path, which is the kind of dependency that turns
 * into a two-second launch on a machine where something is firewalled.
 *
 * ## Why the result carries `alreadyConfigured`
 *
 * The renderer offers to add a detected Ollama. Doing that twice would leave two
 * credential rows pointing at the same server, both named Ollama, which is a
 * mess `runtimeService.findCredential` then has to resolve by name. So the
 * service answers the question the offer actually depends on — "is there already
 * a row for this host" — rather than making the renderer diff a list.
 */

import { llmProviderRepo } from '../db/llmProviders'
import { getSettingsScopeUserId } from '../auth/scope'
import { fetchOllamaTags, probeOllama } from '../llm/ollama'
import { OLLAMA_DEFAULT_HOST, normaliseOllamaHost } from '../../shared/credentials'
import { createLogger } from '../logger/logger'

const logger = createLogger('Ollama')

/** What a probe found, or did not. */
export interface OllamaDetection {
  /** True when something answered `/api/version` on {@link host}. */
  running: boolean
  /** The host that answered, or the best candidate when nothing did. */
  host: string
  /** Ollama's own version string. `''` when it answered but named no version. */
  version: string | null
  /** Chat-capable local models, alphabetical. Empty when nothing is pulled. */
  models: { id: string; parameterSize: string | null }[]
  /** A credential row for this host already exists in the user's own scope. */
  alreadyConfigured: boolean
}

/**
 * The hosts worth trying, best first.
 *
 * `OLLAMA_HOST` is how a user moves Ollama off the default port or onto another
 * box, and it is set in the shell they launched from — which for a packaged
 * macOS app is *not* the shell they use, so this is best-effort and the default
 * still gets tried. Deduped, because the common case is that the variable is set
 * to exactly the default and probing it twice doubles the wait when nothing is
 * running.
 */
function candidateHosts(): string[] {
  const hosts: string[] = []
  const fromEnv = normaliseOllamaHost(process.env.OLLAMA_HOST)
  if (fromEnv) hosts.push(fromEnv)
  if (!hosts.includes(OLLAMA_DEFAULT_HOST)) hosts.push(OLLAMA_DEFAULT_HOST)
  return hosts
}

export const ollamaService = {
  /**
   * Look for a running Ollama.
   *
   * Never throws and never rejects: "nothing is running" is the ordinary
   * answer, not an error, and a screen that has to catch an exception to render
   * its empty state will eventually render a red banner instead.
   *
   * When `host` is given, only that host is probed — that is the Add-credential
   * form's Test button, where the user has typed somewhere specific and a silent
   * fallback to `127.0.0.1` would report success for a server they did not name.
   */
  async detect(host?: string | null): Promise<OllamaDetection> {
    const asked = (host ?? '').trim()
    const explicit = normaliseOllamaHost(asked)

    // "Nothing was asked" and "what was asked is junk" are different questions
    // with the same falsy answer out of `normaliseOllamaHost`, and collapsing
    // them broke the property this method's docstring promises: a user typing
    // `my ollama box` and pressing Test got a probe of `127.0.0.1` and a green
    // "1 model available" about a server they had not named — followed by a
    // save of the unparseable string. So an unparseable *explicit* host reports
    // itself as not running rather than falling through to the candidates, and
    // the host it names is what the user typed, so the failure sentence quotes
    // it back to them.
    if (asked !== '' && !explicit) {
      return { running: false, host: asked, version: null, models: [], alreadyConfigured: false }
    }

    const candidates = explicit ? [explicit] : candidateHosts()

    for (const candidate of candidates) {
      const version = await probeOllama(candidate)
      if (version === null) continue
      let models: { id: string; parameterSize: string | null }[] = []
      try {
        models = (await fetchOllamaTags(candidate)).map((model) => ({
          id: model.id,
          parameterSize: model.parameterSize
        }))
      } catch (err) {
        // A server that answers `/api/version` but not `/api/tags` is running
        // and reachable; it just has nothing to say about models yet. Reporting
        // it as "not running" would send the user to fix the wrong thing.
        logger.warn('ollama answered /api/version but not /api/tags', {
          host: candidate,
          error: err instanceof Error ? err.message : String(err)
        })
      }
      return {
        running: true,
        host: candidate,
        version,
        models,
        alreadyConfigured: this.isConfigured(candidate)
      }
    }

    const fallback = candidates[0] ?? OLLAMA_DEFAULT_HOST
    return {
      running: false,
      host: fallback,
      version: null,
      models: [],
      alreadyConfigured: this.isConfigured(fallback)
    }
  },

  /**
   * Whether the user already has an Ollama credential for this host.
   *
   * Compares normalised origins, so a row saved as `http://localhost:11434`
   * and a probe that answered on `http://127.0.0.1:11434` are still two
   * spellings of one server rather than grounds for a duplicate row.
   */
  isConfigured(host: string): boolean {
    const needle = normaliseOllamaHost(host)
    if (!needle) return false
    return llmProviderRepo
      .list(getSettingsScopeUserId())
      .some(
        (row) =>
          row.type === 'ollama' &&
          normaliseOllamaHost(row.baseUrl ?? OLLAMA_DEFAULT_HOST) === needle
      )
  }
}
