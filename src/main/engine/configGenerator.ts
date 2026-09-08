/**
 * The OpenCode configuration the desktop generates for its engine.
 *
 * Two rules decide everything in this file.
 *
 * **The config goes in the app data directory, never in the agents home.** The
 * home belongs to the user: an assistant may have it open, it is very often a
 * git repository, and Invariant 2 says exactly one file inside an agent folder
 * is the desktop's (`app-data/desktop.json`). The engine is pointed at our copy
 * with `OPENCODE_CONFIG_DIR` — see {@link engineManager} for why that variable
 * and not `OPENCODE_CONFIG` — and the generated per-agent prompt files sit
 * beside it.
 *
 * **A key is never written into the config.** Every provider entry names the
 * *environment variable* its key travels in (`env: ["CINNA_ENGINE_KEY_…"]`) and
 * the value is handed to the engine process as an environment variable
 * (Invariant 4). This is not cosmetic: the config file sits in the app data
 * directory at rest, gets read by anything that can read the user's home, and
 * would otherwise be a plaintext copy of every credential in the app — the
 * thing `safeStorage` exists to prevent.
 *
 * ## Two shapes that look like style and are not
 *
 * The engine has **two config readers**, and only the newer one decides what a
 * session can run on. The v1 reader resolves `{env:…}` and `{file:…}`
 * placeholders; the v2 reader — the one behind `model.available()`, `GET
 * /api/model` and `GET /api/agent` — parses the JSON and substitutes **nothing**
 * (verified against 1.18.27 on 3 Sep 2026, `opencode_contract.md` §9.5). So:
 *
 * - `options: {apiKey: "{env:NAME}"}` reaches the v2 catalog as the literal
 *   nine-character string `{env:NAME}` and is sent to the provider as the key.
 *   `env: ["NAME"]` instead registers an *integration connection* the runner
 *   resolves from the process environment — watched end to end, as
 *   `Authorization: Bearer <the value>` arriving at a probe server.
 * - `prompt: "{file:./prompts/<key>.md}"` arrives at the model **as those 34
 *   characters**, in place of the system prompt — watched at a probe server the
 *   engine was pointed at. The agent then has no instructions and one line of
 *   noise where they should be. The text is therefore inlined into the entry.
 *   The prompt file is still written beside the config — it is what the user's
 *   own assistant reads when it opens the folder — but the engine no longer
 *   reads it.
 *
 * A consequence worth knowing: OpenCode's v1 `/config` endpoint returns the
 * **resolved** configuration. Nothing we emit carries a key any more, but that
 * response can still carry one substituted from the user's own config, so it
 * must never be logged, echoed into a stream part, or forwarded to the renderer.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../logger/logger'
import { CUSTOM_MODEL_LIMITS, isEngineProviderType, type EngineProviderType } from './modelLimits'
import { GEMINI_OPENAI_BASE_URL } from './modelTransports'
import {
  KEYLESS_PLACEHOLDER_KEY,
  OLLAMA_DEFAULT_HOST,
  ollamaOpenAIBaseUrl,
  requiresApiKey
} from '../../shared/credentials'
import type { EngineSkipCode } from '../../shared/runtimeMessages'

const logger = createLogger('engine-config')

/**
 * OpenCode's provider key for each of our provider types.
 *
 * The key matters: OpenCode looks a canonical key up in the models.dev catalog
 * and gets the full model list, with real context and output windows, for free.
 * `openai_compatible` has no canonical key by definition — a gateway is
 * whatever the user pointed it at — so it always gets a custom entry.
 *
 * **`gemini` is not here, and its absence is the fix for a hang.** It used to
 * map to OpenCode's canonical `google` key, which catalogues the Gemini models
 * under `@ai-sdk/google` — a package `SessionRunnerModel` has no branch for.
 * The models were listed, they were *available*, the readiness check passed,
 * and the turn then died with `UnsupportedApiError`, which reaches no event at
 * all: a twenty-minute hang with nothing on screen. There is no point emitting
 * an entry the engine can catalogue and cannot run, so a `gemini` credential
 * takes the custom path instead, pointed at Google's own OpenAI-compatible
 * endpoint — see {@link PROVIDER_BASE_URL}.
 */
const CANONICAL_PROVIDER_KEY: Partial<Record<EngineProviderType, string>> = {
  anthropic: 'anthropic',
  openai: 'openai'
}

/**
 * The AI SDK package a **custom** provider entry loads.
 *
 * Needed only for the entries that cannot use a canonical key: a second
 * credential of a type whose canonical key is already taken, every
 * OpenAI-compatible gateway, and every `gemini` credential. A custom entry gets
 * no models.dev catalog either, which is why
 * {@link EngineProviderInput.models} has to be supplied for them.
 *
 * **`gemini` loads `@ai-sdk/openai-compatible`, not `@ai-sdk/google`.** The
 * engine can build a model from only three packages and Google's is not one of
 * them ({@link SUPPORTED_MODEL_PACKAGES}), so the Google SDK is not an option
 * here whatever the credential is.
 */
const PROVIDER_NPM: Readonly<Record<EngineProviderType, string>> = {
  anthropic: '@ai-sdk/anthropic',
  openai: '@ai-sdk/openai',
  gemini: '@ai-sdk/openai-compatible',
  openai_compatible: '@ai-sdk/openai-compatible',
  // Ollama serves an OpenAI-shaped `/v1`, which is one of the three transports
  // the engine can actually build a model from. models.dev *does* publish an
  // `ollama` key, but its model list is a fixed catalogue of what Ollama offers
  // for download — not what this machine has pulled — so a canonical entry would
  // list dozens of models that 404 on first use. The custom path declares
  // exactly the tags `ollama list` reports.
  ollama: '@ai-sdk/openai-compatible'
}

/**
 * Where a provider type's requests go when the credential does not say.
 *
 * Only Gemini has one. An `openai_compatible` credential *is* a base URL the
 * user typed, and the canonical types get their endpoint from models.dev.
 */
const PROVIDER_BASE_URL: Partial<Record<EngineProviderType, string>> = {
  gemini: GEMINI_OPENAI_BASE_URL,
  // Only reached by an Ollama credential saved with no host at all; a normal one
  // carries its own, and {@link engineBaseUrl} appends the `/v1` either way.
  ollama: ollamaOpenAIBaseUrl(OLLAMA_DEFAULT_HOST)
}

/**
 * The URL an entry's `options.baseURL` gets, from the credential and its type.
 *
 * Ollama is the one type whose stored `baseUrl` is **not** the URL the engine
 * should call: the credential holds an origin (`http://127.0.0.1:11434`),
 * because that is what the native `/api/tags` listing and the detection probe
 * need, while the engine talks the OpenAI-compatible dialect at `/v1`. Doing
 * that conversion here rather than storing the `/v1` form keeps one spelling of
 * the host in the database and one place that knows about the suffix.
 */
function engineBaseUrl(type: EngineProviderType, credentialBaseUrl: string | null): string | null {
  if (type === 'ollama') {
    return ollamaOpenAIBaseUrl(credentialBaseUrl || OLLAMA_DEFAULT_HOST)
  }
  return credentialBaseUrl || PROVIDER_BASE_URL[type] || null
}

/**
 * The conversation permission profile.
 *
 * The shape is OpenCode's: a permission name maps to an action, or to a
 * pattern→action map where the most specific matching pattern wins (their own
 * built-in `build` agent is written the same way — `read: *` allow, then
 * `read: *.env` ask).
 *
 * **An agent works freely inside its own folder.** A session's
 * `location.directory` *is* the agent folder, so the resources it names are
 * relative to it and a shell command starts there: reading, writing, editing
 * and running commands are therefore allowed outright. This is a deliberate
 * widening of the original profile, which allowed writes only under
 * `app-data/` and only three shapes of command. That profile asked about
 * nearly every step of ordinary work — the agent could not write a script it
 * had just been asked to write without a dialog — and a permission prompt that
 * fires constantly is not a control, it is a thing users learn to click
 * through. What is left asking is what the folder boundary does not cover.
 *
 * What still asks, and why each one is not convenience:
 *
 * - **`'*': 'ask'` has to be there explicitly.** OpenCode's own base rule is
 *   `{permission: '*', pattern: '*', action: 'allow'}` — verified by reading
 *   `GET /agent` back off a running engine — so a profile that only enumerates
 *   the tools it knows leaves *every other tool* on allow. Later entries
 *   override earlier ones, so this line lands after their base rule and before
 *   ours.
 * - **`external_directory` is `ask`**, which is what makes "inside its own
 *   folder" a boundary rather than a description: a session cannot wander into
 *   another agent's folder, or the rest of the disk, without the user seeing
 *   it.
 * - **`credentials/.env` and every other secret file are `deny`, for writes as
 *   well as reads — for the *file tools*, which is a narrower claim than it
 *   looks.** The shell tool asks under `bash` with the **command text**, and
 *   nothing else in this profile is consulted for it: `cat credentials/.env`
 *   is allowed by the `bash` rule, prints a key into the transcript, and never
 *   touches the `read` entry. The same goes for `curl` and the `webfetch` ask.
 *   Read out of the 1.18.27 binary, not inferred. So this entry stops the
 *   *edit tool* — the thing a model reaches for when asked to "add my key" —
 *   and the honest statement of the whole is the one the agent page makes: a
 *   command can reach anything the user can.** The desktop never reads credential values and neither
 *   should the agent it runs; the kit's rule is that a value is read from
 *   inside a script through `cinna_credentials.py` and never printed. An `ask`
 *   would put a one-click path to pasting the user's secrets into a transcript
 *   behind a dialog nobody reads carefully. The desktop's own `.env` editor is
 *   how a key gets written.
 * - **The agent's own identity files are `ask`.** `cinna-agent.json` and
 *   `docs/WORKFLOW_PROMPT.md` are what the agent *is*: the system prompt this
 *   very conversation is running on, and the manifest that binds it to a
 *   credential. The assembled prompt ends by telling the agent not to switch to
 *   the builder role for exactly this reason, and an instruction is not a
 *   control. Rewriting them is the one edit inside the folder that is worth one
 *   dialog — and now it is worth exactly one, because *Always allow* remembers
 *   it.
 * - **`sudo`, `rm -r` and `rm -rf` still ask.** Not a security boundary — a
 *   pattern over a command line can be walked around with a `&&`, and anything
 *   that runs a shell can do anything the user can. It is an *accident*
 *   boundary, and the accident it exists for is a confused model tidying up.
 *
 * **What `bash: '*': 'allow'` really means, stated once so nobody has to infer
 * it.** The engine gates a command by its text and asks `external_directory`
 * only for the path arguments of a fixed list of commands (`cd`, `rm`, `cp`,
 * `cat`, …) — so `python -c "open('~/.ssh/id_rsa')"` raises nothing, and the
 * folder is a boundary for the *file tools*, not for the shell. This is the
 * deliberate trade: an agent the user built, running in the user's own folder,
 * gets a shell without a dialog per command, and the agent page says plainly
 * that a command can reach anything the user can. Anyone tempted to describe
 * this profile as a sandbox should read this paragraph again.
 * - **`webfetch` is `ask`**, because reaching the network is the one ordinary
 *   step that is not contained by the folder at all.
 *
 * Answering these prompts is the runner's, and a user's *Always allow* is
 * recorded per agent in that folder's `app-data/desktop.json` and answered
 * `once` on their behalf — never sent to the engine, whose own saved grants are
 * user-global. See `permissionGrantService.ts` and the contract's §4.
 */

/**
 * **The matcher is not a glob, and every pattern in this file depends on that.**
 *
 * Read out of the 1.18.27 binary (`Wildcard.match`): a pattern is escaped, then
 * `*` → `.*` and `?` → `.`, then anchored `^…$`. So `*` crosses `/` freely and
 * there is no `**`. The consequence that matters:
 *
 * - `**​/.env` compiles to `^.*.*\/\.env$` — it **requires a slash**, so it does
 *   not match a `.env` at the agent-folder root. Every resource is
 *   `path.relative(worktree, file)` and the worktree is the agent folder, so a
 *   root-level `.env` is the literal string `.env` and the pattern misses it.
 * - `*.env` compiles to `^.*\.env$`, which matches `.env`, `credentials/.env`
 *   and `deep/nested/.env` alike. That is the spelling to use.
 *
 * A pattern that misses here fails **open**: the entry it belongs to simply
 * does not apply and the `'*'` rule above it decides. That is why these are
 * written as `*.x` and as exact relative paths, and why nothing in this file
 * spells `**`.
 */

/**
 * Files that can hold a credential value. Denied to every tool that could put
 * one in front of a model, read or write.
 *
 * `credentials/.env` is covered by `*.env` and listed anyway: it is the file
 * the kit actually defines, and a reader should not have to run the matcher in
 * their head to see that it is denied.
 */
const SECRET_FILES: Record<string, string> = {
  'credentials/.env': 'deny',
  '*.env': 'deny',
  '*.pem': 'deny',
  '*.key': 'deny'
}

/**
 * The files that define the agent. Editing one of them is editing the agent.
 *
 * Exact relative paths, because that is what the tools name: the kit puts one
 * manifest at the folder root and one workflow prompt at `docs/`, and a **bare**
 * folder puts its whole system prompt in `AGENT.md` at the root.
 *
 * The list covers both shapes at once rather than being built per agent. A kit
 * folder rarely has an `AGENT.md`, and where it does, asking before rewriting it
 * is right for the same reason; the cost of one dialog on a file that is not the
 * agent's identity is far below the cost of an agent silently rewriting the file
 * that *is*. The assembled prompt ends by telling the agent not to switch to the
 * builder role for exactly this reason — and an instruction is not a control.
 *
 * ### `README.md` is deliberately not here, and the rule is kept halfway
 *
 * A bare agent's closing prompt line names `AGENT.md` **and** `README.md` as the
 * builder's, because for that shape the README is the briefing an assistant
 * opening the folder reads (`localAgentService.initPrompt`). Only the first is
 * enforced, so half that sentence is backed by a control and half is an
 * instruction. That is a considered position, not an oversight:
 *
 * - This list is **global**. Adding `README.md` asks on every *kit* agent's
 *   plain documentation, which the template ships — the "fires constantly, so
 *   users learn to click through" failure the widening above exists to undo.
 * - "Update the README" is ordinary work a user asks an agent pointed at a
 *   repository to do, in a way "rewrite your own instructions" never is.
 * - The blast radii differ in kind. `AGENT.md` changes what the agent *is* on
 *   the next turn, silently and durably, with no human in the path. `README.md`
 *   changes text a **person** then copies, reads and pastes, and in the git
 *   working tree this shape targets it is visible in `git status` and revertible.
 *
 * What would change this: an init prompt consumed automatically rather than
 * pasted by a person. Then the human is no longer the control and `README.md`
 * belongs here — as a bare-only profile, since the first reason still stands.
 */
/**
 * A note on `write`: the built-in write and apply-patch tools ask under
 * `permission: "edit"` (the engine folds `edit|write|apply_patch` into one
 * visible tool), so the `write` block below is never consulted today. It is
 * kept as the defensive twin of `edit` — a tool that did ask under `write`
 * would otherwise land on the bare `'*': 'allow'` — and the `edit` entry is the
 * load-bearing one for every assertion about writing a file.
 */
const IDENTITY_FILES: Record<string, string> = {
  'cinna-agent.json': 'ask',
  'docs/WORKFLOW_PROMPT.md': 'ask',
  // A bare agent's system prompt. Without this entry the profile's own stated
  // rule — "the agent's own identity files are ask" — was not kept for the one
  // kind of agent whose identity is a single file.
  'AGENT.md': 'ask'
}

export const CONVERSATION_PERMISSIONS: Record<string, unknown> = {
  '*': 'ask',
  read: { '*': 'allow', ...SECRET_FILES },
  edit: { '*': 'allow', ...IDENTITY_FILES, ...SECRET_FILES },
  write: { '*': 'allow', ...IDENTITY_FILES, ...SECRET_FILES },
  // **Order is the mechanism here.** The engine resolves a permission with
  // `findLast` over the concatenated rule list — the last match wins, not the
  // most specific — and `fromConfig` preserves object key order. So `'*':
  // 'allow'` first and the narrow shapes after is what makes them fire; swap
  // them and every entry below becomes dead.
  //
  // The two `.env` shapes are an **accident guard, not a boundary**, and the
  // difference matters to whoever reads this next. What is matched is the full
  // command text of each command node, redirection included — verified in the
  // 1.18.27 binary (`ShellTool.collect`), which is why `printf 'K=v' >>
  // credentials/.env` asks. So they catch the obvious spelling of the mistake
  // this exists for: a model that decides to `cat` a key file while debugging.
  // They do not catch a path built from a shell variable, a `base64 -d`, or a
  // script file that reads the key itself, and nothing over a command line
  // could. `*credentials/.env*` rather than `*credentials/*` deliberately: the
  // kit ships `credentials/README.md` and expects the agent to read it, and a
  // prompt on that would teach the user to click through these.
  //
  // `rm -r *`, `rm -rf *` and `rm -fr *` are three entries because each is a
  // literal prefix: `rm -r *` compiles to `^rm -r( .*)?$` and does not match
  // `rm -rf /tmp/x`. None of them catches `rm --recursive`, `find . -delete`,
  // or anything after a `&&` — the same accident boundary, with the same limit.
  bash: {
    '*': 'allow',
    '*.env*': 'ask',
    '*credentials/.env*': 'ask',
    'sudo *': 'ask',
    'rm -r *': 'ask',
    'rm -rf *': 'ask',
    'rm -fr *': 'ask'
  },
  webfetch: 'ask',
  external_directory: 'ask'
}

/** One AI credential, ready to become a provider entry. */
export interface EngineProviderInput {
  /** Our `llm_providers` row id. Only ever used to derive stable names. */
  id: string
  /** `anthropic` | `openai` | `gemini` | `openai_compatible`. */
  type: string
  name: string
  /** The decrypted key. Goes to the env map, never into the config. */
  apiKey: string
  /** Required for `openai_compatible`; ignored otherwise. */
  baseUrl: string | null
  /** Needed for custom entries, which get no models.dev catalog. */
  models: { id: string; name: string }[]
}

/** One folder agent, ready to become an OpenCode agent entry. */
export interface EngineAgentInput {
  /** `folder:<manifest id>` — the `agents` row id. */
  agentId: string
  slug: string
  description: string
  /** The assembled system prompt. Written to its own file beside the config. */
  prompt: string
  /** Which {@link EngineProviderInput.id} this agent runs on. */
  providerId: string
  modelId: string
  /** Manifest `runtime.permissions`, merged over the conversation profile. */
  permissions?: Record<string, unknown> | null
}

export interface EngineConfigInput {
  providers: EngineProviderInput[]
  agents: EngineAgentInput[]
}

/** A credential that could not become a provider entry, and why. */
export interface SkippedProvider {
  providerId: string
  reason: string
}

/**
 * An agent that could not become an agent entry, and why — as a **code**.
 *
 * This module knows about OpenCode's config shape, not about copy. The reason
 * used to travel from here as the tail of a sentence the agent page completed,
 * so an edit in this file rewrote a line on that screen with nothing asserting
 * the result. `describeEngineSkip` owns the words now.
 */
export interface SkippedAgent {
  agentId: string
  code: EngineSkipCode
}

/**
 * How a model is named to the engine, everywhere outside the config file.
 *
 * `{providerID, id}` and not `{providerID, modelID}`: the latter is rejected by
 * `POST /api/session` (verified against 1.18.27 — the response is not even
 * JSON). The config file itself still spells the pair as `"<providerID>/<id>"`,
 * which is why this exists as a second representation rather than a rename.
 */
export interface EngineModelRef {
  providerID: string
  id: string
}

export interface BuiltEngineConfig {
  /** The config object, ready to be serialised. Contains no key. */
  config: Record<string, unknown>
  /** Credential environment for the engine process. **Never logged.** */
  env: Record<string, string>
  /** Our provider id → the OpenCode provider key it became. */
  providerKeys: Map<string, string>
  /** Our agent id → the OpenCode agent key it became. */
  agentKeys: Map<string, string>
  /**
   * Our agent id → the model its entry names, as the session API spells it.
   *
   * The engine's v2 session runner resolves a model from the **session's** own
   * `model` and never from `agent.<key>.model`, so this pair has to travel to
   * `POST /api/session` as well as into the config file. Carried beside
   * {@link agentKeys} so the runner can answer both questions from the config
   * the running process actually loaded.
   */
  agentModels: Map<string, EngineModelRef>
  /** Agent key → the prompt text that must be written beside the config. */
  prompts: Map<string, string>
  skippedProviders: SkippedProvider[]
  skippedAgents: SkippedAgent[]
}

/** Uppercase, `_`-separated, safe as an environment variable name fragment. */
function sanitizeForEnv(value: string): string {
  return value
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
}

/** Lowercase, `-`-separated, safe as a JSON config key. */
function sanitizeForKey(value: string): string {
  return value
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

/**
 * The environment variable name a credential's key travels in.
 *
 * Derived from the provider id so it is stable across regenerations, and
 * suffixed with a hash so two ids that sanitise to the same string (`a-b` and
 * `a_b`) cannot collide and silently hand one provider the other's key.
 */
export function credentialEnvName(providerId: string): string {
  const readable = sanitizeForEnv(providerId).slice(0, 40)
  return `CINNA_ENGINE_KEY_${readable}_${shortHash(providerId).toUpperCase()}`
}

/**
 * The OpenCode agent key for a folder agent.
 *
 * **Always suffixed with a hash of the agent id, even when the slug is unique.**
 * The tempting alternative — bare slug when unique, suffixed on collision —
 * makes an existing agent's key depend on which *other* agents exist, so
 * creating a second `assistant` in another root would rename the first one's
 * entry. Phase 6 binds engine sessions to this key, so a key that moves is a
 * conversation that loses its agent. The user never types it.
 */
export function engineAgentKey(agentId: string, slug: string): string {
  const readable = sanitizeForKey(slug).slice(0, 40) || 'agent'
  return `${readable}-${shortHash(agentId)}`
}

/**
 * Build the config, the credential environment and the key maps.
 *
 * Pure: no filesystem, no clock, no `app`. Everything that decides what the
 * engine will do is visible in the return value, which is what makes "does a
 * key ever reach the config" a question a test can answer directly rather than
 * by reading.
 */
export function buildEngineConfig(input: EngineConfigInput): BuiltEngineConfig {
  const providers: Record<string, unknown> = {}
  const env: Record<string, string> = {}
  const providerKeys = new Map<string, string>()
  const skippedProviders: SkippedProvider[] = []
  /** Canonical keys already claimed, so the second `anthropic` gets its own. */
  const claimed = new Set<string>()

  // Deterministic order: the same set of credentials must always produce the
  // same config bytes, or "did the config change" — which decides whether the
  // engine restarts — would be answered by map iteration order.
  const sortedProviders = [...input.providers].sort((a, b) => a.id.localeCompare(b.id))

  for (const provider of sortedProviders) {
    // The empty-key skip is conditional on the type needing one at all. An
    // Ollama credential has no key by construction, and skipping it here — the
    // behaviour before this branch existed — is precisely how a local agent
    // pointed at a local model would have been dropped from the config with no
    // symptom other than an agent that does nothing when chatted with.
    if (provider.apiKey === '' && requiresApiKey(provider.type)) {
      skippedProviders.push({ providerId: provider.id, reason: 'no API key is stored for it' })
      continue
    }
    // Narrowed once, here, and every table below is keyed by the narrowed
    // type — so a credential type the engine has no entry shape for is a skip
    // with a reason, and a type added to `EngineProviderType` without a row in
    // one of those tables is a compile error rather than a silent default.
    const type = provider.type
    if (!isEngineProviderType(type)) {
      skippedProviders.push({
        providerId: provider.id,
        reason: `the local engine does not support provider type "${provider.type}"`
      })
      continue
    }
    const npm = PROVIDER_NPM[type]
    // The credential's own URL wins; a type with a fixed endpoint we know
    // (Gemini's OpenAI-compatible one, Ollama's `/v1`) falls back to that.
    const baseUrl = engineBaseUrl(type, provider.baseUrl)
    if (type === 'openai_compatible' && !baseUrl) {
      skippedProviders.push({
        providerId: provider.id,
        reason: 'an OpenAI-compatible credential needs a base URL'
      })
      continue
    }

    const canonical = CANONICAL_PROVIDER_KEY[type]
    const useCanonical = canonical !== undefined && !claimed.has(canonical)
    const key = useCanonical
      ? canonical
      : `${sanitizeForKey(canonical ?? type)}-${shortHash(provider.id)}`
    if (useCanonical) claimed.add(canonical)

    const envName = credentialEnvName(provider.id)
    // A keyless credential still names an environment variable, carrying a
    // placeholder rather than a key — it is not simply omitted, and the reason
    // is the engine's availability filter rather than tidiness.
    //
    // `provider.<key>.env = ["NAME"]` is what the `config-provider` plugin turns
    // into an integration with an `{type:"env"}` method, and `providerAvailable`
    // (de-minified in `opencode_contract.md` §9.5.4, and the filter behind
    // `model.available()`) answers **true** on the branch
    // `if integration?.connections.length`. That is the branch every working
    // entry in this config takes today, canonical and custom alike. An entry
    // with no `env` would have to fall through to the last branch instead —
    // `integrationID === undefined && !integration` — which is the one the
    // contract also records as transiently true for ~160ms before the
    // integration list populates. Emitting no `env` is therefore an unverified
    // path where emitting one is a verified path, for a value that is public by
    // construction.
    //
    // The credential travels as `Authorization: Bearer <value>` (§9.5.4), so
    // Ollama receives `Bearer keyless` and ignores it, exactly as it ignores
    // every other token. See KEYLESS_PLACEHOLDER_KEY.
    env[envName] = requiresApiKey(provider.type) ? provider.apiKey : KEYLESS_PLACEHOLDER_KEY

    // **`env`, not `options.apiKey`.** The engine's v2 config reader performs no
    // `{env:…}` substitution, so an `options.apiKey` of `"{env:NAME}"` is sent
    // to the provider verbatim and every request 401s. Naming the variable here
    // instead registers an integration whose connection the session runner
    // resolves out of the process environment — for a canonical key and for a
    // custom entry alike, which is what the desktop needs since it has to carry
    // a second credential of the same type.
    const entry: Record<string, unknown> = { env: [envName] }
    if (baseUrl) entry.options = { baseURL: baseUrl }
    if (!useCanonical) {
      // A custom key gets no models.dev catalog, so it has to declare both the
      // package that implements it and every model it can address.
      entry.npm = npm
      entry.name = provider.name
      // `limit` on every model, for the reason documented on
      // {@link CUSTOM_MODEL_LIMITS}: a custom entry gets no models.dev catalog,
      // the engine defaults the model to `{context: 0, output: 0}`, and the
      // Anthropic transport sends that zero as `max_tokens`.
      //
      // **No `tool_call` flag, and that is measured rather than assumed.** A
      // custom entry's models report `capabilities.tools: false` in
      // `GET /api/model` — ours is the only entry in a 32-model catalog that
      // does — and the obvious conclusion is that a folder agent on one gets no
      // tools. It is wrong. Verified 8 Sep 2026 against opencode 1.18.27 and a
      // real Ollama by putting a logging proxy between the two: with the flag
      // absent, the session runner still sent the agent's full set of **12
      // tools** in the request body. `capabilities.tools` is catalog metadata
      // here, not a gate on what a turn is given.
      //
      // So the flag is deliberately not emitted. Adding it would change nothing
      // for tool use, while asserting tool-calling about every model of every
      // custom entry — including small local models that genuinely cannot do it,
      // where the claim would turn a graceful degradation into a 400.
      const limit = CUSTOM_MODEL_LIMITS[type]
      entry.models = Object.fromEntries(
        [...provider.models]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((model) => [model.id, { name: model.name, limit: { ...limit } }])
      )
    }
    providers[key] = entry
    providerKeys.set(provider.id, key)
  }

  const agents: Record<string, unknown> = {}
  const agentKeys = new Map<string, string>()
  const agentModels = new Map<string, EngineModelRef>()
  const prompts = new Map<string, string>()
  const skippedAgents: SkippedAgent[] = []

  for (const agent of [...input.agents].sort((a, b) => a.agentId.localeCompare(b.agentId))) {
    const providerKey = providerKeys.get(agent.providerId)
    if (!providerKey) {
      skippedAgents.push({
        agentId: agent.agentId,
        code: 'credential_unavailable' as const
      })
      continue
    }
    if (!agent.modelId) {
      skippedAgents.push({ agentId: agent.agentId, code: 'no_model' as const })
      continue
    }
    const key = engineAgentKey(agent.agentId, agent.slug)
    agentKeys.set(agent.agentId, key)
    agentModels.set(agent.agentId, { providerID: providerKey, id: agent.modelId })
    prompts.set(key, agent.prompt)
    agents[key] = {
      description: agent.description || `The ${agent.slug} agent.`,
      mode: 'primary',
      model: `${providerKey}/${agent.modelId}`,
      // Inline, not `{file:./prompts/<key>.md}`: the v2 reader resolves no file
      // reference, and the placeholder itself is what the model receives as its
      // system prompt. See the header.
      prompt: agent.prompt,
      permission: mergePermissions(agent.permissions)
    }
  }

  return {
    config: {
      $schema: 'https://opencode.ai/config.json',
      provider: providers,
      agent: agents
    },
    env,
    providerKeys,
    agentKeys,
    agentModels,
    prompts,
    skippedProviders,
    skippedAgents
  }
}

/**
 * A fingerprint of everything one engine process loads, split in two.
 *
 * Two digests rather than one because the two halves reach the engine by
 * different routes and only one of them is safe to name in a log: `config` is
 * bytes on disk, `env` is live API keys. {@link engineManager} compares them
 * separately so it can say "credentials moved" without saying which, or what.
 */
export interface EngineConfigDigest {
  /** The generated config bytes **and** every prompt file written beside them. */
  config: string
  /** The credential environment — key names and key values. **Never logged.** */
  env: string
}

/**
 * Length-prefix a string so a concatenation cannot be forged.
 *
 * A prompt is the user's own `WORKFLOW_PROMPT.md`, so it is arbitrary text that
 * can contain any delimiter this function might otherwise pick. Prefixing each
 * piece with its length makes the encoding unambiguous: no rearrangement of
 * agent keys and prompt bodies can produce the same byte stream as a different
 * one.
 *
 * **This is not ceremony, and the direction of the failure is why.** A
 * delimiter collision here does not produce a spurious restart — it produces a
 * *false negative*: two genuinely different configs digesting to the same
 * value, so {@link engineManager.applyConfigChange} concludes nothing moved and
 * never restarts. The engine then keeps serving the previous prompt while the
 * app believes it is serving the new one, and **every test still passes**,
 * because a false negative is invisible to anything that is not looking for it.
 * That is the same shape as the two `isIgnoredPath` defects in
 * `src/main/kit/validator.ts` — both false negatives in a secret check, both
 * survivors of a green suite.
 *
 * The prompt bodies are the one input to this digest that is arbitrary
 * user-controlled text, which makes them the one place the collision is
 * reachable rather than theoretical. Length-prefixing costs a few bytes per
 * entry and removes the class. Do not "simplify" it back to a join.
 */
function framed(value: string): string {
  return `${value.length}:${value}`
}

/**
 * What this config *is*, for the "does the running engine still match" check.
 *
 * The two halves are the whole point, and they are separate because the change
 * each one sees is invisible to the other.
 *
 * **`config`** covers the serialised config object and the prompt files —
 * exactly the set {@link writeEngineConfig} puts on disk, because that is the
 * set the engine reads at load. Serialised the same way it is written, so the
 * digest moves when and only when the bytes would.
 *
 * **`env`** covers {@link BuiltEngineConfig.env} and nothing else: the map of
 * `CINNA_ENGINE_KEY_…` names to decrypted keys. This is the half that exists
 * because of Invariant 4 — a key is never written into the config, only an
 * `{env:…}` reference is, so **rotating a key leaves the config bytes byte for
 * byte identical**. A change-detector that looked only at the config would
 * conclude nothing had moved and never restart, leaving the engine serving a
 * key the user has already replaced: every turn 401s while the UI shows a valid
 * credential and a healthy engine.
 *
 * It digests `built.env` specifically, and not the environment the child is
 * actually spawned with. That environment (`engineEnv`) carries a fresh
 * `randomBytes(32)` password per spawn plus the whole login shell, so a digest
 * of it would differ from the running process's on every single comparison —
 * and since one `opencode serve` backs every folder agent, that would restart
 * the engine, and end every streaming turn, on every reconcile. `built.env` is
 * deterministic by construction: the names come from `credentialEnvName` and
 * the values are the stored keys.
 *
 * Entries are sorted here rather than trusting {@link buildEngineConfig}'s
 * provider sort to stay put — this is the input to a restart decision, and it
 * should not be one refactor upstream away from restarting on map order.
 */
export function digestEngineConfig(built: BuiltEngineConfig): EngineConfigDigest {
  const config = createHash('sha256')
  config.update(framed(`${JSON.stringify(built.config, null, 2)}\n`))
  for (const [key, text] of [...built.prompts].sort(([a], [b]) => a.localeCompare(b))) {
    config.update(framed(key))
    config.update(framed(text))
  }

  const env = createHash('sha256')
  for (const [name, value] of Object.entries(built.env).sort(([a], [b]) => a.localeCompare(b))) {
    env.update(framed(name))
    env.update(framed(value))
  }

  return { config: config.digest('hex'), env: env.digest('hex') }
}

/**
 * The conversation profile with a manifest's `runtime.permissions` merged over
 * it, one permission name at a time.
 *
 * A shallow merge on purpose. Deep-merging the pattern maps would let a
 * manifest add `"*": "allow"` *underneath* our `bash` rules and quietly widen
 * them; replacing the whole `bash` entry makes the override visible as an
 * override. The folder is the user's own, so this is not a trust boundary —
 * it is a legibility one.
 */
function mergePermissions(overrides?: Record<string, unknown> | null): Record<string, unknown> {
  if (!overrides || typeof overrides !== 'object') return { ...CONVERSATION_PERMISSIONS }
  return { ...CONVERSATION_PERMISSIONS, ...overrides }
}

export interface WrittenEngineConfig extends BuiltEngineConfig {
  configPath: string
  /** False when the bytes on disk already matched — nothing needs restarting. */
  changed: boolean
}

/**
 * Write the config and its prompt files into `dir`, atomically, and report
 * whether anything actually changed.
 *
 * `changed` is what makes "restart the engine when the config changes" cheap
 * enough to call on every rescan: a regeneration that produces identical bytes
 * leaves a running engine alone. The comparison covers the prompt files too,
 * because a reworded `WORKFLOW_PROMPT.md` changes what the agent *is* while
 * leaving the config identical.
 */
export function writeEngineConfig(dir: string, built: BuiltEngineConfig): WrittenEngineConfig {
  const configPath = join(dir, 'opencode.json')
  const promptDir = join(dir, 'prompts')
  mkdirSync(promptDir, { recursive: true })

  const serialised = `${JSON.stringify(built.config, null, 2)}\n`
  let changed = writeIfDifferent(configPath, serialised)
  for (const [key, text] of [...built.prompts].sort(([a], [b]) => a.localeCompare(b))) {
    if (writeIfDifferent(join(promptDir, `${key}.md`), text)) changed = true
  }
  if (pruneStalePrompts(promptDir, built.prompts)) changed = true

  if (changed) {
    // Names and counts only. The config object holds `{env:…}` references
    // rather than keys, but logging it wholesale would still be one refactor
    // away from logging a key, and the counts are the whole diagnostic value.
    logger.info('engine config regenerated', {
      providers: built.providerKeys.size,
      agents: built.agentKeys.size,
      skippedProviders: built.skippedProviders.length,
      skippedAgents: built.skippedAgents.length
    })
  }
  return { ...built, configPath, changed }
}

/**
 * Delete generated prompt files for agents that are no longer in the set.
 *
 * A prompt file is this app's own derived copy of the *user's* folder — their
 * `WORKFLOW_PROMPT.md`, their `scripts/README.md`, the topics they wrote — and
 * deleting an agent is the user saying they are done with it. "Nothing reads
 * the leftover" is not a good enough answer to that: the file keeps their
 * material on disk after they asked for it to go, and the directory grows one
 * file per agent ever created.
 *
 * Scoped hard, because this is the only place in the engine that deletes
 * anything. It only ever touches `<userData>/engine/prompts/`, only `.md` files
 * directly inside it, and never a directory — no agent folder is reachable from
 * here even if a key were somehow malformed. A file it cannot delete is
 * skipped, not thrown: a stale prompt is untidy, and failing the config write
 * over one would take the engine down for it.
 */
function pruneStalePrompts(promptDir: string, prompts: Map<string, string>): boolean {
  let removed = false
  let entries: string[]
  try {
    entries = readdirSync(promptDir)
  } catch {
    return false
  }
  for (const name of entries) {
    if (!name.endsWith('.md')) continue
    if (prompts.has(name.slice(0, -'.md'.length))) continue
    try {
      rmSync(join(promptDir, name), { force: true })
      removed = true
    } catch (err) {
      logger.warn('could not remove a stale engine prompt', { file: name, error: String(err) })
    }
  }
  return removed
}

/** True when the file was written; false when it already held these bytes. */
function writeIfDifferent(path: string, contents: string): boolean {
  try {
    if (readFileSync(path, 'utf8') === contents) return false
  } catch {
    /* missing or unreadable — write it */
  }
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temp, contents, { mode: 0o600 })
    renameSync(temp, path)
  } catch (err) {
    rmSync(temp, { force: true })
    throw err
  }
  return true
}
