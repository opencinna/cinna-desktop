import { test, expect } from '../fixtures/app'

/**
 * The shared note format mobile's Cinna Assistant writes, read on the desktop
 * (`docs/notes/notes/notes.md` → "Reading Assistant memory, todos and tags",
 * `docs/sync/data_sync/cross_app_alignment.md`).
 *
 * ## What is real and what is not
 *
 * Nothing is faked. Four notes are created over `note:create`, the same call
 * the `+` button makes, and the app is restarted so the list query reads them
 * fresh. Everything after that is the product's own: the memory split, the
 * Assistant memory section, the inline editor and its splice into the stored
 * body, the composer's `?` picker, the read view's remark plugin and the
 * sidebar tag filter. No model, no network.
 *
 * ## What it proves
 *
 * - A note whose frontmatter says `kind: assistant-memory` is not in the main
 *   list; a collapsed "Assistant memory" row is, and expanding it lists the
 *   note. It opens in the normal editor, and an edit typed into the body
 *   textarea is stored as the original body (frontmatter with its odd spacing
 *   and trailing blanks byte for byte) plus the appended text.
 * - The `?` picker offers every regular note and not the memory note, and a
 *   note's snippet is its body below the frontmatter, never the `---`.
 * - A `due:` and a `📅` task render "Today" / "Tomorrow" chips with the token
 *   gone from the read view; the textarea still holds the raw text.
 * - `#inbox/to-read` is a pill and `#1984` is not; the sidebar's tag menu
 *   offers the parent `inbox`, which lists only the tagged note, and "Clear
 *   tag filter" brings the whole list back.
 *
 * ## What it does not
 *
 * - CRLF bodies, frontmatter `tags`, overdue/done chip tones, the hint count
 *   and the composer preview's plain pills — the unit tests under
 *   `utils/noteFormat/` and `components/notes/` cover those.
 * - Sync: the notes are seeded locally, not received from a phone.
 */

const pad = (n: number): string => String(n).padStart(2, '0')
/** The device's local day, `offset` days from now, as YYYY-MM-DD. */
function localDay(offset: number): string {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const MEMORY_TITLE = 'Answer style'
const MEMORY_FRONTMATTER = '---\nkind: assistant-memory\nmemory_type: preference\nsummary: Short answers\nodd_key:   "kept"  \n---\n'
const MEMORY_BODY = `${MEMORY_FRONTMATTER}Prefers bullets.`
const APPENDED = ' Also tables.'

const PLAIN_TITLE = 'Plain note'
const PLAIN_BODY = '---\ntitle: Plain\n---\nPlain body text.'

const TODO_TITLE = 'Groceries'
const TAG_TITLE = 'Reading list'
const TAG_BODY = 'Read #1984 next #inbox/to-read'

test('memory notes, due chips and tags from the shared note format', async ({ cinna }) => {
  const today = localDay(0)
  const tomorrow = localDay(1)
  const todoBody = `- [ ] buy milk due:${today}\n- [ ] call 📅 ${tomorrow}`

  await cinna.skipOnboarding()
  const memoryId = await cinna.page.evaluate(
    async ({ memory, notes }) => {
      for (const note of notes) await window.api.notes.create(note)
      return (await window.api.notes.create(memory)).id
    },
    {
      memory: { title: MEMORY_TITLE, body: MEMORY_BODY },
      notes: [
        { title: PLAIN_TITLE, body: PLAIN_BODY },
        { title: TODO_TITLE, body: todoBody },
        { title: TAG_TITLE, body: TAG_BODY }
      ]
    }
  )
  // The list query was already read empty by the composer; a restart reads it anew.
  await cinna.relaunch()
  await cinna.skipOnboarding()

  const notesTab = (): ReturnType<typeof cinna.page.getByRole> =>
    cinna.page.getByRole('button', { name: 'Notes', exact: true })
  const row = (title: string): ReturnType<typeof cinna.page.getByText> => cinna.page.getByText(title, { exact: true })
  const memorySection = (): ReturnType<typeof cinna.page.getByRole> =>
    cinna.page.getByRole('button', { name: /^Assistant memory/ })
  const bodyTextarea = (): ReturnType<typeof cinna.page.getByPlaceholder> =>
    cinna.page.getByPlaceholder(/^Write in markdown\./)
  const readView = (): ReturnType<typeof cinna.page.locator> => cinna.page.locator('.markdown-body')

  await test.step('a memory note sits in a collapsed Assistant memory section, not the main list', async () => {
    await notesTab().click()
    await expect(row(PLAIN_TITLE)).toBeVisible()
    await expect(row(TODO_TITLE)).toBeVisible()
    await expect(row(TAG_TITLE)).toBeVisible()
    await expect(memorySection()).toHaveAttribute('aria-expanded', 'false')
    await expect(row(MEMORY_TITLE)).toHaveCount(0)

    await memorySection().click()
    await expect(memorySection()).toHaveAttribute('aria-expanded', 'true')
    // Once, inside the section: a collapsed section alone would hide a stray copy.
    await expect(row(MEMORY_TITLE)).toHaveCount(1)
    await expect(row(MEMORY_TITLE)).toBeVisible()
  })

  await test.step('editing it keeps the frontmatter bytes as stored', async () => {
    await row(MEMORY_TITLE).click()
    await expect(cinna.page.getByPlaceholder('Untitled note', { exact: true })).toHaveValue(MEMORY_TITLE)
    await readView().getByText('Prefers bullets.', { exact: true }).click()
    await expect(bodyTextarea()).toBeFocused()
    await expect(bodyTextarea()).toHaveValue(MEMORY_BODY)
    await bodyTextarea().press('ControlOrMeta+End')
    await bodyTextarea().pressSequentially(APPENDED)
    await bodyTextarea().blur()
    await expect(readView().getByText(`Prefers bullets.${APPENDED}`, { exact: true })).toBeVisible()

    await expect
      .poll(() => cinna.page.evaluate((id) => window.api.notes.get(id).then((n) => n.body), memoryId))
      .toBe(`${MEMORY_BODY}${APPENDED}`)
    const stored = await cinna.page.evaluate((id) => window.api.notes.get(id).then((n) => n.body), memoryId)
    expect(stored.startsWith(MEMORY_FRONTMATTER)).toBe(true)
  })

  await test.step('the ? picker offers regular notes only, snippets below the frontmatter', async () => {
    await cinna.page.getByRole('button', { name: 'Chats', exact: true }).click()
    await cinna.page.getByRole('button', { name: 'New chat', exact: true }).click()
    const composer = cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })
    await composer.click()
    await composer.pressSequentially('?')
    const picker = cinna.page.getByRole('listbox', { name: 'Notes', exact: true })
    await expect(picker).toBeVisible()
    const options = picker.getByRole('option')
    await expect(options).toHaveCount(3)
    await expect(picker.getByRole('option', { name: new RegExp(`^${MEMORY_TITLE}`) })).toHaveCount(0)
    const plain = picker.getByRole('option', { name: new RegExp(`^${PLAIN_TITLE}`) })
    await expect(plain).toHaveText(`${PLAIN_TITLE}Plain body text.`)
    await expect(picker.getByRole('option', { name: new RegExp(`^${TODO_TITLE}`) })).toBeVisible()
    await expect(picker.getByRole('option', { name: new RegExp(`^${TAG_TITLE}`) })).toBeVisible()
    await expect(picker).not.toContainText('---')
    await composer.press('Escape')
    await composer.fill('')
  })

  await test.step('due tokens render as Today / Tomorrow chips; the textarea keeps the raw text', async () => {
    await notesTab().click()
    await row(TODO_TITLE).click()
    await expect(cinna.page.getByPlaceholder('Untitled note', { exact: true })).toHaveValue(TODO_TITLE)
    const chips = readView().locator('[data-note-due]')
    await expect(chips).toHaveText(['Today', 'Tomorrow'])
    await expect(chips.nth(0)).toHaveAttribute('title', 'Due today')
    await expect(chips.nth(1)).toHaveAttribute('title', 'Due tomorrow')
    await expect(readView()).toContainText('buy milk')
    await expect(readView()).not.toContainText('due:')
    await expect(readView()).not.toContainText('📅')
    await expect(readView()).not.toContainText(today)

    await readView().getByText('buy milk').click()
    await expect(bodyTextarea()).toHaveValue(todoBody)
    await bodyTextarea().blur()
    await expect(chips).toHaveText(['Today', 'Tomorrow'])
  })

  await test.step('#inbox/to-read is a pill, #1984 is not; the tag menu filters by the parent', async () => {
    await row(TAG_TITLE).click()
    await expect(cinna.page.getByPlaceholder('Untitled note', { exact: true })).toHaveValue(TAG_TITLE)
    await expect(readView().getByRole('button', { name: '#inbox/to-read', exact: true })).toBeVisible()
    await expect(readView().getByRole('button', { name: '#1984' })).toHaveCount(0)
    await expect(readView()).toContainText('Read #1984 next')

    await cinna.page.getByRole('button', { name: 'Filter by tag', exact: true }).click()
    const menu = cinna.page.getByRole('menu', { name: 'Tags', exact: true })
    await expect(menu).toBeVisible()
    // The parent `inbox` is offered beside its nested tag; `#1984` is not a tag.
    await expect(menu).toMatchAriaSnapshot(`
      - menu "Tags":
        - menuitemradio "All notes" [checked]
        - menuitemradio "#inbox 1"
        - menuitemradio "to-read 1"
    `)
    await menu.getByRole('menuitemradio', { name: '#inbox 1', exact: true }).click()
    await expect(menu).toHaveCount(0)

    await expect(cinna.page.getByRole('button', { name: 'Clear tag filter', exact: true })).toBeVisible()
    await expect(row(TAG_TITLE)).toBeVisible()
    await expect(row(TODO_TITLE)).toHaveCount(0)
    await expect(row(PLAIN_TITLE)).toHaveCount(0)
    await expect(memorySection()).toHaveCount(0)

    await cinna.page.getByRole('button', { name: 'Clear tag filter', exact: true }).click()
    await expect(cinna.page.getByRole('button', { name: 'Clear tag filter', exact: true })).toHaveCount(0)
    await expect(row(TAG_TITLE)).toBeVisible()
    await expect(row(TODO_TITLE)).toBeVisible()
    await expect(row(PLAIN_TITLE)).toBeVisible()
    await expect(memorySection()).toBeVisible()
  })
})
