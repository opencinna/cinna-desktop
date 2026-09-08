/**
 * Ollama — models running on the user's own machine.
 *
 * The odd one out among the adapters in three ways, each of which is a
 * deliberate decision rather than an accident of the API:
 *
 * **It has no key.** A credential row for Ollama stores a host and nothing
 * else; `shared/credentials.ts` is what makes the rest of the app agree that
 * such a row is still usable. The OpenAI SDK requires *some* `apiKey` string to
 * construct, so `KEYLESS_PLACEHOLDER_KEY` is passed and Ollama ignores it.
 *
 * **It speaks two protocols and this uses both.** Generation goes over
 * Ollama's OpenAI-compatible `/v1` surface, because that is the one that
 * carries tool calls and streaming in a shape the whole app already handles —
 * so `stream()` is the OpenAI adapter's, delegated to verbatim rather than
 * reimplemented. Listing goes over the **native** `/api/tags`, because `/v1/models`
 * returns bare ids while `/api/tags` returns the family, the parameter size and
 * the quantisation. The parameter size is what Work Complexity classifies a
 * local model by (`shared/modelFamilies.ts`), and it is not recoverable from
 * the tag alone: `deepseek-r1:latest` is a 7B and says so nowhere in its name.
 *
 * **A failure here usually means "it isn't running", not "you're unauthorised".**
 * That is a different sentence, with a different fix, and {@link parseError}
 * exists mostly to say it — a raw `TypeError: fetch failed` on the credentials
 * screen tells the user nothing about the `ollama serve` they have not started.
 */

import { OpenAIAdapter } from './openai'
import { TEXT_EXTRACTABLE_MIMES } from './capabilityMimes'
import { isChatCapableModelId } from '../../shared/modelDefaults'
import {
  KEYLESS_PLACEHOLDER_KEY,
  OLLAMA_DEFAULT_HOST,
  ollamaOpenAIBaseUrl
} from '../../shared/credentials'
import {
  LLMAdapter,
  LLMError,
  ModelCapability,
  ModelInfo,
  StreamParams,
  StreamResult
} from './types'

/**
 * Two ceilings, because the two calls sit on very different paths.
 *
 * **Listing** happens inside `getAllModels()`, which walks the adapters
 * *sequentially* with no cache, and runs on every `provider:list-models` and
 * before every engine start. A loopback Ollama that is not running refuses
 * instantly, so the default host never pays this — but a powered-off box on the
 * LAN, or a remote host behind a firewall, **hangs** rather than refusing, and
 * at five seconds each that is five seconds added to a model picker opening and
 * to an engine start. The user most likely to have set a non-default host is
 * exactly the user whose host can hang.
 *
 * **Probing** is a foreground action the user asked for — opening the
 * credentials screen, or pressing Test — and it is the one call whose whole job
 * is to wait long enough to be believed. A false "nothing answered" about a slow
 * LAN host sends the user to fix something that is not broken, so it keeps the
 * longer ceiling.
 */
const LIST_TIMEOUT_MS = 1_500
const PROBE_TIMEOUT_MS = 5_000

/**
 * Locally-runnable models that accept images.
 *
 * A list of **families**, matched loosely against the tag, because an Ollama tag
 * is user-controlled: the same weights are `llava:13b`, `llava:latest` and
 * whatever a `Modelfile` called them. Wrong in the permissive direction costs an
 * attach button that produces a confused answer; wrong in the strict direction
 * hides the button on a model that would have worked, which is the harder
 * failure to diagnose because nothing appears at all.
 *
 * The version ranges (`gemma[3-9]`, `llama[4-9]`, `mistral-small[3-9]`) rather
 * than pinned majors are the same bet the cloud rules in `modelFamilies` make:
 * once a line goes multimodal it stays multimodal, and a pinned `gemma3` would
 * silently hide the attach button on the day `gemma4` shipped — which is not a
 * hypothetical, it is what a machine here was already running.
 */
const OLLAMA_VISION_FAMILY =
  /(llava|bakllava|moondream|minicpm-?v|granite\d*[.-]?\d*-vision|-vision|vl\b|qwen\d\.?\d?-?vl|gemma[3-9]|llama[4-9]|mistral-small[3-9])/i

/**
 * Embedding-only families, which the shared chat-capability filter misses.
 *
 * The shared `isChatCapableModelId` looks for `embedding` — and almost no Ollama
 * embedding model is spelled that way. The registry's are `nomic-embed-text`,
 * `mxbai-embed-large`, `snowflake-arctic-embed2`, `all-minilm`, `bge-m3`: the
 * token is `embed`, or there is no token at all and the family name is the only
 * clue. Every one of them would otherwise have been offered in the model picker
 * as something to chat with, and answered the first turn with a 400.
 *
 * So this matches `embed` as its own token — optionally `embedding`, optionally
 * with a version digit — plus the four families that name themselves after the
 * architecture instead.
 */
const OLLAMA_NON_CHAT =
  /(?:^|[-_/])embed(?:ding)?\d*(?:[-_/:.]|$)|^(?:all-minilm|bge|gte|paraphrase)[-_:]/i

const OLLAMA_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/**
 * A tighter file envelope than the cloud adapters', on purpose.
 *
 * Nothing here is rate-limited or billed, so the instinct is to be generous.
 * The binding constraint is the other one: a local model's context window is
 * commonly 4k–32k tokens, and this app's text extractor inlines an attachment
 * into the prompt whole. A 20MB spreadsheet does not cost the user money on
 * Ollama — it silently truncates their conversation instead, which is worse
 * than a refusal at attach time.
 */
const OLLAMA_MAX_FILE = 8 * 1024 * 1024
const OLLAMA_MAX_FILES = 5

/** One entry of Ollama's native `GET /api/tags`, as far as this cares. */
interface OllamaTag {
  name?: unknown
  model?: unknown
  details?: {
    family?: unknown
    parameter_size?: unknown
    quantization_level?: unknown
  }
}

/** A local model, with the metadata `/v1/models` would not have given us. */
export interface OllamaModelDetail {
  id: string
  /** `llama`, `qwen2`, `gemma3` — Ollama's own architecture family. */
  family: string | null
  /** `3.2B`, `7B`, `70B` — verbatim from Ollama, including the `B`. */
  parameterSize: string | null
  quantization: string | null
}

/**
 * Ask an Ollama server what it is running, without constructing an adapter.
 *
 * Split out as a free function because two callers need it before any
 * credential exists: the detection probe that offers to add Ollama in the first
 * place, and the Add-credential form's Test button. Throws on an unreachable
 * host — callers decide whether that is an error or simply "not running".
 */
export async function fetchOllamaTags(host: string): Promise<OllamaModelDetail[]> {
  const response = await fetch(`${host.replace(/\/+$/, '')}/api/tags`, {
    signal: AbortSignal.timeout(LIST_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new Error(`Ollama answered ${response.status} for /api/tags`)
  }
  const body = (await response.json()) as { models?: unknown }
  const raw = Array.isArray(body?.models) ? (body.models as OllamaTag[]) : []

  const out: OllamaModelDetail[] = []
  for (const entry of raw) {
    const id = typeof entry?.name === 'string' && entry.name !== ''
      ? entry.name
      : typeof entry?.model === 'string'
        ? entry.model
        : null
    if (!id) continue
    if (!isChatCapableModelId(id) || OLLAMA_NON_CHAT.test(id)) continue
    const details = entry.details ?? {}
    out.push({
      id,
      family: typeof details.family === 'string' ? details.family : null,
      parameterSize:
        typeof details.parameter_size === 'string' ? details.parameter_size : null,
      quantization:
        typeof details.quantization_level === 'string' ? details.quantization_level : null
    })
  }
  // Alphabetical, which is what `ollama list` does and therefore what the user
  // already has in their head. There is no "newest" to sort by — `modified_at`
  // is when the blob was pulled, not when the model was released.
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}

/**
 * The version string of an Ollama server, or null if nothing answers.
 *
 * Never throws: "is Ollama running" is a question with a legitimate `no`, and a
 * caller that has to wrap the probe in a `try` to learn that will eventually
 * forget to.
 */
export async function probeOllama(host: string): Promise<string | null> {
  try {
    const response = await fetch(`${host.replace(/\/+$/, '')}/api/version`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
    if (!response.ok) return null
    const body = (await response.json()) as { version?: unknown }
    return typeof body?.version === 'string' ? body.version : ''
  } catch {
    return null
  }
}

export class OllamaAdapter implements LLMAdapter {
  readonly providerType = 'ollama'
  private readonly host: string
  private readonly providerId: string
  /**
   * Generation is the OpenAI adapter's, unchanged. Ollama's `/v1` implements
   * the same streaming and tool-call wire format, and a second copy of that
   * conversion would be a second place for a tool-call bug to live.
   */
  private readonly openai: OpenAIAdapter

  constructor(providerId: string, host: string = OLLAMA_DEFAULT_HOST) {
    this.host = host.replace(/\/+$/, '')
    this.providerId = providerId
    this.openai = new OpenAIAdapter(KEYLESS_PLACEHOLDER_KEY, providerId, {
      baseURL: ollamaOpenAIBaseUrl(this.host)
    })
  }

  async listModels(): Promise<ModelInfo[]> {
    const details = await fetchOllamaTags(this.host)
    return details.map((model) => ({
      id: model.id,
      // The tag verbatim. `llama3.2:3b` is what the user typed into
      // `ollama pull`, what `ollama list` prints back and what they will search
      // this picker for; prettifying it into "Llama3.2 3b" would break the one
      // string they already recognise.
      name: model.id,
      providerId: this.providerId,
      providerType: this.providerType
    }))
  }

  stream(params: StreamParams): Promise<StreamResult> {
    return this.openai.stream(params)
  }

  modelCapability(modelId: string): ModelCapability {
    const vision = OLLAMA_VISION_FAMILY.test(modelId)
    return {
      acceptedMimeTypes: vision
        ? [...OLLAMA_IMAGE_MIMES, ...TEXT_EXTRACTABLE_MIMES]
        : [...TEXT_EXTRACTABLE_MIMES],
      nativeMimeTypes: vision ? [...OLLAMA_IMAGE_MIMES] : [],
      maxFileSizeBytes: OLLAMA_MAX_FILE,
      maxFilesPerMessage: OLLAMA_MAX_FILES
    }
  }

  /**
   * Say which of the two local failures this is.
   *
   * Every other adapter's errors are about an account. Ollama's are about a
   * process and a disk: the server is not started, or the model was never
   * pulled. Both have a one-line fix the user can act on, and neither is
   * discoverable from the raw text — a refused connection surfaces as
   * `TypeError: fetch failed` with the cause buried, and a missing model as a
   * 404 that reads identically to a bad endpoint.
   */
  parseError(error: Error): LLMError {
    const message = error.message
    const status = (error as Error & { status?: number }).status
    const cause = (error as Error & { cause?: { code?: string } }).cause
    const code = cause?.code ?? (error as Error & { code?: string }).code

    if (
      code === 'ECONNREFUSED' ||
      code === 'ECONNRESET' ||
      code === 'EHOSTUNREACH' ||
      code === 'ENOTFOUND' ||
      /fetch failed|ECONNREFUSED/i.test(message)
    ) {
      return {
        short: `Ollama isn’t answering at ${this.host} — start it with “ollama serve”`,
        detail: message
      }
    }
    if (code === 'ETIMEDOUT' || error.name === 'TimeoutError' || /timed? ?out/i.test(message)) {
      return { short: `Ollama at ${this.host} did not respond in time`, detail: message }
    }
    if (status === 404 || /not found, try pulling/i.test(message)) {
      return {
        short: 'That model isn’t pulled yet — run “ollama pull” for it first',
        detail: message
      }
    }
    return {
      short: message.length > 120 ? `${message.slice(0, 117)}...` : message,
      detail: message
    }
  }
}
