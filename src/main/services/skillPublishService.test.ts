import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

/**
 * Sharing an agent's own skill: the preview request, the preflight that keeps
 * a folder from being sent, the multipart upload and its `meta`, the one
 * retry into the person's own package on `package_exists`, every coded
 * refusal as a sentence, and what is written afterwards (`version:` in
 * SKILL.md, the `skills[]` entry in publications.json). Real agent folder,
 * real packing; only the network, the agent index and the listing are faked.
 */

const PROFILE = 'profile-cinna'
const HOST = 'https://cinna.test'
const USER = '__default__'
const AGENT_ID = 'folder:11111111-2222-4333-8444-555566667777'
const UUID = '0b6f3c1e-1111-4222-8333-444455556666'
const PACKAGE_ID = 'test.cinna.skill.erp-lookup'

const cinnaSend = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<{ status: number; ok: boolean; body: unknown }>>())
const publishEvent = vi.hoisted(() => vi.fn())
const located = vi.hoisted(() => ({ dir: '', kind: 'managed' as string }))
const listing = vi.hoisted(() => ({ value: null as null | { items: unknown[]; agents: unknown[] } }))
const refresh = vi.hoisted(() => vi.fn(async () => listing.value))
const account = vi.hoisted(() => ({ host: 'https://cinna.test' as string | null }))

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => PROFILE, getSettingsScopeUserId: () => USER }))
vi.mock('../host/events', () => ({ publishEvent }))
vi.mock('./cinna-http', () => ({ cinnaSend }))
const self = vi.hoisted(() => ({ id: 'u-me' as string | null }))
vi.mock('../auth/cinna-tokens', () => ({
  getStoredCinnaSubject: () => {
    if (self.id === null) throw new Error('No Cinna access token')
    return self.id
  }
}))
vi.mock('./libraryService', () => ({
  libraryService: {
    hostOf: (profile: string) => (profile === PROFILE ? account.host : null),
    cached: () => listing.value,
    refresh
  }
}))
vi.mock('./localAgents/localAgentService', async () => {
  const { scanAgentSkills } = await import('../kit/skills')
  const { LocalAgentError } = await import('../errors')
  return {
    localAgentService: {
      get: (_user: string, agentId: string) => {
        if (agentId !== AGENT_ID) throw new LocalAgentError('not_found', 'gone')
        return { rootId: 'root-1', path: located.dir, ...(located.kind === 'external' ? {} : { skills: scanAgentSkills(located.dir) }) }
      }
    }
  }
})
vi.mock('./localAgents/scannerService', () => ({ scannerService: { markAllRootsDirty: () => {} } }))

const { skillPublishService, catalogRefusal, publishMeta, SKILL_PUBLISH_SENTENCES, withPreviousProviders, toPreviewDto } = await import('./skillPublishService')
const { withSkillPublications } = await import('./skillPublications')
const { readSkillArchive } = await import('../kit/skillArchive')

let root: string
let agentDir: string
const skillDir = (): string => join(agentDir, 'skills', 'erp-lookup')
const SKILL_MD = '---\nname: erp-lookup\ndescription: Look things up in the ERP.\ncredentials:\n  - slot: erp.example.com\n    type: api_token\n---\n\nUse it.\n'

function writeSkill(text = SKILL_MD): void {
  mkdirSync(join(skillDir(), 'scripts'), { recursive: true })
  writeFileSync(join(skillDir(), 'SKILL.md'), text)
  writeFileSync(join(skillDir(), 'scripts', 'run.sh'), '#!/bin/sh\n')
}

/** core's preview body. */
function previewBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '1.0.0',
    header_version: null,
    latest_published_version: null,
    package_id: PACKAGE_ID,
    package_id_disambiguated: false,
    is_republish: false,
    package_uuid: null,
    next_revision_number: 1,
    credentials: [
      {
        slot: 'erp.example.com',
        type: 'api_token',
        description: null,
        provided_by: 'user',
        candidates: [
          { id: 'cred-1', name: 'ERP token', type: 'api_token', can_provide_as: ['publisher'] },
          { id: 'cred-2', name: 'Nope', type: 'api_token', can_provide_as: [] }
        ]
      }
    ],
    ...over
  }
}

/** core's `SkillPackageRevisionPublic`. */
function revisionBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'rev-1', package_id: UUID, revision_number: 1, version: '1.0.0', content_hash: 'core-hash', ...over }
}

const refusal = (status: number, detail: Record<string, unknown>) => ({ status, ok: false, body: { detail } })

/** The multipart parts of an upload call: `meta` as JSON and `archive` as bytes. */
function partsOf(call: unknown[]): { meta: Record<string, unknown>; archive: Buffer; contentType: string } {
  const opts = call[2] as { bytes: { data: Buffer; contentType: string } }
  const boundary = /boundary=(.+)$/.exec(opts.bytes.contentType)![1]
  const raw = opts.bytes.data
  const sections: Buffer[] = []
  let from = raw.indexOf(`--${boundary}`)
  while (from !== -1) {
    const next = raw.indexOf(`--${boundary}`, from + 1)
    if (next === -1) break
    sections.push(raw.subarray(from + boundary.length + 4, next - 2))
    from = next
  }
  const body = (section: Buffer): Buffer => section.subarray(section.indexOf('\r\n\r\n') + 4)
  const meta = sections.find((section) => section.toString('latin1').includes('name="meta"'))!
  const archive = sections.find((section) => section.toString('latin1').includes('name="archive"'))!
  return { meta: JSON.parse(body(meta).toString('utf8')), archive: body(archive), contentType: opts.bytes.contentType }
}

const uploads = (): unknown[][] => cinnaSend.mock.calls.filter((call) => call[1] === '/api/v1/skills/packages/publish')
const previews = (): unknown[][] => cinnaSend.mock.calls.filter((call) => call[1] === '/api/v1/skills/packages/publish-preview')
const publications = (): Record<string, unknown> => JSON.parse(readFileSync(join(agentDir, 'publications.json'), 'utf8'))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cinna-skill-publish-'))
  agentDir = join(root, 'Local', 'invoices')
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(join(agentDir, 'cinna-agent.json'), JSON.stringify({ id: '11111111-2222-4333-8444-555566667777', slug: 'invoices', name: 'Invoices' }))
  writeSkill()
  located.dir = agentDir
  located.kind = 'managed'
  account.host = HOST
  listing.value = { items: [{ kind: 'skill', uuid: UUID, id: PACKAGE_ID, access: 'maintain' }], agents: [] }
  self.id = 'u-me'
  cinnaSend.mockReset()
  refresh.mockClear()
  publishEvent.mockClear()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('preview', () => {
  it('sends the name and the parsed frontmatter, and keeps only credentials that can be provided', async () => {
    cinnaSend.mockResolvedValue({ status: 200, ok: true, body: previewBody() })
    const outcome = await skillPublishService.preview(USER, AGENT_ID, 'erp-lookup')
    expect(previews()[0][2]).toEqual({
      method: 'POST',
      json: {
        name: 'erp-lookup',
        frontmatter: {
          name: 'erp-lookup',
          description: 'Look things up in the ERP.',
          credentials: [{ slot: 'erp.example.com', type: 'api_token' }]
        }
      }
    })
    expect(outcome).toEqual({
      ok: true,
      preview: {
        name: 'erp-lookup',
        version: '1.0.0',
        packageId: PACKAGE_ID,
        packageIdDisambiguated: false,
        packageUuid: null,
        isRepublish: false,
        nextRevisionNumber: 1,
        credentials: [
          {
            slot: 'erp.example.com',
            type: 'api_token',
            description: null,
            candidates: [{ id: 'cred-1', name: 'ERP token', type: 'api_token', canProvideAs: ['publisher'] }],
            current: null
          }
        ],
        canProvide: true,
        providersCarried: true
      }
    })
  })

  it('names the recorded package for a later version', async () => {
    writeFileSync(
      join(agentDir, 'publications.json'),
      JSON.stringify({ publications: [], skills: [{ platform_url: HOST, name: 'erp-lookup', package_id: PACKAGE_ID, package_uuid: UUID, revision_number: 2, content_hash: 'x' }] })
    )
    cinnaSend.mockResolvedValue({ status: 200, ok: true, body: previewBody({ is_republish: true, package_uuid: UUID, next_revision_number: 3 }) })
    await skillPublishService.preview(USER, AGENT_ID, 'erp-lookup')
    expect((previews()[0][2] as { json: Record<string, unknown> }).json.package_uuid).toBe(UUID)
  })

  it('preselects what the latest version provided, from the package’s listing row', async () => {
    listing.value = {
      items: [
        {
          kind: 'skill',
          uuid: UUID,
          id: PACKAGE_ID,
          access: 'maintain',
          publisher: { user_id: 'u-me', display_name: 'Me' },
          required_credential_specs: [{ name: 'erp.example.com', service_uri: 'erp.example.com', provided_by: 'publisher', publisher_credential_id: 'cred-1' }]
        }
      ],
      agents: []
    }
    cinnaSend.mockResolvedValue({ status: 200, ok: true, body: previewBody({ is_republish: true, package_uuid: UUID, next_revision_number: 2 }) })
    const outcome = await skillPublishService.preview(USER, AGENT_ID, 'erp-lookup')
    expect(outcome).toMatchObject({ ok: true, preview: { canProvide: true, providersCarried: true, credentials: [{ slot: 'erp.example.com', current: 'cred-1' }] } })
  })

  it('offers no provider to an editor who did not first share it', () => {
    const base = toPreviewDto('erp-lookup', previewBody({ is_republish: true, package_uuid: UUID }))!
    const item = {
      publisher: { user_id: 'u-other', display_name: 'Ann' },
      required_credential_specs: [{ service_uri: 'erp.example.com', provided_by: 'publisher', publisher_credential_id: 'cred-1' }]
    }
    const editor = withPreviousProviders(base, item, 'u-me')
    expect(editor).toMatchObject({ canProvide: false, providersCarried: false })
    expect(editor.credentials[0].current).toBeNull()
    // The signed-in id unknown: offered, and core's own refusal says why when it is not theirs.
    expect(withPreviousProviders(base, item, null)).toMatchObject({ canProvide: true, credentials: [{ current: 'cred-1' }] })
  })

  it('says the providers are not carried when the last version is unknown or a template provided a slot', () => {
    const base = toPreviewDto('erp-lookup', previewBody({ is_republish: true, package_uuid: UUID }))!
    expect(withPreviousProviders(base, null, 'u-me')).toMatchObject({ canProvide: true, providersCarried: false })
    const template = withPreviousProviders(
      base,
      { publisher: { user_id: 'u-me', display_name: 'Me' }, required_credential_specs: [{ service_uri: 'erp.example.com', provided_by: 'template', publisher_credential_id: null }] },
      'u-me'
    )
    expect(template).toMatchObject({ providersCarried: false, credentials: [{ current: null }] })
    const own = withPreviousProviders(
      base,
      { publisher: { user_id: 'u-me', display_name: 'Me' }, required_credential_specs: [{ service_uri: 'erp.example.com', provided_by: 'user' }] },
      'u-me'
    )
    expect(own).toMatchObject({ providersCarried: true, credentials: [{ current: null }] })
    // A first share has nothing before it.
    const first = toPreviewDto('erp-lookup', previewBody())!
    expect(withPreviousProviders(first, null, 'u-me')).toBe(first)
  })

  it('answers a refusal as data: no account, a broken skill, a coded refusal', async () => {
    account.host = null
    expect(await skillPublishService.preview(USER, AGENT_ID, 'erp-lookup')).toMatchObject({ ok: false, code: 'no_account' })
    account.host = HOST
    writeSkill('---\nname: erp-lookup\n---\n')
    expect(await skillPublishService.preview(USER, AGENT_ID, 'erp-lookup')).toEqual({
      ok: false,
      code: 'skill_invalid',
      message: 'This skill can’t be shared yet: SKILL.md frontmatter has no description.'
    })
    writeSkill()
    cinnaSend.mockResolvedValue(refusal(403, { code: 'not_publisher', message: "You can't publish new versions of this skill." }))
    expect(await skillPublishService.preview(USER, AGENT_ID, 'erp-lookup')).toEqual({
      ok: false,
      code: 'not_publisher',
      message: SKILL_PUBLISH_SENTENCES.not_publisher
    })
    expect(cinnaSend).toHaveBeenCalledTimes(1)
  })
})

describe('publish preflight: nothing is sent', () => {
  it('refuses a secret-looking file, naming it in the team-sharing style', async () => {
    writeFileSync(join(skillDir(), 'scripts', '.env'), 'TOKEN=x')
    const outcome = await skillPublishService.publish(USER, { agentId: AGENT_ID, name: 'erp-lookup' })
    expect(outcome).toEqual({
      ok: false,
      code: 'secrets',
      message: 'A file that can hold a secret is in this skill (scripts/.env). Move it out of the skill’s folder before sharing — nothing was sent.'
    })
    expect(cinnaSend).not.toHaveBeenCalled()
  })

  it('refuses a skill with an error with the row’s sentence', async () => {
    writeSkill('---\nname: other-name\ndescription: d\n---\n')
    expect(await skillPublishService.publish(USER, { agentId: AGENT_ID, name: 'erp-lookup' })).toMatchObject({
      ok: false,
      code: 'skill_invalid',
      message: 'This skill can’t be shared yet: The name in SKILL.md does not match the folder name.'
    })
    expect(cinnaSend).not.toHaveBeenCalled()
  })

  it('refuses an unknown skill, a bare folder and no account', async () => {
    expect(await skillPublishService.publish(USER, { agentId: AGENT_ID, name: 'nope' })).toMatchObject({ ok: false, code: 'not_found' })
    located.kind = 'external'
    expect(await skillPublishService.publish(USER, { agentId: AGENT_ID, name: 'erp-lookup' })).toMatchObject({ ok: false, code: 'not_kit_agent' })
    located.kind = 'managed'
    account.host = null
    expect(await skillPublishService.publish(USER, { agentId: AGENT_ID, name: 'erp-lookup' })).toMatchObject({ ok: false, code: 'no_account' })
    expect(cinnaSend).not.toHaveBeenCalled()
  })
})

describe('publish: an agent the person may not change', () => {
  function linkToTeamAgent(): void {
    mkdirSync(join(agentDir, 'app-data'), { recursive: true })
    writeFileSync(
      join(agentDir, 'app-data', 'desktop.json'),
      JSON.stringify({ shared_remote: { kind: 'cinna', repo_id: 'r1', clone_url: `${HOST}/git/r1.git` } })
    )
  }

  it('refuses a team agent shared to use only, and one the listing gives no access for, before anything is sent or written', async () => {
    linkToTeamAgent()
    listing.value = { items: [], agents: [{ repoId: 'r1', access: 'use' }] }
    expect(await skillPublishService.publish(USER, { agentId: AGENT_ID, name: 'erp-lookup' })).toEqual({
      ok: false,
      code: 'read_only',
      message: SKILL_PUBLISH_SENTENCES.read_only
    })
    listing.value = { items: [], agents: [] }
    expect(await skillPublishService.publish(USER, { agentId: AGENT_ID, name: 'erp-lookup' })).toMatchObject({
      ok: false,
      code: 'access_unknown'
    })
    expect(cinnaSend).not.toHaveBeenCalled()
    expect(existsSync(join(agentDir, 'publications.json'))).toBe(false)
    expect(readFileSync(join(skillDir(), 'SKILL.md'), 'utf8')).toBe(SKILL_MD)
  })

  it('shares from a team agent the person may edit', async () => {
    linkToTeamAgent()
    listing.value = { items: [], agents: [{ repoId: 'r1', access: 'edit' }] }
    cinnaSend.mockResolvedValueOnce({ status: 200, ok: true, body: revisionBody() })
    cinnaSend.mockResolvedValue({ status: 200, ok: true, body: previewBody() })
    expect(await skillPublishService.publish(USER, { agentId: AGENT_ID, name: 'erp-lookup' })).toMatchObject({ ok: true, revisionNumber: 1 })
    expect(uploads()).toHaveLength(1)
  })
})

describe('publish', () => {
  it('uploads the folder under <name>/ with meta, then writes the version into SKILL.md and the entry into publications.json', async () => {
    cinnaSend.mockResolvedValueOnce({ status: 200, ok: true, body: revisionBody() })
    const outcome = await skillPublishService.publish(USER, {
      agentId: AGENT_ID,
      name: 'erp-lookup',
      releaseNotes: '  First cut  ',
      people: [
        { userId: 'u-ann', access: 'use' },
        { userId: 'u-bob', access: 'maintain' }
      ],
      publisherCredentials: [{ slot: 'erp.example.com', credentialId: 'cred-1' }]
    })
    expect(outcome).toEqual({ ok: true, name: 'erp-lookup', revisionNumber: 1, version: '1.0.0', packageUuid: UUID, packageId: PACKAGE_ID, recorded: true })

    const { meta, archive, contentType } = partsOf(uploads()[0])
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/)
    expect(meta).toEqual({
      release_notes: 'First cut',
      visibility: 'users',
      grants: [
        { principal: { user_id: 'u-ann' }, access: 'use' },
        { principal: { user_id: 'u-bob' }, access: 'maintain' }
      ],
      publisher_credentials: [{ slot: 'erp.example.com', credential_id: 'cred-1' }]
    })
    expect(readSkillArchive(archive, 'erp-lookup').files.map((file) => file.path)).toEqual(['SKILL.md', 'scripts/run.sh'])
    expect(gunzipSync(archive).subarray(0, 11).toString('utf8')).toBe('erp-lookup/')

    // Only the version line was added, beside name.
    expect(readFileSync(join(skillDir(), 'SKILL.md'), 'utf8')).toBe(SKILL_MD.replace('name: erp-lookup\n', 'name: erp-lookup\nversion: 1.0.0\n'))
    expect(publications()).toEqual({
      publications: [],
      skills: [{ platform_url: HOST, name: 'erp-lookup', package_id: PACKAGE_ID, package_uuid: UUID, revision_number: 1, content_hash: 'core-hash' }]
    })
    expect(refresh).toHaveBeenCalled()
    expect(publishEvent).toHaveBeenCalledWith('local-agent:changed', { rootId: 'root-1', agentId: AGENT_ID, reason: 'rescan' })
  })

  it('makes it public with Everyone, naming only the people who may do more than use it', () => {
    expect(
      publishMeta(
        { agentId: AGENT_ID, name: 'erp-lookup', everyone: true, people: [{ userId: 'u-ann', access: 'use' }, { userId: 'u-bob', access: 'edit' }] },
        null
      )
    ).toEqual({ visibility: 'public', grants: [{ principal: { user_id: 'u-bob' }, access: 'edit' }] })
    expect(publishMeta({ agentId: AGENT_ID, name: 'erp-lookup' }, null)).toEqual({})
  })

  it('sends the recorded package and no access changes for a later version', async () => {
    writeFileSync(
      join(agentDir, 'publications.json'),
      JSON.stringify({ publications: [{ platform_url: HOST, agent_id: 'a1' }], skills: [{ platform_url: HOST, name: 'erp-lookup', package_id: PACKAGE_ID, package_uuid: UUID, revision_number: 1, content_hash: 'old' }] })
    )
    cinnaSend.mockResolvedValueOnce({ status: 200, ok: true, body: revisionBody({ revision_number: 2, version: '1.0.1', content_hash: 'new' }) })
    const outcome = await skillPublishService.publish(USER, {
      agentId: AGENT_ID,
      name: 'erp-lookup',
      everyone: true,
      people: [{ userId: 'u-ann', access: 'maintain' }]
    })
    expect(outcome).toMatchObject({ ok: true, revisionNumber: 2, version: '1.0.1' })
    expect(partsOf(uploads()[0]).meta).toEqual({ package_uuid: UUID })
    expect(publications()).toEqual({
      publications: [{ platform_url: HOST, agent_id: 'a1' }],
      skills: [{ platform_url: HOST, name: 'erp-lookup', package_id: PACKAGE_ID, package_uuid: UUID, revision_number: 2, content_hash: 'new' }]
    })
  })

  it('retries once into the person’s own package on package_exists', async () => {
    cinnaSend
      .mockResolvedValueOnce(refusal(409, { code: 'package_exists', message: 'You already publish a skill named …', package_uuid: UUID }))
      .mockResolvedValueOnce({ status: 200, ok: true, body: revisionBody({ revision_number: 4 }) })
    const outcome = await skillPublishService.publish(USER, {
      agentId: AGENT_ID,
      name: 'erp-lookup',
      releaseNotes: 'Again',
      people: [{ userId: 'u-ann', access: 'use' }],
      publisherCredentials: [{ slot: 'erp.example.com', credentialId: 'cred-1' }]
    })
    expect(outcome).toMatchObject({ ok: true, revisionNumber: 4, packageUuid: UUID })
    expect(uploads()).toHaveLength(2)
    expect(partsOf(uploads()[0]).meta).toMatchObject({ visibility: 'users' })
    expect(partsOf(uploads()[0]).meta.package_uuid).toBeUndefined()
    // A later version of an existing package leaves its access alone.
    expect(partsOf(uploads()[1]).meta).toEqual({
      package_uuid: UUID,
      release_notes: 'Again',
      publisher_credentials: [{ slot: 'erp.example.com', credential_id: 'cred-1' }]
    })
    expect((publications().skills as unknown[])[0]).toMatchObject({ package_uuid: UUID, revision_number: 4 })
  })

  it('sends no visibility or grants on the retry, even with Everyone ticked', async () => {
    cinnaSend
      .mockResolvedValueOnce(refusal(409, { code: 'package_exists', message: 'x', package_uuid: UUID }))
      .mockResolvedValueOnce({ status: 200, ok: true, body: revisionBody({ revision_number: 2 }) })
    await skillPublishService.publish(USER, { agentId: AGENT_ID, name: 'erp-lookup', everyone: true, people: [{ userId: 'u-bob', access: 'edit' }] })
    const retried = partsOf(uploads()[1]).meta
    expect(retried).toEqual({ package_uuid: UUID })
    expect('visibility' in retried || 'grants' in retried).toBe(false)
  })

  it('does not retry a second time, nor when the refusal names no package', async () => {
    cinnaSend.mockResolvedValue(refusal(409, { code: 'package_exists', message: 'x' }))
    expect(await skillPublishService.publish(USER, { agentId: AGENT_ID, name: 'erp-lookup' })).toMatchObject({ ok: false, code: 'package_exists' })
    expect(uploads()).toHaveLength(1)
    cinnaSend.mockReset()
    cinnaSend.mockResolvedValue(refusal(409, { code: 'package_exists', message: 'x', package_uuid: UUID }))
    expect(await skillPublishService.publish(USER, { agentId: AGENT_ID, name: 'erp-lookup' })).toMatchObject({ ok: false, code: 'package_exists' })
    expect(uploads()).toHaveLength(2)
    expect(existsSync(join(agentDir, 'publications.json'))).toBe(false)
    expect(readFileSync(join(skillDir(), 'SKILL.md'), 'utf8')).toBe(SKILL_MD)
  })

  it('takes the package id from core’s preview when the listing does not have the package yet', async () => {
    listing.value = { items: [], agents: [] }
    cinnaSend
      .mockResolvedValueOnce({ status: 200, ok: true, body: revisionBody() })
      .mockResolvedValueOnce({ status: 200, ok: true, body: previewBody({ is_republish: true, package_uuid: UUID }) })
    expect(await skillPublishService.publish(USER, { agentId: AGENT_ID, name: 'erp-lookup' })).toMatchObject({ ok: true, packageId: PACKAGE_ID, recorded: true })
    expect((previews()[0][2] as { json: Record<string, unknown> }).json.package_uuid).toBe(UUID)
  })
})

describe('catalogRefusal: every code core answers, as a sentence', () => {
  const cases: [number, Record<string, unknown>, string, string][] = [
    [413, { code: 'skill_too_large', message: 'x' }, 'too_large', SKILL_PUBLISH_SENTENCES.too_large],
    [422, { code: 'skill_too_large', message: 'x' }, 'too_large', SKILL_PUBLISH_SENTENCES.too_large],
    [400, { code: 'skill_archive_invalid', message: 'This skill archive cannot be used: it is empty.' }, 'skill_archive_invalid', 'The catalog could not unpack this skill: it is empty.'],
    [422, { code: 'skill_invalid', message: 'This skill cannot be published: SKILL.md has no description.' }, 'skill_invalid', 'This skill cannot be published: SKILL.md has no description.'],
    [422, { code: 'skill_contains_secrets', message: 'x', paths: ['a/.env', 'b.pem'] }, 'skill_contains_secrets', 'The catalog refused files that look like credentials (a/.env, b.pem). Remove them from the skill and share again.'],
    [422, { code: 'invalid_publisher_credential', message: 'Only the person who first shared this skill can provide credentials for it.' }, 'invalid_publisher_credential', 'Only the person who first shared this skill can provide credentials for it.'],
    [409, { code: 'skill_name_mismatch', message: 'x' }, 'skill_name_mismatch', SKILL_PUBLISH_SENTENCES.skill_name_mismatch],
    [409, { code: 'package_exists', message: 'x' }, 'package_exists', SKILL_PUBLISH_SENTENCES.package_exists],
    [409, { code: 'grants_require_users_visibility', message: 'x' }, 'grants_require_users_visibility', SKILL_PUBLISH_SENTENCES.grants_require_users_visibility],
    [403, { code: 'not_publisher', message: 'x' }, 'not_publisher', SKILL_PUBLISH_SENTENCES.not_publisher],
    [404, { code: 'package_not_found', message: 'x' }, 'package_not_found', SKILL_PUBLISH_SENTENCES.package_not_found],
    [409, { code: 'invalid_grants', message: 'A maintainer must be a person.' }, 'invalid_grants', 'The catalog did not accept that list of people: A maintainer must be a person.'],
    [500, { code: 'boom', message: 'Internal error' }, 'failed', 'The skill couldn’t be shared: Internal error']
  ]
  it.each(cases)('%i %o → %s', (status, detail, code, message) => {
    expect(catalogRefusal(status, { detail })).toMatchObject({ ok: false, code, message })
  })

  it('carries the package of package_exists, and reads a bare 403 / 422 list', () => {
    expect(catalogRefusal(409, { detail: { code: 'package_exists', package_uuid: UUID } }).packageUuid).toBe(UUID)
    expect(catalogRefusal(403, { detail: 'Forbidden' })).toMatchObject({ code: 'not_publisher' })
    expect(catalogRefusal(422, { detail: [{ loc: ['meta'] }] })).toMatchObject({ code: 'failed', message: 'The skill couldn’t be shared: the request was not accepted' })
  })
})

describe('withSkillPublications', () => {
  const dto = (skills: Record<string, unknown>[]) => ({ path: agentDir, skills }) as unknown as Parameters<typeof withSkillPublications>[0]
  const row = (over: Record<string, unknown> = {}) => ({ name: 'erp-lookup', source: 'authored', deliverable: true, issues: [], ...over })

  it('offers Share on a deliverable own skill while an account is active', () => {
    expect(withSkillPublications(dto([row()])).skills?.[0]).toMatchObject({ shared: null, shareable: true })
    expect(withSkillPublications(dto([row({ deliverable: false })])).skills?.[0]).toMatchObject({ shareable: false })
    account.host = null
    expect(withSkillPublications(dto([row()])).skills?.[0]).toMatchObject({ shared: null, shareable: false })
  })

  it('says where it was shared, and offers a new version only with edit or maintain on the package', () => {
    writeFileSync(
      join(agentDir, 'publications.json'),
      JSON.stringify({ publications: [], skills: [{ platform_url: HOST, name: 'erp-lookup', package_id: PACKAGE_ID, package_uuid: UUID, revision_number: 3, content_hash: 'x' }] })
    )
    expect(withSkillPublications(dto([row()])).skills?.[0]).toMatchObject({
      shared: { packageUuid: UUID, packageId: PACKAGE_ID, revisionNumber: 3 },
      shareable: true
    })
    listing.value = { items: [{ kind: 'skill', uuid: UUID, id: PACKAGE_ID, access: 'use' }], agents: [] }
    expect(withSkillPublications(dto([row()])).skills?.[0]).toMatchObject({ shareable: false })
    listing.value = { items: [], agents: [] }
    expect(withSkillPublications(dto([row()])).skills?.[0]).toMatchObject({ shareable: false })
    // Another server's entry is not this account's share.
    account.host = 'https://other.test'
    expect(withSkillPublications(dto([row()])).skills?.[0]).toMatchObject({ shared: null, shareable: true })
  })

  it('offers no Share in a team agent the person may only use', () => {
    mkdirSync(join(agentDir, 'app-data'), { recursive: true })
    writeFileSync(
      join(agentDir, 'app-data', 'desktop.json'),
      JSON.stringify({ shared_remote: { kind: 'cinna', repo_id: 'r1', clone_url: `${HOST}/git/r1.git` } })
    )
    listing.value = { items: [], agents: [{ repoId: 'r1', access: 'use' }] }
    expect(withSkillPublications(dto([row()])).skills?.[0]).toMatchObject({ shared: null, shareable: false })
    // Not in the listing: as main's other verbs, not changeable.
    listing.value = { items: [], agents: [] }
    expect(withSkillPublications(dto([row()])).skills?.[0]).toMatchObject({ shareable: false })
    listing.value = { items: [], agents: [{ repoId: 'r1', access: 'edit' }] }
    expect(withSkillPublications(dto([row()])).skills?.[0]).toMatchObject({ shareable: true })
  })

  it('leaves catalog rows alone', () => {
    const catalogRow = { name: 'x', source: 'catalog', deliverable: true, issues: [] }
    expect(withSkillPublications(dto([catalogRow])).skills?.[0]).toBe(catalogRow)
  })
})
