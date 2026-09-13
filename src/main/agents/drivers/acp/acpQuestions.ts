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
  const askable = entries.filter(([, value]) => {
    const field = asRecord(value)
    const codex = asRecord(asRecord(field?._meta)?.codex)
    return !isCustomAnswerField(field) && codex?.isOtherAnswer !== true
  })

  for (const [key, raw] of askable) {
    const field = asRecord(raw)
    if (!field) continue
    const multiple = field.type === 'array'
    const options = enumOptions(field)
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

function isCustomAnswerField(field: Record<string, unknown> | undefined): boolean {
  const meta = asRecord(field?._meta)
  return meta !== undefined && CUSTOM_ANSWER_META_KEY in meta
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
