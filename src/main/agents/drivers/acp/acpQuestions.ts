/**
 * ACP's `elicitation/create` in one direction and the desktop's answer in the
 * other — the path by which a Claude agent can finally ask the user a question.
 *
 * ## Why this file exists at all
 *
 * The in-process Claude runner had no question path: the SDK's
 * `AskUserQuestion` tool was simply disabled, and the model asked in prose.
 * Over ACP the adapter enables the tool **only when the client advertises
 * `clientCapabilities.elicitation.form`** (it goes into `disallowedTools`
 * otherwise), and then renders each of the tool's questions as a form field.
 * So declaring the capability is what gains the capability, and this module is
 * what makes the declaration honest.
 *
 * OpenCode goes the other way for now: its `question` tool is not registered
 * under `OPENCODE_CLIENT=acp` at all, and its ACP layer bridges no question to
 * `elicitation/create` — so nothing here fires for that launcher. See the Q3
 * verdict in the phase 3 plan.
 *
 * ## The schema shape is the adapter's, and it is read rather than guessed
 *
 * `@agentclientprotocol/claude-agent-acp@0.76.0`'s
 * `askUserQuestionsToCreateRequest` builds, per question at index `n`:
 *
 * - `question_<n>` — `{type:'string', title, description, oneOf:[EnumOption]}`
 *   for a single-select, or `{type:'array', items:{anyOf:[EnumOption]}}` for a
 *   multi-select. An `EnumOption` is `{const, title, description?}` and the
 *   `const` **is the option's label**, because that is what the tool records as
 *   the answer.
 * - `question_<n>_custom` — a free-text "Other" box, marked with
 *   `_meta._askUserQuestionCustomAnswer`. The desktop's question widget has no
 *   free-text answer, so these fields are dropped rather than rendered as
 *   questions of their own — which is what they would look like to
 *   {@link toInputQuestions} if the marker were not read.
 * - `message` — the single question's own text, or a generic lead-in when
 *   there are several. Which is why a lone question takes its text from
 *   `message` and the rest take theirs from their field `description`.
 *
 * `@agentclientprotocol/codex-acp@2.2.2`'s `buildUserInputRequest` (to a
 * client that is not the JetBrains AIR UI, which Cinna's patched adapter is
 * not) builds one field per question, keyed by the question's id, with
 * `_meta.codex: {isOther, isSecret}`; its **`title` is the question** and its
 * `description` the short header, and `message` is always the generic "Codex
 * needs your input to continue.". A question that allows another answer gets a
 * "None of the above" option and an `<id>_note` companion marked
 * `_meta.codex.role: 'user_note'`; both are dropped, the companion like
 * Claude's custom field and the option because it only points at it. A typed
 * answer is still written into the question's own field: the adapter passes a
 * value it does not offer through as the answer.
 *
 * A generic MCP-server elicitation arrives through the same request with an
 * arbitrary JSON-Schema `properties` map. It is mapped as best it can be — one
 * question per property, options from `enum`/`oneOf`/`anyOf` — and a property
 * with no options becomes a question with none, which the renderer shows as
 * free text. Nothing here throws on a schema it does not recognise: the answer
 * to an unmappable elicitation is `decline`, not a failed turn.
 */

import type { CreateElicitationRequest } from '@agentclientprotocol/sdk'
import type { InputQuestion } from '../../../../shared/runEvents'

/** The adapter's marker on a per-question free-text companion field. */
const CUSTOM_ANSWER_META_KEY = '_askUserQuestionCustomAnswer'

/** One mapped elicitation: what to ask, and how to answer it afterwards. */
export interface AcpElicitationForm {
  questions: InputQuestion[]
  /**
   * The form field each question came from, in the same order.
   *
   * Kept beside the questions rather than derived again on the way back: the
   * answer has to be written under the field's own key, and re-deriving it from
   * the schema at answer time is how a form whose fields were reordered
   * silently files an answer under the wrong question.
   */
  fields: { key: string; multiple: boolean }[]
}

/**
 * The questions a form-mode elicitation is asking, or null when it is not one
 * this build can render.
 */
export function toInputQuestions(request: CreateElicitationRequest): AcpElicitationForm | null {
  if (request.mode === 'url') return null
  // Read structurally rather than off the narrowed union: `mode` is *optional*
  // on the form variant (form is the default), so a request with no `mode` is
  // a form request that TypeScript cannot narrow to one.
  const schema = asRecord((request as { requestedSchema?: unknown }).requestedSchema)
  const properties = asRecord(schema?.properties)
  if (!properties) return null

  const questions: InputQuestion[] = []
  const fields: { key: string; multiple: boolean }[] = []
  const entries = Object.entries(properties)
  const askable = entries.filter(([key, value]) => {
    const field = asRecord(value)
    const codex = asRecord(asRecord(field?._meta)?.codex)
    return !isCustomAnswerField(key, field, properties) && codex?.isOtherAnswer !== true && codex?.role !== 'user_note'
  })

  for (const [key, raw] of askable) {
    const field = asRecord(raw)
    if (!field) continue
    const multiple = field.type === 'array'
    const options = enumOptions(field)
    // Codex's question is its field's title, its header the description.
    if (isCodexQuestion(field)) {
      questions.push({
        question: str(field.title) ?? str(field.description) ?? key,
        ...(str(field.description) ? { header: str(field.description) as string } : {}),
        multiSelect: multiple,
        options: options.filter((option) => !isCodexOtherOption(field, option))
      })
      fields.push({ key, multiple })
      continue
    }
    // A single question carries its text in `message`; several carry theirs in
    // their own `description`. Falling back to the title, and then to the key,
    // keeps a question from rendering as an empty prompt.
    const text =
      (askable.length === 1 ? str(request.message) : undefined) ??
      str(field.description) ??
      str(request.message) ??
      str(field.title) ??
      key
    questions.push({
      question: text,
      ...(str(field.title) ? { header: str(field.title) as string } : {}),
      multiSelect: multiple,
      options
    })
    fields.push({ key, multiple })
  }

  return questions.length > 0 ? { questions, fields } : null
}

/**
 * The user's answers, in the shape an accepted elicitation carries them.
 *
 * `answers[i]` is the labels chosen for question `i` — the desktop's own
 * `RequestResolution` shape, one array per question because a multi-select is
 * many labels. A single-select field takes the first label as a bare string,
 * because that is what the adapter reads back out of it; an array field takes
 * the whole list.
 *
 * A question the user skipped contributes no key at all rather than an empty
 * string: nothing is marked required in the adapter's schema, and the tool
 * treats an absent field as "skipped" — which is a different answer from "chose
 * the empty option".
 */
export function toElicitationContent(
  form: AcpElicitationForm,
  answers: readonly string[][]
): Record<string, string | string[]> {
  const content: Record<string, string | string[]> = {}
  form.fields.forEach((field, index) => {
    const chosen = (answers[index] ?? []).filter((label) => label !== '')
    if (chosen.length === 0) return
    content[field.key] = field.multiple ? chosen : chosen[0]
  })
  return content
}

/** The options a schema field offers, in the three shapes the wire uses. */
function enumOptions(field: Record<string, unknown>): { label: string; description?: string }[] {
  const items = asRecord(field.items)
  const variants =
    asArray(field.oneOf) ??
    asArray(field.anyOf) ??
    asArray(items?.anyOf) ??
    asArray(items?.oneOf) ??
    null
  if (variants) {
    return variants
      .map((variant) => {
        const option = asRecord(variant)
        // `const` is the label the tool records; `title` is what it shows. They
        // are the same string in the adapter's own output, and when they are
        // not, the answer has to be the value rather than the display text.
        const label = str(option?.const) ?? str(option?.title)
        if (!label) return null
        const description = str(option?.description)
        return description ? { label, description } : { label }
      })
      .filter((option): option is { label: string; description?: string } => option !== null)
  }
  // A plain JSON-Schema `enum`, optionally with `enumNames` beside it — the
  // shape an MCP server's own elicitation is most likely to use.
  const values = asArray(field.enum) ?? asArray(items?.enum)
  if (!values) return []
  const names = asArray(field.enumNames) ?? asArray(items?.enumNames)
  return values
    .map((value, index) => {
      const label = str(value)
      if (!label) return null
      const name = str(names?.[index])
      return name && name !== label ? { label, description: name } : { label }
    })
    .filter((option): option is { label: string; description?: string } => option !== null)
}

/**
 * The free-text companion of an option question. The Claude adapter marks it in
 * `_meta`, but from 0.89 only for a JetBrains AIR client, which Cinna's patched
 * adapter does not claim to be. So an unmarked `question_<n>_custom` with no
 * options of its own, beside its `question_<n>`, is the companion too.
 */
function isCustomAnswerField(
  key: string,
  field: Record<string, unknown> | undefined,
  properties: Record<string, unknown>
): boolean {
  const meta = asRecord(field?._meta)
  if (meta !== undefined && CUSTOM_ANSWER_META_KEY in meta) return true
  const companion = /^(question_\d+)_custom$/.exec(key)
  return companion !== null && companion[1] in properties && enumOptions(field ?? {}).length === 0
}

/** codex-acp's own "None of the above" option and its fixed description (`USER_INPUT_OTHER_OPTION`). */
const CODEX_OTHER_OPTION = 'None of the above'
const CODEX_OTHER_OPTION_DESCRIPTION = 'Provide a different answer in the note field.'

/**
 * The option codex-acp adds to a question that allows another answer. It
 * points at the `_note` companion, which is dropped, so it would be an answer
 * with nothing behind it; the desktop's own free-text Other writes into the
 * question's field instead. An option the model itself named "None of the
 * above" (the adapter then adds none) carries its own description and stays.
 */
function isCodexOtherOption(field: Record<string, unknown>, option: { label: string; description?: string }): boolean {
  const codex = asRecord(asRecord(field._meta)?.codex)
  return codex?.isOther === true && option.label === CODEX_OTHER_OPTION && option.description === CODEX_OTHER_OPTION_DESCRIPTION
}

/** A question field codex-acp built (`_meta.codex.isOther` is set on every one). */
function isCodexQuestion(field: Record<string, unknown>): boolean {
  const codex = asRecord(asRecord(field._meta)?.codex)
  return typeof codex?.isOther === 'boolean'
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * A question that arrived as a **permission request** — Antigravity's
 * `ask_question` tool. The server raises it as `session/request_permission`
 * whose call id is `interaction_<hex>`, whose title is the question and whose
 * options are the answers (`optionId` "1", "2"…, every one `allow_once`), and
 * reads the selected option id back as the answer. Single choice only.
 */
export interface AcpPermissionQuestion {
  questions: InputQuestion[]
  /** Answer label → the option id that selects it, in the server's order. */
  optionIds: Map<string, string>
}

/** The question an ask is, or null when it is an ordinary permission ask. */
export function permissionAsQuestion(
  launcher: string,
  params: { toolCall: { toolCallId: string; title?: string | null }; options: readonly { optionId: string; name: string; kind: string }[] }
): AcpPermissionQuestion | null {
  if (launcher !== 'antigravity' || !params.toolCall.toolCallId.startsWith('interaction_')) return null
  const optionIds = new Map<string, string>()
  for (const option of params.options) {
    const label = str(option.name) ?? str(option.optionId)
    // A repeated label could not be told apart in the answer; the first wins.
    if (label && !optionIds.has(label)) optionIds.set(label, option.optionId)
  }
  if (optionIds.size === 0) return null
  return {
    questions: [{
      question: str(params.toolCall.title) ?? 'Choose an answer.',
      multiSelect: false,
      options: [...optionIds.keys()].map((label) => ({ label }))
    }],
    optionIds
  }
}

/** The option id the user's answer selects, or null when they chose nothing it offered. */
export function permissionQuestionAnswer(question: AcpPermissionQuestion, answers: readonly string[][]): string | null {
  const label = (answers[0] ?? []).find((value) => question.optionIds.has(value))
  return label === undefined ? null : question.optionIds.get(label) ?? null
}
