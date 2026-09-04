import { describe, it, expect } from 'vitest'
import { synthesizeFolderAgentMetadata } from './folderAgentMetadata'
import type { CinnaAgentManifest } from '../../../shared/kit/manifest'

/**
 * The manifest reaching this function is a cast, not a validation —
 * `parseManifest` proves only that the file is a JSON object, and a folder
 * whose manifest carries junk in `example_prompts` is still indexed (only an
 * unreadable *identity* keeps a folder out of the index). So the adversarial
 * inputs here are the ordinary ones: a hand-edited file that put a string
 * where an array belongs, or left a stray `null` in the list.
 *
 * Everything this produces lands in the `agents.remoteMetadata` column and is
 * read by two consumers that never type-check it again: the composer's `#`
 * prompt list and `A2AAsMcpProvider.fallbackDescription`, which joins the
 * entries straight into an LLM-facing tool description.
 */

function manifest(overrides: Record<string, unknown> = {}): CinnaAgentManifest {
  return { id: 'a-uuid', name: 'Writer', slug: 'writer', ...overrides } as CinnaAgentManifest
}

describe('synthesizeFolderAgentMetadata', () => {
  it('carries the manifest example prompts through in order', () => {
    const meta = synthesizeFolderAgentMetadata(
      manifest({ example_prompts: ['dad-joke: tell me one', 'summarise my inbox'] })
    )
    expect(meta.example_prompts).toEqual(['dad-joke: tell me one', 'summarise my inbox'])
  })

  it('drops every non-string entry rather than passing junk to the tool description', () => {
    const meta = synthesizeFolderAgentMetadata(
      manifest({ example_prompts: [1, null, {}, ['nested'], true, 'the only real one'] })
    )
    // The consequence first: exactly the usable prompt survives. A `null` or an
    // object reaching `example_prompts` would be rendered as a `#` tag and
    // joined into the agent's tool description as `[object Object]`.
    expect(meta.example_prompts).toEqual(['the only real one'])
  })

  it('drops blank and whitespace-only entries, and trims the rest', () => {
    const meta = synthesizeFolderAgentMetadata(
      manifest({ example_prompts: ['', '   ', '  padded prompt  '] })
    )
    expect(meta.example_prompts).toEqual(['padded prompt'])
  })

  it('returns an empty list when example_prompts is a string rather than an array', () => {
    // The likeliest hand-edit: one prompt written without the brackets. Spread
    // as an array this would become one `#` tag per character.
    const meta = synthesizeFolderAgentMetadata(manifest({ example_prompts: 'tell me a joke' }))
    expect(meta.example_prompts).toEqual([])
  })

  it('returns an empty list when example_prompts is absent or null', () => {
    expect(synthesizeFolderAgentMetadata(manifest()).example_prompts).toEqual([])
    expect(
      synthesizeFolderAgentMetadata(manifest({ example_prompts: null })).example_prompts
    ).toEqual([])
  })

  it('emits no cinna_mcp descriptor, so the provider keeps its own fallback', () => {
    // `A2AAsMcpProvider.getTools()` prefers `cinna_mcp.description` over
    // `fallbackDescription()`, and `buildAgentToolProviders` prefers
    // `cinna_mcp.tool_name`/`display_name` over the row name. A synthesized
    // descriptor built from the manifest blurb would therefore *replace* the
    // LLM-facing framing with a human-facing one. Absence is the better answer,
    // and it is the case the `CinnaMcpDescriptor` docstring was written for.
    const meta = synthesizeFolderAgentMetadata(
      manifest({ description: 'Writes things.', example_prompts: ['write a haiku'] })
    )
    expect(meta.cinna_mcp).toBeUndefined()
  })

  it('leaves the four remote-only fields empty rather than guessing a mapping', () => {
    const meta = synthesizeFolderAgentMetadata(
      manifest({
        description: 'Writes things.',
        router_trigger_prompt: 'when the user wants prose',
        prompts: { entrypoint: 'prompts/entrypoint.md' }
      })
    )
    // `router_trigger_prompt` is the tempting source for `entrypoint_prompt`
    // and means something else; the folder analogue of an entrypoint prompt is
    // the `prompts.entrypoint` *document*, which `promptAssembly` already puts
    // in the system prompt. Neither is this field.
    expect(meta.entrypoint_prompt).toBeNull()
    expect(meta.session_mode).toBeNull()
    expect(meta.ui_color_preset).toBeNull()
    expect(meta.protocol_versions).toEqual([])
  })

  it('fills all five required fields, so the object satisfies RemoteAgentMetadata', () => {
    const meta = synthesizeFolderAgentMetadata(manifest())
    expect(Object.keys(meta).sort()).toEqual([
      'entrypoint_prompt',
      'example_prompts',
      'protocol_versions',
      'session_mode',
      'ui_color_preset'
    ])
  })
})

/**
 * The two size caps, which the earlier version of this function did not have.
 *
 * They are the validator's own numbers (`manifest.example_prompts.too_many`,
 * `manifest.example_prompts.item_too_long`), and they matter here rather than
 * only there for the reason the shape guards matter here: the validator reports
 * and the scanner indexes anyway. The per-item cap is the load-bearing one —
 * `fallbackDescription` joins the first three entries into the tool description
 * the orchestrating model reads on every turn, and it caps the count at three
 * while capping the length not at all.
 */
describe('synthesizeFolderAgentMetadata size caps', () => {
  const long = 'x'.repeat(501)

  it('keeps an unbounded manifest from spending kilobytes of model context per turn', () => {
    const meta = synthesizeFolderAgentMetadata(
      manifest({ example_prompts: [long, long, long, 'a short one'] })
    )
    // The consequence first: what `fallbackDescription` would put in the tool
    // description is now bounded. Unclamped this was ~1.5 KB for these three
    // alone, and a realistic manifest makes it ten times that.
    expect(meta.example_prompts.slice(0, 3).join('; ').length).toBeLessThan(500)
    expect(meta.example_prompts).toEqual(['a short one'])
  })

  it('drops an entry over 500 characters rather than truncating it', () => {
    // Truncation would produce a third thing — neither what the author wrote
    // nor absent — and show a severed sentence in the `#` list.
    const meta = synthesizeFolderAgentMetadata(manifest({ example_prompts: [long] }))
    expect(meta.example_prompts).toEqual([])
  })

  it('keeps an entry of exactly 500 characters, which the validator allows', () => {
    // The boundary is `> 500`, not `>= 500`. Asserted because an off-by-one
    // here silently discards a legal prompt and nothing would report it.
    const exact = 'y'.repeat(500)
    expect(synthesizeFolderAgentMetadata(manifest({ example_prompts: [exact] })).example_prompts)
      .toEqual([exact])
  })

  it('measures the untrimmed length, as the validator does', () => {
    // A 498-character prompt padded to 502 is one the validator rejects. If this
    // measured the trimmed length the two would disagree about exactly the
    // entries sitting on the boundary, which is the drift the shared numbers
    // exist to prevent.
    const padded = `  ${'z'.repeat(498)}  `
    expect(padded.length).toBe(502)
    expect(synthesizeFolderAgentMetadata(manifest({ example_prompts: [padded] })).example_prompts)
      .toEqual([])
  })

  it('keeps the first 20 entries and no more', () => {
    const many = Array.from({ length: 25 }, (_, i) => `prompt ${i}`)
    const meta = synthesizeFolderAgentMetadata(manifest({ example_prompts: many }))
    expect(meta.example_prompts).toHaveLength(20)
    expect(meta.example_prompts[0]).toBe('prompt 0')
    expect(meta.example_prompts[19]).toBe('prompt 19')
  })

  it('counts toward the 20 only what survives, so junk cannot crowd out real prompts', () => {
    // 20 unusable entries followed by a real one: filtering before counting is
    // what keeps the real prompt. Capping the raw array first would drop it.
    const stuffed = [...Array.from({ length: 20 }, () => '   '), 'the real one']
    expect(synthesizeFolderAgentMetadata(manifest({ example_prompts: stuffed })).example_prompts)
      .toEqual(['the real one'])
  })
})
