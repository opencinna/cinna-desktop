import { describe, expect, it } from 'vitest'
import {
  bestInTier,
  classifyModel,
  sameFamilyFallback,
  type CatalogueModel,
  type WorkComplexity
} from './modelFamilies'

/**
 * The classifier is the whole feature: a tier is only as good as the id it picks,
 * and a wrong pick is a config that saves cleanly and 404s on the agent's first
 * turn. So the table below is real ids from the three catalogues, including the
 * shapes that have historically broken naive matching — `gemini` contains the
 * substring `mini`, `o4-mini` is a reasoning model at the small size, `gpt-4o`
 * hides its version in `4o`, and Anthropic writes a minor as `-5` rather than
 * `.5`.
 */

const cases: [id: string, type: string, tier: WorkComplexity | null, family: string | null][] = [
  // Anthropic — the minor is hyphen-separated, and the date is not a version.
  ['claude-haiku-4-5-20251001', 'anthropic', 'simple', 'haiku'],
  ['claude-3-5-haiku-20241022', 'anthropic', 'simple', 'haiku'],
  ['claude-sonnet-4-5', 'anthropic', 'medium', 'sonnet'],
  ['claude-3-7-sonnet-20250219', 'anthropic', 'medium', 'sonnet'],
  ['claude-opus-4-1-20250805', 'anthropic', 'complex', 'opus'],
  ['claude-opus-5', 'anthropic', 'complex', 'opus'],
  // Access-gated, but still classified — bestInTier is what refuses them.
  ['claude-fable-5-1', 'anthropic', 'complex', 'fable'],
  ['claude-mythos-preview', 'anthropic', 'complex', 'mythos'],
  // OpenAI — the size suffix decides the tier, the base decides the family.
  ['gpt-5-nano', 'openai', 'simple', 'nano'],
  ['gpt-5-mini', 'openai', 'simple', 'mini'],
  ['gpt-4o-mini', 'openai', 'simple', 'mini'],
  ['o4-mini', 'openai', 'simple', 'mini'],
  ['gpt-5', 'openai', 'medium', 'gpt'],
  ['gpt-4o', 'openai', 'medium', 'gpt'],
  ['gpt-4.1', 'openai', 'medium', 'gpt'],
  ['chatgpt-4o-latest', 'openai', 'medium', 'gpt'],
  ['o3', 'openai', 'complex', 'o-series'],
  ['o1-pro', 'openai', 'complex', 'pro'],
  ['gpt-5-pro', 'openai', 'complex', 'pro'],
  // Gemini — `flash-lite` before `flash`, and `gemini` must not read as `mini`.
  ['gemini-2.0-flash-lite', 'gemini', 'simple', 'flash-lite'],
  ['gemini-2.5-flash', 'gemini', 'medium', 'flash'],
  ['gemini-2.5-flash-preview-04-17', 'gemini', 'medium', 'flash'],
  ['gemini-2.5-pro', 'gemini', 'complex', 'pro'],
  ['gemini-1.5-pro-002', 'gemini', 'complex', 'pro'],
  // A gateway is matched against every family, because the id is all there is.
  ['anthropic/claude-3-5-sonnet-20240620', 'openai_compatible', 'medium', 'sonnet'],
  ['gemini-2.0-flash', 'openai_compatible', 'medium', 'flash'],
  // The trap: `gemini` contains `mini`, and a gateway is matched against the
  // OpenAI rules too, so only a boundary anchor keeps Gemini Pro out of Simple.
  ['gemini-2.5-pro', 'openai_compatible', 'complex', 'pro'],
  ['gemini-2.0-flash-lite', 'openai_compatible', 'simple', 'flash-lite'],
  ['gpt-4o-mini', 'openai_compatible', 'simple', 'mini'],
  // …and files nothing it does not recognise, rather than guessing.
  ['deepseek-chat', 'openai_compatible', null, null],
  ['mistral-large-latest', 'anthropic', null, null],
  // A parameter count *is* recognition, and this case changed when the local
  // size rules landed: it used to be unclassified. The gateway path matches
  // every non-catch-all rule precisely because the id is the only evidence
  // there is, and `70B` is that evidence stated outright — leaving it null
  // meant a gateway user asking for Complex work got no model at all.
  ['meta-llama/Llama-3.3-70B-Instruct', 'openai_compatible', 'complex', 'local-large'],
  // The catch-all is the exception: it belongs to `ollama` and must not reach a
  // gateway, or every unrecognised proxied id silently becomes Medium.
  ['some-unknown-gateway-model', 'openai_compatible', null, null],

  // Ollama — sized, not named. See PARAMS_* in modelFamilies.ts.
  ['llama3.2:1b', 'ollama', 'simple', 'local-small'],
  ['llama3.2:3b', 'ollama', 'simple', 'local-small'],
  ['qwen2.5:0.5b', 'ollama', 'simple', 'local-small'],
  // The regression the lookbehind exists for: the `.5b` tail of `1.5b` used to
  // match the Medium rule, filing a 1.5B model as mid-size.
  ['deepseek-r1:1.5b', 'ollama', 'simple', 'local-small'],
  ['moondream:1.8b', 'ollama', 'simple', 'local-small'],
  // Sizes in millions are Simple whatever the figure.
  ['smollm2:135m', 'ollama', 'simple', 'local-small'],
  ['mistral:7b', 'ollama', 'medium', 'local-mid'],
  ['qwen3:8b', 'ollama', 'medium', 'local-mid'],
  ['phi4:14b', 'ollama', 'medium', 'local-mid'],
  ['llama3.2-vision:11b', 'ollama', 'medium', 'local-mid'],
  // An MoE tag names two numbers; the `x` is a separator so the second is read.
  ['mixtral:8x7b', 'ollama', 'medium', 'local-mid'],
  ['gpt-oss:20b', 'ollama', 'complex', 'local-large'],
  ['gemma3:27b', 'ollama', 'complex', 'local-large'],
  ['qwen2.5-coder:32b', 'ollama', 'complex', 'local-large'],
  ['llama3.1:70b', 'ollama', 'complex', 'local-large'],
  ['llama3.1:405b', 'ollama', 'complex', 'local-large'],
  // A version is not a size: `3.2` must not be read as 3.2B, and the tag is
  // classified on its `:3b` alone.
  ['llama3.2:3b', 'ollama', 'simple', 'local-small'],
  // An unsized tag still gets a tier — Medium, because Ollama's default tag is
  // almost always the 7–8B build, and null would leave every tier empty on a
  // machine that pulled only defaults.
  ['deepseek-r1:latest', 'ollama', 'medium', 'local'],
  ['llama3:latest', 'ollama', 'medium', 'local'],
  // A cloud family name inside a local tag is still sized, not read as a
  // product tier — `ollama` is in KNOWN_TYPES so the cloud rules never apply.
  ['mistral-small3.2:24b', 'ollama', 'complex', 'local-large']
]

describe('classifyModel', () => {
  for (const [id, type, tier, family] of cases) {
    it(`${type}: ${id} → ${tier ?? 'unclassified'}`, () => {
      const result = classifyModel(id, type)
      expect(result?.tier ?? null).toBe(tier)
      expect(result?.family ?? null).toBe(family)
    })
  }

  it('ranks a hyphenated minor above a lower one, and a two-digit minor above both', () => {
    const v = (id: string): number | null => classifyModel(id, 'anthropic')?.version ?? null
    expect(v('claude-sonnet-4-5')).toBeGreaterThan(v('claude-opus-4-1') as number)
    expect(v('claude-sonnet-4-10')).toBeGreaterThan(v('claude-sonnet-4-5') as number)
    expect(v('claude-sonnet-5')).toBeGreaterThan(v('claude-sonnet-4-10') as number)
  })

  it('reads a pinned date as a snapshot, not as a version', () => {
    const dated = classifyModel('claude-haiku-4-5-20251001', 'anthropic')
    const alias = classifyModel('claude-haiku-4-5', 'anthropic')
    expect(dated?.snapshot).toBe(true)
    expect(alias?.snapshot).toBe(false)
    expect(dated?.version).toBe(alias?.version)
  })

  it('flags a preview build but not a `latest` alias', () => {
    expect(classifyModel('gemini-2.5-flash-preview-04-17', 'gemini')?.preview).toBe(true)
    expect(classifyModel('chatgpt-4o-latest', 'openai')?.preview).toBe(false)
  })
})

function catalogue(...ids: string[]): CatalogueModel[] {
  return ids.map((id) => ({ id }))
}

describe('bestInTier', () => {
  it('picks the newest in the tier', () => {
    const models = catalogue('claude-3-5-haiku-20241022', 'claude-haiku-4-5', 'claude-sonnet-4-5')
    expect(bestInTier('simple', models, 'anthropic')).toBe('claude-haiku-4-5')
    expect(bestInTier('medium', models, 'anthropic')).toBe('claude-sonnet-4-5')
  })

  it('prefers the stable alias over the dated snapshot of the same version', () => {
    // The `-latest` spelling on purpose: a bare alias is a prefix of its own
    // snapshot and would win on the id tiebreak alone, so it proves nothing.
    const models = catalogue('claude-3-5-haiku-20241022', 'claude-3-5-haiku-latest')
    expect(bestInTier('simple', models, 'anthropic')).toBe('claude-3-5-haiku-latest')
  })

  it('prefers a stable older model over a newer preview', () => {
    const models = catalogue('gemini-2.0-flash', 'gemini-2.5-flash-preview-04-17')
    expect(bestInTier('medium', models, 'gemini')).toBe('gemini-2.0-flash')
  })

  it('falls to the best preview when the whole tier is preview', () => {
    const models = catalogue('gemini-2.0-flash-preview', 'gemini-2.5-flash-preview-04-17')
    expect(bestInTier('medium', models, 'gemini')).toBe('gemini-2.5-flash-preview-04-17')
  })

  it('never auto-selects an access-gated tier, even as the only complex model', () => {
    const models = catalogue('claude-fable-5-1', 'claude-mythos-5', 'claude-sonnet-4-5')
    expect(bestInTier('complex', models, 'anthropic')).toBeNull()
    const withOpus = catalogue('claude-fable-5-1', 'claude-opus-4-1-20250805')
    expect(bestInTier('complex', withOpus, 'anthropic')).toBe('claude-opus-4-1-20250805')
  })

  it('drops non-chat models the catalogue mixes in', () => {
    const models = catalogue('text-embedding-3-large', 'gpt-4o-mini-tts', 'gpt-5-mini')
    expect(bestInTier('simple', models, 'openai')).toBe('gpt-5-mini')
  })

  it('prefers mini over nano at the same version, and version over both', () => {
    expect(bestInTier('simple', catalogue('gpt-5-nano', 'gpt-5-mini'), 'openai')).toBe('gpt-5-mini')
    expect(bestInTier('simple', catalogue('gpt-5-nano', 'gpt-4o-mini'), 'openai')).toBe('gpt-5-nano')
  })

  it('returns null when the credential lists nothing in the tier', () => {
    expect(bestInTier('complex', catalogue('gpt-5-mini', 'gpt-5'), 'openai')).toBeNull()
    expect(bestInTier('simple', catalogue('deepseek-chat'), 'openai_compatible')).toBeNull()
  })
})

describe('sameFamilyFallback', () => {
  it('moves a retired id up to the next version in its own family', () => {
    const models = catalogue('gpt-5.5-mini', 'gpt-5.3-mini', 'gpt-5.5', 'gpt-5-nano')
    expect(sameFamilyFallback('gpt-5.4-mini', models, 'openai')).toBe('gpt-5.5-mini')
  })

  it('drops to the nearest version below when nothing above exists', () => {
    const models = catalogue('gpt-5.3-mini', 'gpt-4o-mini', 'gpt-5.5')
    expect(sameFamilyFallback('gpt-5.4-mini', models, 'openai')).toBe('gpt-5.3-mini')
  })

  it('takes the same version by another spelling before a different version', () => {
    const models = catalogue('claude-haiku-4-5-20251001', 'claude-haiku-5')
    expect(sameFamilyFallback('claude-haiku-4-5', models, 'anthropic')).toBe(
      'claude-haiku-4-5-20251001'
    )
  })

  it('never crosses into another family, even to a newer model', () => {
    const models = catalogue('claude-opus-5', 'claude-sonnet-5')
    expect(sameFamilyFallback('claude-haiku-4-5', models, 'anthropic')).toBeNull()
  })

  it('substitutes within a gated family the user pinned by hand', () => {
    const models = catalogue('claude-fable-5-2', 'claude-opus-5')
    expect(sameFamilyFallback('claude-fable-5-1', models, 'anthropic')).toBe('claude-fable-5-2')
  })

  it('has no answer for an id nothing recognises', () => {
    expect(sameFamilyFallback('deepseek-chat', catalogue('deepseek-reasoner'), 'openai_compatible'))
      .toBeNull()
  })
})
