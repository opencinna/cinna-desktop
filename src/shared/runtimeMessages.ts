/**
 * What to *say* about a resolved runtime — the one place the sentences live.
 *
 * `shared/runtimeDefaults.ts` exists because the "Runs with" panel and the engine
 * once disagreed about which model an agent would run on, and the fix was to make
 * them call one function. This module is the same fix applied to the sentence.
 *
 * The two sides had grown two ladders that decided the same things: which problem
 * outranks which, and how each is worded. `runtimeService.resolve` built one into
 * `ResolvedRuntime.reason`; the panel built another into its reserved status line.
 * They agreed, which is the dangerous state — nothing was wrong on screen, and
 * nothing would have been wrong on screen for a while after someone added a case
 * to one and not the other. Worse, the service's copy had **no consumer at all**:
 * `collectEngineAgents` reads `credentialId` and `modelId` and nothing else, so
 * half the duplication was invisible by construction and no test could have
 * noticed it drifting.
 *
 * ## Why two functions and not one
 *
 * Because the panel interleaves its own entries between them, and that ordering
 * is deliberate: **credential problems come before model problems**, since a
 * model cannot be fixed while the key it would run on cannot make a call — but
 * the panel's *loading* states sit between the two groups, because before the
 * model registry lands it cannot honestly say anything about a model at all.
 * A single function would force the panel to choose between its ordering and
 * this module's.
 *
 * ## What is deliberately *not* here
 *
 * Anything only one side can know. The panel keeps its write errors, its
 * conversion notes, its loading states, `modelBelongsElsewhere` (which needs the
 * whole registry, not one credential's slice), the disabled-Advanced
 * explanation, and the healthy-state line. The main process keeps nothing — it
 * has no sentence of its own left, which is the point.
 *
 * Pure and dependency-free apart from the tier labels, so both processes can use
 * it and a test can exercise it without a DOM or a database.
 */

import { WORK_COMPLEXITY_LABELS, type WorkComplexity } from './modelFamilies'
import type { ModelOrigin } from './runtimeDefaults'

/** How loudly to say it. The renderer maps these onto its own colour tokens. */
export type MessageTone = 'warn' | 'note'

export interface RuntimeMessage {
  text: string
  tone: MessageTone
}

/**
 * A resolved runtime, reduced to what deciding a message actually needs.
 *
 * Deliberately not `ResolvedRuntime`: the panel does not have one and should not
 * have to fabricate one, and half of that type's fields say nothing about what
 * to tell the user.
 */
export interface RuntimeFacts {
  /** The credential reference from the manifest, verbatim. Null when it names none. */
  credentialRef: string | null
  /** True when that reference resolved to a credential this machine has. */
  credentialResolved: boolean
  /** The credential actually in play — the manifest's, or the Default runtime's. */
  credentialName: string | null
  /** False when it has no API key this app can call with. */
  credentialUsable: boolean
  /** The manifest's Work Complexity, when it declares one. */
  complexity: WorkComplexity | null
  modelId: string | null
  modelSource: ModelOrigin
  /** For `modelSource === 'substituted'`: the id the manifest still names. */
  replacedModelId: string | null
  /**
   * Whether a catalogue was available to resolve against. False for a gateway
   * that does not implement `/models`, or before the registry has landed —
   * either way, "this credential lists no model for that tier" would be an
   * assertion about a list nobody read.
   */
  catalogueKnown: boolean
}

/** Turn a model id into something that fits a sentence. Defaults to the id. */
export type DisplayName = (id: string | null) => string

const asIs: DisplayName = (id) => id ?? ''

/**
 * Problems with the credential itself. Ranked above everything about a model,
 * because a model cannot be fixed while the key it would run on cannot call.
 */
export function describeCredential(facts: RuntimeFacts): RuntimeMessage | null {
  if (facts.credentialRef !== null && !facts.credentialResolved) {
    return {
      text: `This agent asks for “${facts.credentialRef}”, which is not configured on this machine.`,
      tone: 'warn'
    }
  }
  if (facts.credentialName === null) {
    return {
      text: 'No AI credential to run on. Add one in Settings → AI Credentials.',
      tone: 'warn'
    }
  }
  // The Default runtime is named even when it cannot run, so this has to say
  // which of the two it is rather than leaving a credential that looks fine.
  if (!facts.credentialUsable) {
    return { text: `“${facts.credentialName}” has no API key this app can use.`, tone: 'warn' }
  }
  return null
}

/**
 * What became of the model, once the credential is known to be usable.
 *
 * Ordered so that the two entries a user can act on lead with the action: at the
 * 800px minimum window this line truncates, and the half that survives has to be
 * the half they can do something about.
 */
export function describeModel(
  facts: RuntimeFacts,
  displayName: DisplayName = asIs
): RuntimeMessage | null {
  if (facts.modelSource === 'substituted') {
    // Not a failure — the agent runs. But it runs on something other than what
    // the file says, and the file is the user's, so this is said rather than the
    // manifest quietly rewritten.
    return {
      text: `“${displayName(facts.replacedModelId)}” is no longer listed. Running on “${displayName(facts.modelId)}”.`,
      tone: 'note'
    }
  }
  if (facts.modelId !== null) return null

  if (facts.complexity !== null) {
    return facts.catalogueKnown
      ? {
          text: `Pick another complexity or another credential — ${facts.credentialName ?? 'this credential'} lists no model for ${WORK_COMPLEXITY_LABELS[facts.complexity]} work.`,
          tone: 'warn'
        }
      : {
          text: 'The model list has not loaded, so this agent’s work complexity cannot be resolved yet.',
          tone: 'note'
        }
  }
  // "Pick one" is only an instruction the user can follow while the select has
  // something in it; with nothing listed, loading the list is the remedy.
  return facts.catalogueKnown
    ? { text: 'No model set. Pick one, or this agent has nothing to run on.', tone: 'warn' }
    : NO_CATALOGUE
}

/**
 * Nothing to choose from yet.
 *
 * Exported because it is reached two ways: {@link describeModel} returns it when
 * nothing resolved *and* nothing was listed, and the panel shows it at the very
 * bottom of its own ladder for the other case — a credential that lists nothing
 * while the agent still runs on a model lent from elsewhere, which is a working
 * agent with an empty picker rather than a problem to fix. One sentence, two
 * positions, defined once.
 */
export const NO_CATALOGUE: RuntimeMessage = {
  text: 'No models listed for this credential yet. Open Settings → AI Credentials to load them.',
  tone: 'note'
}

/** Both ladders in order — the whole of what a runtime has to say for itself. */
export function describeRuntime(
  facts: RuntimeFacts,
  displayName: DisplayName = asIs
): RuntimeMessage | null {
  return describeCredential(facts) ?? describeModel(facts, displayName)
}

/**
 * Why the engine left an agent out of its config.
 *
 * A **code**, not a sentence, because the sentence is shown on the agent page and
 * the decision is made in `configGenerator`. While the reason travelled as prose,
 * editing the config generator silently rewrote a line on a screen at its
 * narrowest supported width, with no test asserting the result and nobody
 * re-reading it. The generator now says what happened; this module says how to
 * put it.
 */
export type EngineSkipCode =
  /** The runtime's credential is not one the engine was given. */
  | 'credential_unavailable'
  /** The runtime resolved to no model at all. */
  | 'no_model'

export function describeEngineSkip(code: EngineSkipCode): string {
  switch (code) {
    case 'credential_unavailable':
      return 'The engine skipped this agent because its credential is not available to it.'
    case 'no_model':
      return 'The engine skipped this agent because its runtime names no model.'
  }
}
