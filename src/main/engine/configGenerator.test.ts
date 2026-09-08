import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildEngineConfig,
  CONVERSATION_PERMISSIONS,
  credentialEnvName,
  engineAgentKey,
  writeEngineConfig,
  type EngineConfigInput
} from './configGenerator'

/**
 * The engine config, and the one rule it exists to hold: **a key never appears
 * in it.**
 *
 * Every assertion below was mutation-checked — the code it covers was broken on
 * purpose and the test was confirmed to fail.
 *
 * That sentence was **not** true when it was first written: a re-check found
 * `options.baseURL` — the whole of where an OpenAI-compatible gateway's
 * requests go — asserted by nothing, so deleting the line that emits it left
 * the file green. It is covered now. The lesson is kept here rather than tidied
 * away, because the claim is only worth anything if someone re-measures it.
 *
 * Two assertions caught something the obvious weaker version would not have:
 *
 * - `expect(json).not.toContain(KEY)` on the whole serialised config, rather
 *   than `expect(config.provider.anthropic.options.apiKey).toBe('{env:…}')`.
 *   The narrow version passes while a key sits in a *different* field — a
 *   `name`, a custom provider's `baseURL`, a future key we add — which is
 *   exactly how this kind of leak happens.
 * - byte-equality across two builds, rather than "the same providers appear".
 *   The bytes are what `writeEngineConfig` compares to decide whether to
 *   restart a running engine, so a build that is *equivalent* but not
 *   *identical* silently kills a live conversation on every rescan.
 */

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const ANTHROPIC_KEY = 'sk-ant-api03-THIS-IS-THE-SECRET'
const OPENAI_KEY = 'sk-proj-ANOTHER-SECRET'

function input(overrides: Partial<EngineConfigInput> = {}): EngineConfigInput {
  return {
    providers: [
      {
        id: 'prov-anthropic',
        type: 'anthropic',
        name: 'Anthropic',
        apiKey: ANTHROPIC_KEY,
        baseUrl: null,
        models: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }]
      }
    ],
    agents: [
      {
        agentId: 'folder:11111111-1111-1111-1111-111111111111',
        slug: 'invoices',
        description: 'Reads invoices.',
        prompt: '# Invoices\n\nYou are the invoice agent.\n',
        providerId: 'prov-anthropic',
        modelId: 'claude-sonnet-4-5',
        permissions: null
      }
    ],
    ...overrides
  }
}

describe('buildEngineConfig', () => {
  it('names the key’s environment variable in the config and puts the key only in the environment', () => {
    const built = buildEngineConfig(input())
    const serialised = JSON.stringify(built.config)

    expect(serialised).not.toContain(ANTHROPIC_KEY)
    // **`env: [NAME]`, not `options.apiKey: "{env:NAME}"`.** The engine's v2
    // config reader substitutes nothing, so the placeholder form is sent to the
    // provider as the key itself and every request 401s; the `env` form makes
    // the variable an integration connection the session runner resolves.
    // Mutation: put the key back behind `options.apiKey` → this fails.
    expect(
      (built.config.provider as Record<string, Record<string, unknown>>).anthropic.env
    ).toEqual([credentialEnvName('prov-anthropic')])
    expect(serialised).not.toContain('{env:')
    expect(built.env[credentialEnvName('prov-anthropic')]).toBe(ANTHROPIC_KEY)
  })

  it('keeps every key out of the config even with several credentials of mixed type', () => {
    const built = buildEngineConfig(
      input({
        providers: [
          {
            id: 'a',
            type: 'anthropic',
            name: 'Anthropic',
            apiKey: ANTHROPIC_KEY,
            baseUrl: null,
            models: []
          },
          {
            id: 'b',
            type: 'openai',
            name: 'OpenAI',
            apiKey: OPENAI_KEY,
            baseUrl: null,
            models: []
          },
          {
            id: 'c',
            type: 'openai_compatible',
            name: 'Gateway',
            apiKey: 'gw-secret-value',
            baseUrl: 'https://gw.example.com/v1',
            models: [{ id: 'gpt-4o', name: 'GPT-4o' }]
          }
        ],
        agents: []
      })
    )
    const serialised = JSON.stringify(built.config)
    for (const secret of [ANTHROPIC_KEY, OPENAI_KEY, 'gw-secret-value']) {
      expect(serialised).not.toContain(secret)
    }
    expect(Object.values(built.env).sort()).toEqual(
      [ANTHROPIC_KEY, OPENAI_KEY, 'gw-secret-value'].sort()
    )
  })

  it('gives an OpenAI-compatible gateway a custom entry carrying its baseURL', () => {
    // The gateway is the one provider type that cannot work without this: it
    // has no canonical models.dev key, so `npm`, `name`, `models` and above all
    // `baseURL` are the entire definition of where the requests go. Dropping
    // the `baseURL` line sends every call to the default OpenAI endpoint with
    // the gateway's key attached — a failure that looks like a bad key.
    const built = buildEngineConfig(
      input({
        providers: [
          {
            id: 'gw',
            type: 'openai_compatible',
            name: 'Gateway',
            apiKey: 'gw-secret-value',
            baseUrl: 'https://gw.example.com/v1',
            models: [{ id: 'gpt-4o', name: 'GPT-4o' }]
          }
        ],
        agents: []
      })
    )
    const key = built.providerKeys.get('gw') as string
    const entry = (built.config.provider as Record<string, Record<string, unknown>>)[key]
    expect((entry.options as Record<string, unknown>).baseURL).toBe('https://gw.example.com/v1')
    expect(entry.env).toEqual([credentialEnvName('gw')])
    expect(Object.hasOwn(entry.options as object, 'apiKey')).toBe(false)
    // Per **provider type**, not one number for everything: the ceiling that is
    // valid for Anthropic is not valid for a gateway.
    expect(entry.models).toEqual({
      'gpt-4o': { name: 'GPT-4o', limit: { context: 128_000, output: 8_192 } }
    })
    expect(entry.npm).toBe('@ai-sdk/openai-compatible')
    expect(JSON.stringify(built.config)).not.toContain('gw-secret-value')
  })

  it('leaves a canonical entry’s models to models.dev, limits included', () => {
    // The other half of the rule, and the one that keeps the table above from
    // spreading. A canonical key *is* a models.dev key, so the engine already
    // has every model with its real context and output windows — emitting our
    // floors over the top would replace true numbers with approximate ones, and
    // a `models` map on a canonical entry would also narrow it to just the
    // models this desktop happens to list.
    const built = buildEngineConfig(input({ agents: [] }))
    const entry = (built.config.provider as Record<string, Record<string, unknown>>).anthropic
    expect(Object.hasOwn(entry, 'models')).toBe(false)
    expect(JSON.stringify(entry)).not.toContain('limit')
  })

  it('does not put an options block on a canonical provider that has no baseURL', () => {
    // `options` exists only to carry a gateway's `baseURL`. An empty one is not
    // merely untidy: the engine's v1→v2 config migration only builds a
    // `request` block for an entry that *has* options, so an empty object is a
    // shape the engine reads differently from no object at all.
    const built = buildEngineConfig(input({ agents: [] }))
    const entry = (built.config.provider as Record<string, Record<string, unknown>>).anthropic
    expect(Object.hasOwn(entry, 'options')).toBe(false)
  })

  it('routes gemini through Google’s OpenAI-compatible endpoint, not the `google` key', () => {
    // **This is a fix for a hang, not a preference.** OpenCode's canonical
    // `google` key catalogues the Gemini models under `@ai-sdk/google`, and
    // `SessionRunnerModel` can build a model from only three packages — none of
    // them that one. The models were listed, they were *available*, and the
    // turn then died with `UnsupportedApiError`, which reaches no event at all:
    // twenty minutes of nothing on screen.
    //
    // Mutation: put `gemini: 'google'` back in `CANONICAL_PROVIDER_KEY` → this
    // fails, and the live symptom returns.
    const built = buildEngineConfig(
      input({
        providers: [
          {
            id: 'g',
            type: 'gemini',
            name: 'Gemini',
            apiKey: 'k',
            baseUrl: null,
            models: [{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' }]
          }
        ],
        agents: []
      })
    )
    const key = built.providerKeys.get('g') as string
    expect(key).not.toBe('google')
    expect(Object.keys(built.config.provider as object)).toEqual([key])

    const entry = (built.config.provider as Record<string, Record<string, unknown>>)[key]
    expect(entry.npm).toBe('@ai-sdk/openai-compatible')
    expect((entry.options as Record<string, unknown>).baseURL).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai'
    )
    // Bare model ids, the way Google's compatible endpoint names them — the
    // adapter already strips the `models/` prefix its REST API returns.
    expect(entry.models).toEqual({
      'gemini-2.5-flash': {
        name: 'Gemini 2.5 Flash',
        limit: { context: 1_048_576, output: 65_536 }
      }
    })
  })

  it('gives a second credential of the same type its own key, with npm and models', () => {
    const twoAnthropics = [
      {
        id: 'aaa-first',
        type: 'anthropic',
        name: 'Personal',
        apiKey: 'k1',
        baseUrl: null,
        models: []
      },
      {
        id: 'bbb-second',
        type: 'anthropic',
        name: 'Work',
        apiKey: 'k2',
        baseUrl: null,
        models: [{ id: 'claude-sonnet-4-5', name: 'Sonnet' }]
      }
    ]
    const built = buildEngineConfig(input({ providers: twoAnthropics, agents: [] }))

    expect(built.providerKeys.get('aaa-first')).toBe('anthropic')
    const second = built.providerKeys.get('bbb-second') as string
    expect(second).not.toBe('anthropic')
    const entry = (built.config.provider as Record<string, Record<string, unknown>>)[second]
    expect(entry.npm).toBe('@ai-sdk/anthropic')
    // **`limit` on the model, and this is the assertion the live bug needed.**
    // A custom entry gets no models.dev catalog, and the engine defaults a
    // model's limit to `{context: 0, output: 0}` — which the Anthropic
    // transport sends as `max_tokens: 0`, and the provider rejects with
    // `400 "stream cannot be true when max_tokens is 0"`. Watched at a probe
    // server: without this the body carried `"max_tokens": 0`; with it, 32000.
    // Mutation: drop `limit` from the emitted model → this fails.
    expect(entry.models).toEqual({
      'claude-sonnet-4-5': { name: 'Sonnet', limit: { context: 200_000, output: 32_000 } }
    })

    // The same assignment **whichever order the rows arrive in**. Without a
    // deterministic sort the two fight over the canonical `anthropic` key and
    // the winner depends on row order — so an agent bound to `anthropic/…`
    // silently changes credential when an unrelated one is added.
    const reversed = buildEngineConfig(
      input({ providers: [...twoAnthropics].reverse(), agents: [] })
    )
    expect(reversed.providerKeys.get('aaa-first')).toBe('anthropic')
    expect(reversed.providerKeys.get('bbb-second')).toBe(second)
  })

  it('points an agent at its provider key and its own prompt file', () => {
    const built = buildEngineConfig(input())
    const agentId = 'folder:11111111-1111-1111-1111-111111111111'
    const key = built.agentKeys.get(agentId) as string
    expect(key).toBe(engineAgentKey(agentId, 'invoices'))
    const entry = (built.config.agent as Record<string, Record<string, unknown>>)[key]
    expect(entry.model).toBe('anthropic/claude-sonnet-4-5')
    // **The prompt text, not a `{file:…}` reference to it.** The engine's v2
    // config reader resolves no file references: watched at a probe server the
    // engine was pointed at, the literal `{file:./prompts/<key>.md}` arrived as
    // the system prompt while the file's own text never did. Mutation: emit
    // `{file:./prompts/<key>.md}` → fails.
    expect(entry.prompt).toContain('You are the invoice agent.')
    expect(entry.prompt).not.toContain('{file:')
    expect(built.prompts.get(key)).toContain('You are the invoice agent.')

    // **The same pair again, split.** The config file spells a model
    // `"<provider>/<id>"`, but the session API takes `{providerID, id}` and the
    // engine's v2 runner reads the model from the *session* only — never from
    // the agent entry — so the runner needs the split form of exactly the model
    // this entry names. Deriving it by splitting the string at the runner would
    // be wrong for a model id containing a slash, which `openrouter`-style ids
    // routinely do.
    expect(built.agentModels.get(agentId)).toEqual({
      providerID: 'anthropic',
      id: 'claude-sonnet-4-5'
    })
  })

  it('carries the conversation permission profile, catch-all included', () => {
    const built = buildEngineConfig(input())
    const key = built.agentKeys.get('folder:11111111-1111-1111-1111-111111111111') as string
    const permission = (built.config.agent as Record<string, Record<string, unknown>>)[key]
      .permission as Record<string, unknown>
    // The catch-all is the one that matters: OpenCode's own base rule allows
    // every permission, so a profile that only lists read/edit/write/bash
    // leaves every other tool wide open.
    expect(permission['*']).toBe('ask')
    // **Free inside the folder.** A session's directory *is* the agent folder,
    // so these are the permissions that make ordinary work — writing the script
    // it was just asked to write, running it — happen without a dialog per
    // step. The profile that gated them behind `app-data/**` and three command
    // shapes asked about nearly everything, and a prompt that fires constantly
    // is not a control.
    expect(permission.bash).toMatchObject({ '*': 'allow' })
    expect(permission.edit).toMatchObject({ '*': 'allow' })
    expect(permission.write).toMatchObject({ '*': 'allow' })
    // And the four things the folder boundary does not cover. Each is a
    // separate mutation: flip any one to `allow` and the folder stops being a
    // boundary.
    expect(permission.external_directory).toBe('ask')
    expect(permission.webfetch).toBe('ask')
    expect((permission.edit as Record<string, string>)['docs/WORKFLOW_PROMPT.md']).toBe('ask')
    expect((permission.bash as Record<string, string>)['sudo *']).toBe('ask')
    // Secrets are denied to *writes* as well as reads now that the folder is
    // writable: `'*': 'allow'` without these would have made `credentials/.env`
    // editable by the agent, which is a regression the widening could easily
    // have shipped silently.
    expect((permission.read as Record<string, string>)['credentials/.env']).toBe('deny')
    // **`*.env`, never `**​/.env`.** The engine's matcher is not a glob: it
    // escapes the pattern, turns `*` into `.*` and anchors it, so `**​/.env`
    // compiles to something that *requires a slash* and never matches a `.env`
    // at the agent-folder root — where the resource is the literal string
    // `.env`. A missed pattern here fails open, silently, which is exactly how
    // the previous spelling let an agent write a root-level `.env` under the
    // widened profile.
    for (const name of ['read', 'edit', 'write']) {
      const entry = permission[name] as Record<string, string>
      expect(Object.keys(entry).some((pattern) => pattern.includes('**'))).toBe(false)
      expect(entry['*.env']).toBe('deny')
      expect(entry['*.pem']).toBe('deny')
      expect(entry['*.key']).toBe('deny')
    }
    expect((permission.write as Record<string, string>)['credentials/.env']).toBe('deny')
    expect((permission.edit as Record<string, string>)['*.env']).toBe('deny')
  })

  it('resolves the way the engine does, for the resources that matter', () => {
    // **A simulation of the engine's own algorithm, not of a glob.** Both halves
    // were read out of the pinned 1.18.27 binary and are recorded in
    // `opencode_contract.md`:
    //
    // - `Wildcard.match` regex-escapes the pattern, then `*` → `.*` and `?` →
    //   `.`, anchors it, and rewrites a trailing `" .*"` as `"( .*)?"`. So `*`
    //   crosses `/` and **there is no `**`** — `**​/.env` requires a slash and
    //   misses a `.env` at the folder root.
    // - `evaluate` is `findLast`: the **last** matching rule wins, not the most
    //   specific one.
    //
    // Every rule in the profile depends on both, and a pattern that stops
    // matching fails **open** — the `'*'` above it decides and nothing is
    // logged. That is exactly how `**​/.env` let an agent write a root-level
    // `.env` under the widened profile while 1437 tests stayed green, so the
    // algorithm is pinned here rather than left as a comment.
    // `\\` → `/` normalisation is the one step of the binary's not modelled here:
    // it runs *before* the escape, so a backslash can never reach the escape
    // class there while it would be escaped here. Nothing in this profile
    // contains one, and adding the step would only make the divergence harder
    // to see than a sentence does.
    const compile = (pattern: string): RegExp =>
      new RegExp(
        `^${pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          // `?` is not in the escape class, so without this step a future
          // pattern like `key?.pem` would reach `RegExp` with a bare `?` and
          // silently become a quantifier — or throw, if one ever began with it.
          .replace(/\?/g, '.')
          // The trailing-space rule, and it takes the space with it: `rm -rf *`
          // compiles to `^rm -rf( .*)?$`, which is why the bare `rm -rf` and
          // `rm -rf build` both match — and why `rm -r *` does *not* match
          // `rm -rf build`, so both spellings have to be listed. A pattern
          // ending in a literal `foo.*` is not rewritten, because there is no
          // space, and the binary behaves the same way.
          .replace(/ \.\*$/, '( .*)?')}$`,
        // **The `s` flag is load-bearing, not tidiness.** A heredoc is a single
        // `redirected_statement` whose text spans lines, so the matcher is
        // handed a multi-line string; without `s`, `.*` would not cross the
        // newline and `cat > credentials/.env <<'EOF' …` — the most natural way
        // for a model to write a key file — would slip through every rule below.
        's'
      )
    // Models **one entry** of our profile, not the merged `[...base, ...ours]`
    // list the engine evaluates. Every row below was checked both ways and is
    // identical — but the interaction this cannot see is the subtle one: our
    // `read: {'*': 'allow'}` lands after OpenCode's own base `read:
    // {'*.env': 'ask'}` and switches it off, which is why `SECRET_FILES` is the
    // only defence left and why it is asserted so heavily.
    const winner = (name: string, resource: string): [string, string] | undefined => {
      const entry = CONVERSATION_PERMISSIONS[name]
      if (typeof entry === 'string') return ['*', entry]
      const rules = Object.entries(entry as Record<string, string>)
      return [...rules].reverse().find(([pattern]) => compile(pattern).test(resource))
    }
    // The engine's fallback when nothing matches is `ask`, so `resolve` alone
    // cannot tell "a rule asked" from "no rule matched at all" — which is how
    // the heredoc row below passed even with the `s` flag removed. Where that
    // distinction is the point, assert the pattern that won.
    const resolve = (name: string, resource: string): string => winner(name, resource)?.[1] ?? 'ask'
    const matched = (name: string, resource: string): string | null =>
      winner(name, resource)?.[0] ?? null

    // Secrets, at the root as well as nested — the case `**​/.env` missed.
    expect(resolve('read', '.env')).toBe('deny')
    expect(resolve('edit', '.env')).toBe('deny')
    expect(resolve('write', 'deep/nested/.env')).toBe('deny')
    expect(resolve('read', 'credentials/.env')).toBe('deny')
    expect(resolve('read', 'key.pem')).toBe('deny')
    // Ordinary work inside the folder, which is the whole point of the change.
    expect(resolve('edit', 'scripts/report.py')).toBe('allow')
    expect(resolve('read', 'docs/CLI_COMMANDS.yaml')).toBe('allow')
    // The agent's own identity — both shapes. `AGENT.md` is a **bare** agent's
    // whole system prompt, so leaving it out let the one kind of agent whose
    // identity is a single file rewrite that file with no dialog, while the
    // profile above claimed identity files ask.
    expect(resolve('edit', 'cinna-agent.json')).toBe('ask')
    expect(resolve('edit', 'docs/WORKFLOW_PROMPT.md')).toBe('ask')
    expect(resolve('edit', 'AGENT.md')).toBe('ask')
    expect(resolve('write', 'AGENT.md')).toBe('ask')

    // The shell, where the matched string is the **command text** of each
    // command node, redirection included. The narrow shapes only fire because
    // they sit *after* `'*': 'allow'` in the object — `findLast`, not
    // most-specific. Mutation: move `'*'` to the end of the `bash` entry and
    // every one of these becomes `allow`.
    expect(resolve('bash', 'uv run scripts/report.py')).toBe('allow')
    expect(resolve('bash', 'make test')).toBe('allow')
    expect(resolve('bash', 'cat credentials/.env')).toBe('ask')
    expect(resolve('bash', "printf 'K=v' >> credentials/.env")).toBe('ask')
    expect(resolve('bash', 'cat .env.local')).toBe('ask')
    // A heredoc, which is one command node whose text spans lines — the most
    // natural way for a model to write a key file. Asserted by *which rule
    // won*, not by the outcome: `ask` is also what an unmatched resource falls
    // back to, so dropping the `s` flag would leave an outcome assertion green
    // while the guard had stopped matching entirely.
    const heredoc = "cat > credentials/.env <<'EOF'\nKEY=1\nEOF"
    expect(matched('bash', heredoc)).toBe('*credentials/.env*')
    expect(resolve('bash', heredoc)).toBe('ask')
    expect(resolve('bash', 'sudo rm -rf /')).toBe('ask')
    expect(resolve('bash', 'rm -rf build')).toBe('ask')
    // And the two false positives the narrow spelling exists to avoid: the kit
    // ships `credentials/README.md` and expects the agent to read it, and a
    // prompt on that would teach the user to click through these.
    expect(resolve('bash', 'cat credentials/README.md')).toBe('allow')
    expect(resolve('bash', 'python scripts/setup_credentials.py')).toBe('allow')
  })

  it('lets a manifest override one permission name without merging into it', () => {
    const built = buildEngineConfig(
      input({
        agents: [
          {
            ...input().agents[0],
            // An **object** override, not a string. A string override is
            // replaced by a deep merge too, so testing with `bash: 'deny'`
            // would pass against either rule and prove nothing.
            permissions: { bash: { '*': 'allow' } }
          }
        ]
      })
    )
    const key = built.agentKeys.get('folder:11111111-1111-1111-1111-111111111111') as string
    const permission = (built.config.agent as Record<string, Record<string, unknown>>)[key]
      .permission as Record<string, unknown>
    // Replaced wholesale, not deep-merged: a deep merge would let a manifest
    // add `"*": "allow"` *under* our bash rules and quietly widen them.
    expect(permission.bash).toEqual({ '*': 'allow' })
    expect(permission.edit).toMatchObject({ 'credentials/.env': 'deny' })
  })

  it('skips a credential the engine cannot use, and says which and why', () => {
    const built = buildEngineConfig(
      input({
        providers: [
          {
            id: 'no-key',
            type: 'anthropic',
            name: 'Empty',
            apiKey: '',
            baseUrl: null,
            models: []
          },
          {
            id: 'no-base-url',
            type: 'openai_compatible',
            name: 'Gateway',
            apiKey: 'k',
            baseUrl: null,
            models: []
          },
          {
            id: 'unknown-type',
            type: 'mystery',
            name: 'Mystery',
            apiKey: 'k',
            baseUrl: null,
            models: []
          }
        ],
        agents: []
      })
    )
    expect(built.skippedProviders.map((skip) => skip.providerId).sort()).toEqual([
      'no-base-url',
      'no-key',
      'unknown-type'
    ])
    expect(built.config.provider).toEqual({})
    expect(built.env).toEqual({})
  })

  /**
   * Ollama: the credential with no credential.
   *
   * The generator used to drop any provider whose `apiKey` was empty, which is
   * every Ollama credential there will ever be — and the symptom was not an
   * error anywhere. The provider was absent, so every agent on it was skipped
   * with `credential_unavailable`, so the agent simply did nothing when chatted
   * with. These assertions are what stop that returning.
   */
  describe('a keyless credential', () => {
    const ollama = {
      id: 'prov-ollama',
      type: 'ollama',
      name: 'Ollama',
      apiKey: '',
      baseUrl: 'http://127.0.0.1:11434',
      models: [{ id: 'qwen3:8b', name: 'qwen3:8b' }]
    }

    function ollamaEntry(baseUrl: string | null = 'http://127.0.0.1:11434') {
      const built = buildEngineConfig(
        input({
          providers: [{ ...ollama, baseUrl }],
          agents: [
            {
              agentId: 'folder:22222222-2222-2222-2222-222222222222',
              slug: 'local',
              description: 'Runs locally.',
              prompt: 'You are local.',
              providerId: 'prov-ollama',
              modelId: 'qwen3:8b',
              permissions: null
            }
          ]
        })
      )
      const key = built.providerKeys.get('prov-ollama')
      const providers = built.config.provider as Record<string, Record<string, unknown>>
      return { built, key, entry: key ? providers[key] : undefined }
    }

    it('is emitted rather than skipped, despite having no API key', () => {
      const { built, key, entry } = ollamaEntry()
      expect(built.skippedProviders).toEqual([])
      expect(key).toBeDefined()
      expect(entry).toBeDefined()
      expect(entry).toMatchObject({ npm: '@ai-sdk/openai-compatible', name: 'Ollama' })
    })

    it('points the entry at the OpenAI-compatible path, with exactly one /v1', () => {
      const { entry } = ollamaEntry()
      expect((entry as { options: { baseURL: string } }).options.baseURL).toBe(
        'http://127.0.0.1:11434/v1'
      )
    })

    it('falls back to the default host when the credential names none', () => {
      const { entry } = ollamaEntry(null)
      expect((entry as { options: { baseURL: string } }).options.baseURL).toBe(
        'http://127.0.0.1:11434/v1'
      )
    })

    it('names an env var carrying a placeholder, not an empty string', () => {
      const { built } = ollamaEntry()
      const envName = credentialEnvName('prov-ollama')
      expect(built.env[envName]).toBe('keyless')
      const { entry } = ollamaEntry()
      expect((entry as { env: string[] }).env).toEqual([envName])
    })

    it('declares its models with a limit, so max_tokens is never zero', () => {
      const { entry } = ollamaEntry()
      const models = (entry as { models: Record<string, { limit: { output: number } }> }).models
      expect(Object.keys(models)).toEqual(['qwen3:8b'])
      expect(models['qwen3:8b'].limit.output).toBeGreaterThan(0)
    })

    it('lets an agent on it resolve to a real model reference', () => {
      const { built, key } = ollamaEntry()
      const agentId = 'folder:22222222-2222-2222-2222-222222222222'
      expect(built.skippedAgents).toEqual([])
      expect(built.agentModels.get(agentId)).toEqual({ providerID: key, id: 'qwen3:8b' })
    })

    it('still skips a keyed provider whose key is empty', () => {
      const built = buildEngineConfig(
        input({
          providers: [
            { ...ollama, baseUrl: 'http://127.0.0.1:11434' },
            {
              id: 'no-key',
              type: 'anthropic',
              name: 'Empty',
              apiKey: '',
              baseUrl: null,
              models: []
            }
          ],
          agents: []
        })
      )
      expect(built.skippedProviders.map((skip) => skip.providerId)).toEqual(['no-key'])
      expect(built.providerKeys.has('prov-ollama')).toBe(true)
    })
  })

  it('skips an agent whose runtime does not resolve rather than emitting a broken entry', () => {
    const built = buildEngineConfig(
      input({
        agents: [
          { ...input().agents[0], providerId: 'gone' },
          {
            ...input().agents[0],
            agentId: 'folder:22222222-2222-2222-2222-222222222222',
            modelId: ''
          }
        ]
      })
    )
    expect(built.config.agent).toEqual({})
    expect(built.skippedAgents).toHaveLength(2)
    expect(built.skippedAgents[0].code).toBe('credential_unavailable')
    expect(built.skippedAgents[1].code).toBe('no_model')
  })

  it('produces byte-identical output for the same input in a different order', () => {
    const providers = [
      ...input().providers,
      {
        id: 'zzz-openai',
        type: 'openai',
        name: 'OpenAI',
        apiKey: OPENAI_KEY,
        baseUrl: null,
        models: []
      },
      // A second anthropic, sorting *after* `prov-anthropic` so it is the one
      // that gets a **custom** entry — the only entry shape carrying an
      // explicit model map, built from an array whose order this app does not
      // control.
      {
        id: 'qqq-anthropic',
        type: 'anthropic',
        name: 'Work',
        apiKey: 'k2',
        baseUrl: null,
        models: [
          { id: 'claude-opus-4-1', name: 'Opus' },
          { id: 'claude-sonnet-4-5', name: 'Sonnet' }
        ]
      }
    ]
    const agents = [
      input().agents[0],
      {
        ...input().agents[0],
        agentId: 'folder:00000000-0000-0000-0000-000000000000',
        slug: 'other'
      }
    ]
    const a = buildEngineConfig({ providers, agents })
    // Both lists reversed. Reversing only the agents would pass even with the
    // provider ordering left to chance, which is the half that decides which
    // credential wins the canonical `anthropic` key.
    const b = buildEngineConfig({
      providers: [...providers]
        .reverse()
        .map((provider) => ({ ...provider, models: [...provider.models].reverse() })),
      agents: [...agents].reverse()
    })
    // Byte-equality, not deep-equality of a normalised view: these bytes are
    // what decides whether a running engine gets restarted.
    expect(JSON.stringify(b.config)).toBe(JSON.stringify(a.config))
  })

  it('keeps an agent key stable when a same-slug sibling appears in another root', () => {
    const first = engineAgentKey('folder:aaa', 'assistant')
    const withSibling = engineAgentKey('folder:aaa', 'assistant')
    expect(withSibling).toBe(first)
    expect(engineAgentKey('folder:bbb', 'assistant')).not.toBe(first)
  })

  it('does not let two provider ids that sanitise alike share an env name', () => {
    expect(credentialEnvName('a-b')).not.toBe(credentialEnvName('a_b'))
  })
})

describe('writeEngineConfig', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cinna-engine-config-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes the config and one prompt file per agent', () => {
    const built = buildEngineConfig(input())
    const written = writeEngineConfig(dir, built)
    expect(written.changed).toBe(true)
    const key = built.agentKeys.get('folder:11111111-1111-1111-1111-111111111111') as string
    expect(readFileSync(join(dir, 'prompts', `${key}.md`), 'utf8')).toContain('invoice agent')
    expect(readFileSync(written.configPath, 'utf8')).not.toContain(ANTHROPIC_KEY)
  })

  it('reports no change when nothing moved', () => {
    writeEngineConfig(dir, buildEngineConfig(input()))
    expect(writeEngineConfig(dir, buildEngineConfig(input())).changed).toBe(false)
  })

  it('reports a change when only a prompt was reworded', () => {
    writeEngineConfig(dir, buildEngineConfig(input()))
    const reworded = buildEngineConfig(
      input({ agents: [{ ...input().agents[0], prompt: 'Completely different instructions.' }] })
    )
    // The config JSON is byte-identical here — same model, same file reference
    // — so a `changed` computed from the config alone would answer false and a
    // rewritten WORKFLOW_PROMPT.md would never reach a running engine.
    expect(writeEngineConfig(dir, reworded).changed).toBe(true)
  })

  it('removes the prompt file of an agent that is no longer there', () => {
    const built = writeEngineConfig(dir, buildEngineConfig(input()))
    const key = [...built.prompts.keys()][0]
    expect(existsSync(join(dir, 'prompts', `${key}.md`))).toBe(true)

    // The agent is deleted. Its generated prompt is this app's own copy of the
    // user's folder content — their workflow prompt, their knowledge topics —
    // and deleting the agent is the user asking for it to go.
    const after = writeEngineConfig(dir, buildEngineConfig(input({ agents: [] })))
    expect(existsSync(join(dir, 'prompts', `${key}.md`))).toBe(false)
    expect(after.changed).toBe(true)
  })

  it('keeps the prompts of agents that are still there, and anything that is not a prompt', () => {
    // The delete has to be narrow: it runs in a directory this app owns, but a
    // rule of "remove what I did not just write" that reached one level wider
    // would be reaching into the user's own files.
    writeEngineConfig(dir, buildEngineConfig(input()))
    writeFileSync(join(dir, 'prompts', 'notes.txt'), 'not ours')
    mkdirSync(join(dir, 'prompts', 'a-directory'), { recursive: true })

    const built = writeEngineConfig(dir, buildEngineConfig(input()))
    const key = [...built.prompts.keys()][0]
    expect(existsSync(join(dir, 'prompts', `${key}.md`))).toBe(true)
    expect(existsSync(join(dir, 'prompts', 'notes.txt'))).toBe(true)
    expect(existsSync(join(dir, 'prompts', 'a-directory'))).toBe(true)
    // Nothing moved, so nothing restarts.
    expect(built.changed).toBe(false)
  })

  it('cleans up its temp file and fails loudly when the rename cannot happen', () => {
    // The failure branch of the atomic write, which nothing reached before.
    // Making the destination a non-empty **directory** is the one way to make
    // `renameSync` fail without mocking `fs`: the temp file writes fine and the
    // rename is refused, which is exactly the shape of a real failure (a full
    // disk, a permissions change) arriving at the same point.
    const configPath = join(dir, 'opencode.json')
    mkdirSync(configPath, { recursive: true })
    writeFileSync(join(configPath, 'occupied'), 'x')

    expect(() => writeEngineConfig(dir, buildEngineConfig(input()))).toThrow()

    // Two things, and the second is the one that matters. A write that throws
    // must not leave a `.tmp` behind — the directory is scanned by nothing
    // today, but a half-written config accumulating next to the real one is how
    // a later "clean up stale files" change deletes the wrong thing. And the
    // error must propagate: swallowing it would report a config as written
    // while the engine loads the previous one forever.
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(existsSync(configPath)).toBe(true)
  })

  it('replaces the config file rather than writing through it', () => {
    // The property that makes the temp-and-rename worth having, expressed as
    // something a test can actually observe: the existing file is *replaced*,
    // never opened for writing. A read-only config proves it — `renameSync`
    // succeeds because the permission that matters is the directory's, while a
    // direct `writeFileSync` to the same path fails with EACCES.
    //
    // This is the closest reachable proxy for atomicity. It rules out the
    // write-through implementation, which is the one that can leave a
    // half-written config on disk for the engine to load.
    const written = writeEngineConfig(dir, buildEngineConfig(input()))
    chmodSync(written.configPath, 0o444)

    const reworded = buildEngineConfig(
      input({ agents: [{ ...input().agents[0], slug: 'renamed' }] })
    )
    expect(() => writeEngineConfig(dir, reworded)).not.toThrow()
    expect(readFileSync(written.configPath, 'utf8')).toContain('renamed')

    chmodSync(written.configPath, 0o600)
  })

  /**
   * Known gap, narrowed rather than removed: what is still untested is the
   * *interrupted* case — a writer killed between `writeFileSync` and
   * `renameSync` must leave the previous config intact. The error branch above
   * covers a rename that refuses; a process that dies mid-write needs a crash,
   * not a mock. The property is why the temp-and-rename exists at all, so it is
   * worth knowing it rests on `renameSync` being atomic on the platform rather
   * than on anything this suite proves.
   */
  it('reports a change when the file on disk was edited by hand', () => {
    const written = writeEngineConfig(dir, buildEngineConfig(input()))
    writeFileSync(written.configPath, '{"tampered":true}\n')
    expect(writeEngineConfig(dir, buildEngineConfig(input())).changed).toBe(true)
  })
})
