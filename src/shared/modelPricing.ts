/**
 * List prices per model, for the session telemetry's estimates: Codex turn
 * cost (the runtime reports none), the next message's pre-context price, the
 * current model's prices, and the calibration check against Claude's runtime
 * cost.
 *
 * **An unknown model has no price.** No nearest match, no family guess: a
 * price that is wrong looks exactly like one that is right, and the UI says
 * "price unknown" instead. Partner clouds (Bedrock, Vertex) price differently
 * and are not estimated at all; that decision is the caller's.
 *
 * Sources, checked on {@link PRICES_CHECKED_AT}:
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
 * - OpenAI (Standard tier): https://developers.openai.com/api/docs/pricing
 *
 * All prices are USD per million tokens.
 */

export const PRICES_CHECKED_AT = '2026-09-29'

export type CacheTtl = '5m' | '1h'

/** The prices a request is charged at, per MTok. */
export interface TokenPrices {
  /** Uncached input. */
  input: number
  output: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
}

export interface ModelPrice extends TokenPrices {
  /**
   * A higher tier for requests whose input exceeds `aboveInputTokens`. Cache
   * writes in the tier scale with its input price.
   */
  longContext?: { aboveInputTokens: number; input: number; cacheRead: number; output: number }
  /**
   * A premium above this input size that is not modeled: no estimate is given
   * past it (Sonnet 4.5 and 4 above 200K).
   */
  unpricedAboveInputTokens?: number
  /**
   * Fast-mode input and output. Caching multipliers apply on top of the fast
   * input price: writes at the model's write ratios of it, reads at its read ratio.
   */
  fast?: { input: number; output: number }
}

/** Anthropic: input, 5m write, 1h write, cache read, output. */
function claude(input: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number, output: number, extra: Partial<ModelPrice> = {}): ModelPrice {
  return { input, cacheWrite5m, cacheWrite1h, cacheRead, output, ...extra }
}

/** OpenAI: input, cached input, output. No cache-write price, so a write is charged as input. */
function openai(input: number, cacheRead: number, output: number, long?: [input: number, cacheRead: number, output: number]): ModelPrice {
  return {
    input,
    cacheWrite5m: input,
    cacheWrite1h: input,
    cacheRead,
    output,
    ...(long ? { longContext: { aboveInputTokens: 272_000, input: long[0], cacheRead: long[1], output: long[2] } } : {})
  }
}

const SONNET_4_LEGACY = claude(3, 3.75, 6, 0.3, 15, { unpricedAboveInputTokens: 200_000 })

/** Keyed by {@link canonicalPricingModel}. */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze({
  // Anthropic
  'claude-fable-5-1': claude(10, 12.5, 20, 0.25, 50),
  'claude-mythos-5-1': claude(10, 12.5, 20, 0.25, 50),
  'claude-fable-5': claude(10, 12.5, 20, 1, 50),
  'claude-mythos-5': claude(10, 12.5, 20, 1, 50),
  'claude-opus-5-5': claude(4, 5, 8, 0.2, 20, { fast: { input: 8, output: 40 } }),
  'claude-opus-5': claude(5, 6.25, 10, 0.5, 25, { fast: { input: 10, output: 50 } }),
  'claude-opus-4-8': claude(5, 6.25, 10, 0.5, 25, { fast: { input: 10, output: 50 } }),
  'claude-opus-4-7': claude(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-6': claude(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-5': claude(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-1': claude(15, 18.75, 30, 1.5, 75),
  'claude-opus-4': claude(15, 18.75, 30, 1.5, 75),
  'claude-sonnet-5-5': claude(2, 2.5, 4, 0.2, 10),
  'claude-sonnet-5': claude(2, 2.5, 4, 0.2, 10),
  // 4.6 and later have no long-context premium.
  'claude-sonnet-4-6': claude(3, 3.75, 6, 0.3, 15),
  'claude-sonnet-4-5': SONNET_4_LEGACY,
  'claude-sonnet-4': SONNET_4_LEGACY,
  'claude-haiku-4-5': claude(1, 1.25, 2, 0.1, 5),
  // OpenAI; the long-context tier starts above 272K input tokens.
  'gpt-6-astra': openai(10, 1, 50, [20, 2, 75]),
  'gpt-6.1-sol': openai(2, 0.1, 10, [4, 0.2, 15]),
  'gpt-6-luna': openai(0.1, 0.01, 0.5, [0.2, 0.02, 0.75]),
  'gpt-6-sol': openai(2, 0.2, 10, [4, 0.4, 15]),
  'gpt-5.6-sol': openai(4, 0.4, 20, [8, 0.8, 30]),
  'gpt-5.6-terra': openai(2, 0.2, 12, [4, 0.4, 18]),
  'gpt-5.6-luna': openai(0.2, 0.02, 1.2, [0.4, 0.04, 1.8]),
  'gpt-5.5': openai(5, 0.5, 30, [10, 1, 45]),
  'gpt-5.4': openai(2.5, 0.25, 15, [5, 0.5, 22.5]),
  'gpt-5.4-mini': openai(0.75, 0.075, 4.5),
  'gpt-5.4-nano': openai(0.2, 0.02, 1.25),
  'gpt-5.3-codex': openai(1.75, 0.175, 14),
  'gpt-5.2': openai(1.75, 0.175, 14),
  'gpt-5.1': openai(1.25, 0.125, 10),
  'gpt-5': openai(1.25, 0.125, 10),
  'gpt-5-mini': openai(0.25, 0.025, 2),
  'gpt-5-nano': openai(0.05, 0.005, 0.4)
})

/**
 * A model id as the price table keys it: lowercased, without a bracketed
 * variant (`[1m]`), a Vertex `@…` version, a Bedrock region/`anthropic.`
 * prefix and `-v1:0` suffix, or a trailing `-YYYYMMDD` date.
 *
 * `claude-sonnet-5[1m]` → `claude-sonnet-5`;
 * `us.anthropic.claude-sonnet-4-5-20250929-v1:0` → `claude-sonnet-4-5`;
 * `claude-opus-4-1@20250805` → `claude-opus-4-1`.
 */
export function canonicalPricingModel(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/@.*$/, '')
    .replace(/\[[^\]]*\]$/, '')
    .replace(/^(?:[a-z-]+\.)?anthropic\./, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/-\d{8}$/, '')
}

/** The model's list prices, or undefined when the table does not know it. */
export function priceOf(model: string | undefined): ModelPrice | undefined {
  if (!model) return undefined
  const id = canonicalPricingModel(model)
  return Object.prototype.hasOwnProperty.call(MODEL_PRICES, id) ? MODEL_PRICES[id] : undefined
}

export interface PriceOptions {
  /** Fast mode was on. A model without fast prices then has no price. */
  fast?: boolean
  /** The request's input (uncached plus cache read and write), which picks the tier. */
  contextTokens?: number
}

/**
 * What a request is charged per MTok under `options`, or undefined when that
 * cannot be told (fast mode without fast prices, or an input size past an
 * unmodeled premium).
 */
export function effectivePrices(price: ModelPrice, options: PriceOptions = {}): TokenPrices | undefined {
  const context = options.contextTokens ?? 0
  if (price.unpricedAboveInputTokens !== undefined && context > price.unpricedAboveInputTokens) return undefined
  let base: TokenPrices = price
  if (price.longContext && context > price.longContext.aboveInputTokens) {
    const tier = price.longContext
    const scale = tier.input / price.input
    base = {
      input: tier.input,
      output: tier.output,
      cacheRead: tier.cacheRead,
      cacheWrite5m: price.cacheWrite5m * scale,
      cacheWrite1h: price.cacheWrite1h * scale
    }
  }
  if (!options.fast) return base
  if (!price.fast) return undefined
  // The caching multipliers apply on top of the fast input price.
  const scale = price.fast.input / base.input
  return {
    input: price.fast.input,
    output: price.fast.output,
    cacheWrite5m: base.cacheWrite5m * scale,
    cacheWrite1h: base.cacheWrite1h * scale,
    cacheRead: base.cacheRead * scale
  }
}

/** The tokens a cost is computed for. `cacheWrite1h`, when present, is the part of `cacheWrite` written with a 1h TTL. */
export interface PricedTokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cacheWrite1h?: number
}

export interface CostOptions extends PriceOptions {
  /** The TTL of cache writes not split out as `cacheWrite1h`. Default 5m. */
  ttl?: CacheTtl
}

/**
 * The list-price cost in USD of `tokens` on `model`, or undefined when the
 * model has no known price (never a guess).
 */
export function costOf(model: string | undefined, tokens: PricedTokens, options: CostOptions = {}): number | undefined {
  const price = priceOf(model)
  if (!price) return undefined
  const rates = effectivePrices(price, options)
  if (!rates) return undefined
  const write1h = Math.min(tokens.cacheWrite1h ?? 0, tokens.cacheWrite)
  const writeRest = tokens.cacheWrite - write1h
  const restRate = options.ttl === '1h' ? rates.cacheWrite1h : rates.cacheWrite5m
  return (
    tokens.input * rates.input +
    tokens.output * rates.output +
    tokens.cacheRead * rates.cacheRead +
    write1h * rates.cacheWrite1h +
    writeRest * restRate
  ) / 1_000_000
}
