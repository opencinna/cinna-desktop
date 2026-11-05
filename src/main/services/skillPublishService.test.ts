import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
/** Revision downloads (Get Version N), through the catalog skill cache. */
const cinnaFetchBytes = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>())
const host = vi.hoisted(() => ({ userData: '' }))
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
vi.mock('./cinna-http', () => ({ cinnaSend, cinnaFetchBytes }))
vi.mock('../host/runtimeHost', () => ({ runtimeHost: { getPath: () => host.userData } }))
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

const { skillPublishService, catalogRefusal, publishMeta, SKILL_PUBLISH_SENTENCES, withPreviousProviders, toPreviewDto, moveTree, MoveTreeIncomplete } = await import('./skillPublishService')
const { withSkillPublications, _resetSkillHashes } = await import('./skillPublications')
const { readSkillArchive } = await import('../kit/skillArchive')
const { catalogSkillCache, removeTree } = await import('./catalogSkillCache')
const { collectSkillTree, skillTreeHash } = await import('../kit/skillPack')

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
  host.userData = join(root, 'userData')
  cinnaFetchBytes.mockReset()
  catalogSkillCache._reset()
  _resetSkillHashes()
  account.host = HOST
  listing.value = { items: [{ kind: 'skill', uuid: UUID, id: PACKAGE_ID, access: 'maintain' }], agents: [] }
  self.id = 'u-me'
  cinnaSend.mockReset()
  // A queued answer a test left unused must not reach the next one.
  refresh.mockReset()
  refresh.mockImplementation(async () => listing.value)
  publishEvent.mockClear()
})

afterEach(() => {
  // A test may leave a folder read-only to make a write fail.
  try {
    chmodSync(agentDir, 0o755)
  } catch {
    /* gone */
  }
  removeTree(root)
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
        providersCarried: true,
        editablePackages: [],
        stale: null
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
      message: 'This skill can’t be published yet: SKILL.md frontmatter has no description.'
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
      message: 'A file that can hold a secret is in this skill (scripts/.env). Move it out of the skill’s folder before publishing — nothing was sent.'
    })
    expect(cinnaSend).not.toHaveBeenCalled()
  })

  it('refuses a skill with an error with the row’s sentence', async () => {
    writeSkill('---\nname: other-name\ndescription: d\n---\n')
    expect(await skillPublishService.publish(USER, { agentId: AGENT_ID, name: 'erp-lookup' })).toMatchObject({
      ok: false,
      code: 'skill_invalid',
      message: 'This skill can’t be published yet: The name in SKILL.md does not match the folder name.'
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
    // The version the folder holds travels as the base core checks the share against (S5).
    expect(partsOf(uploads()[0]).meta).toEqual({ package_uuid: UUID, base_revision_number: 1 })
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
    [422, { code: 'skill_contains_secrets', message: 'x', paths: ['a/.env', 'b.pem'] }, 'skill_contains_secrets', 'The catalog refused files that look like credentials (a/.env, b.pem). Remove them from the skill and publish again.'],
    [422, { code: 'invalid_publisher_credential', message: 'Only the person who first shared this skill can provide credentials for it.' }, 'invalid_publisher_credential', 'Only the person who first shared this skill can provide credentials for it.'],
    [409, { code: 'skill_name_mismatch', message: 'x' }, 'skill_name_mismatch', SKILL_PUBLISH_SENTENCES.skill_name_mismatch],
    [409, { code: 'package_exists', message: 'x' }, 'package_exists', SKILL_PUBLISH_SENTENCES.package_exists],
    [409, { code: 'grants_require_users_visibility', message: 'x' }, 'grants_require_users_visibility', SKILL_PUBLISH_SENTENCES.grants_require_users_visibility],
    [403, { code: 'not_publisher', message: 'x' }, 'not_publisher', SKILL_PUBLISH_SENTENCES.not_publisher],
    [404, { code: 'package_not_found', message: 'x' }, 'package_not_found', SKILL_PUBLISH_SENTENCES.package_not_found],
    [409, { code: 'invalid_grants', message: 'A maintainer must be a person.' }, 'invalid_grants', 'The catalog did not accept that list of people: A maintainer must be a person.'],
    [500, { code: 'boom', message: 'Internal error' }, 'failed', 'The skill couldn’t be published: Internal error']
  ]
  it.each(cases)('%i %o → %s', (status, detail, code, message) => {
    expect(catalogRefusal(status, { detail })).toMatchObject({ ok: false, code, message })
  })

  it('carries the package of package_exists, and reads a bare 403 / 422 list', () => {
    expect(catalogRefusal(409, { detail: { code: 'package_exists', package_uuid: UUID } }).packageUuid).toBe(UUID)
    expect(catalogRefusal(403, { detail: 'Forbidden' })).toMatchObject({ code: 'not_publisher' })
    expect(catalogRefusal(422, { detail: [{ loc: ['meta'] }] })).toMatchObject({ code: 'failed', message: 'The skill couldn’t be published: the request was not accepted' })
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
    expect(withSkillPublications(dto([row()])).skills?.[0]).toMatchObject({ shareable: false, shared: { access: 'use' } })
    listing.value = { items: [{ kind: 'skill', uuid: UUID.toUpperCase(), id: PACKAGE_ID, access: 'maintain' }], agents: [] }
    expect(withSkillPublications(dto([row()])).skills?.[0]).toMatchObject({ shareable: true, shared: { access: 'maintain' } })
    listing.value = { items: [], agents: [] }
    expect(withSkillPublications(dto([row()])).skills?.[0]).toMatchObject({ shareable: false, shared: { access: null } })
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

/* ------------------------------------------------ skill co-maintainers D3/D4 */

/** The folder's tree hash as core computes it over `skills/<name>/`. */
function folderHash(): string {
  const tree = collectSkillTree(skillDir())
  if (!tree.ok) throw new Error('unreadable skill')
  return skillTreeHash('erp-lookup', tree.tree.files)
}

/** The tree hash core reports for an archive (O2: what the copy on disk hashes to). */
function archiveHash(archive: Buffer): string {
  return skillTreeHash('erp-lookup', readSkillArchive(archive, 'erp-lookup').files)
}

const sha256 = async (bytes: Buffer): Promise<string> => (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex')

/** Record the folder as it is now as Version `revision` of the package. */
function link(revision: number, contentHash = folderHash()): void {
  writeFileSync(
    join(agentDir, 'publications.json'),
    `${JSON.stringify({ publications: [{ kept: true }], skills: [{ platform_url: HOST, name: 'erp-lookup', package_id: PACKAGE_ID, package_uuid: UUID, revision_number: revision, content_hash: contentHash }] })}\n`
  )
}

const V2 = Buffer.from(
  (await import('../kit/testSupport/skillTar')).tgzOf([
    { name: 'erp-lookup/SKILL.md', body: '---\nname: erp-lookup\ndescription: Second.\nversion: 1.0.1\n---\n\nBody two.\n' },
    { name: 'erp-lookup/scripts/run.sh', body: '#!/bin/sh\necho two\n', mode: 0o755 }
  ])
)

/** The listing row of the package at `revision`, with the archive's digest and (unless told) its content hash. */
async function listAt(revision: number, archive: Buffer, over: Record<string, unknown> = {}): Promise<void> {
  listing.value = {
    items: [
      {
        kind: 'skill',
        uuid: UUID,
        id: PACKAGE_ID,
        name: 'erp-lookup',
        access: 'edit',
        latest: {
          revision_number: revision,
          version: '1.0.1',
          published_at: '',
          published_by: { user_id: 'u-ann', display_name: 'Ann' },
          release_notes: null,
          content_hash: archiveHash(archive),
          ...over
        },
        skill: { frontmatter: {}, archive_sha256: await sha256(archive), size_bytes: archive.length }
      }
    ],
    agents: []
  }
}

/** The server: `archive` for every revision, with its digest. */
async function serveArchive(archive: Buffer): Promise<void> {
  const digest = await sha256(archive)
  cinnaFetchBytes.mockResolvedValue({ ok: true, bytes: archive, headers: new Headers({ 'X-Content-SHA256': digest }) })
}

const record = (): Record<string, unknown> => (publications().skills as Record<string, unknown>[])[0]
const skillsListing = (): string[] => readdirSync(join(agentDir, 'skills')).sort()

describe('the sync state of a linked skill (co-maintainers D3)', () => {
  const dto = () => ({ path: agentDir, skills: [{ name: 'erp-lookup', source: 'authored', deliverable: true, issues: [] }] }) as unknown as Parameters<typeof withSkillPublications>[0]
  const stateOf = () => {
    const row = withSkillPublications(dto()).skills?.[0] as { sync?: string; latest?: unknown }
    return { sync: row.sync, latest: row.latest }
  }

  it('reads in_sync, changed, behind, diverged and unknown from the folder and the listing alone', async () => {
    link(2)
    await listAt(2, V2)
    expect(stateOf()).toEqual({ sync: 'in_sync', latest: { revisionNumber: 2, version: '1.0.1', publishedBy: 'Ann' } })

    // A Finder .DS_Store is not a change: it is neither packed nor hashed.
    writeFileSync(join(skillDir(), '.DS_Store'), 'finder')
    writeFileSync(join(skillDir(), 'scripts', '.DS_Store'), 'finder')
    expect(stateOf().sync).toBe('in_sync')

    await listAt(3, V2)
    expect(stateOf()).toMatchObject({ sync: 'behind', latest: { revisionNumber: 3 } })

    writeFileSync(join(skillDir(), 'scripts', 'run.sh'), '#!/bin/sh\necho edited\n')
    expect(stateOf().sync).toBe('diverged')
    await listAt(2, V2)
    expect(stateOf().sync).toBe('changed')

    // Not in the listing: unknown, and no latest.
    listing.value = { items: [], agents: [] }
    expect(stateOf()).toEqual({ sync: 'unknown', latest: null })
    // A folder that cannot be hashed (a secret-looking file): unknown, with the latest still said.
    await listAt(3, V2)
    writeFileSync(join(skillDir(), '.env'), 'TOKEN=x')
    expect(stateOf()).toMatchObject({ sync: 'unknown', latest: { revisionNumber: 3 } })
  })

  it('sees a change made after a read (the cached hash follows the tree), and sets nothing on an unlinked row', async () => {
    link(1)
    await listAt(1, V2)
    expect(stateOf().sync).toBe('in_sync')
    writeFileSync(join(skillDir(), 'notes.md'), 'new file')
    expect(stateOf().sync).toBe('changed')
    rmSync(join(skillDir(), 'notes.md'))
    expect(stateOf().sync).toBe('in_sync')
    rmSync(join(agentDir, 'publications.json'))
    const row = withSkillPublications(dto()).skills?.[0] as unknown as Record<string, unknown>
    expect(row).not.toHaveProperty('sync')
    expect(row).not.toHaveProperty('latest')
  })
})

describe('Get Version N (co-maintainers D3)', () => {
  it('replaces an unchanged folder with the latest version, writable, and records it', async () => {
    link(1)
    await listAt(2, V2)
    await serveArchive(V2)
    const outcome = await skillPublishService.getLatest(USER, AGENT_ID, 'erp-lookup')
    expect(outcome).toEqual({ ok: true, name: 'erp-lookup', revisionNumber: 2, version: '1.0.1', backupPath: null })
    expect(cinnaFetchBytes.mock.calls.map((call) => call[1])).toEqual([`/api/v1/skills/packages/${UUID}/revisions/2/download`])

    expect(readFileSync(join(skillDir(), 'SKILL.md'), 'utf8')).toContain('description: Second.')
    expect(statSync(skillDir()).mode & 0o777).toBe(0o755)
    expect(statSync(join(skillDir(), 'SKILL.md')).mode & 0o777).toBe(0o644)
    expect(statSync(join(skillDir(), 'scripts', 'run.sh')).mode & 0o777).toBe(0o755)
    // Nothing staged or set aside is left beside it.
    expect(skillsListing()).toEqual(['erp-lookup'])
    expect(publications()).toEqual({
      publications: [{ kept: true }],
      skills: [{ platform_url: HOST, name: 'erp-lookup', package_id: PACKAGE_ID, package_uuid: UUID, revision_number: 2, content_hash: archiveHash(V2) }]
    })
    expect(folderHash()).toBe(archiveHash(V2))
    expect(publishEvent).toHaveBeenCalledWith('local-agent:changed', { rootId: 'root-1', agentId: AGENT_ID, reason: 'rescan' })
  })

  it('reads the listing fresh, so a version core knows and the cached listing does not is got', async () => {
    link(1)
    await listAt(1, V2)
    const cachedListing = listing.value
    await listAt(2, V2)
    refresh.mockResolvedValueOnce(listing.value)
    listing.value = cachedListing
    await serveArchive(V2)
    expect(await skillPublishService.getLatest(USER, AGENT_ID, 'erp-lookup')).toMatchObject({ ok: true, revisionNumber: 2 })
    expect(record()).toMatchObject({ revision_number: 2 })
  })

  it('refuses unshared changes without replace, and a folder already at the latest, touching nothing', async () => {
    link(1)
    writeFileSync(join(skillDir(), 'scripts', 'run.sh'), '#!/bin/sh\necho mine\n')
    await listAt(2, V2)
    await serveArchive(V2)
    const ledger = readFileSync(join(agentDir, 'publications.json'), 'utf8')
    expect(await skillPublishService.getLatest(USER, AGENT_ID, 'erp-lookup')).toEqual({
      ok: false,
      code: 'has_changes',
      message: SKILL_PUBLISH_SENTENCES.has_changes
    })
    expect(readFileSync(join(skillDir(), 'scripts', 'run.sh'), 'utf8')).toBe('#!/bin/sh\necho mine\n')
    expect(readFileSync(join(agentDir, 'publications.json'), 'utf8')).toBe(ledger)
    expect(cinnaFetchBytes).not.toHaveBeenCalled()

    // changed (no newer version) and in_sync: nothing to get.
    await listAt(1, V2)
    expect(await skillPublishService.getLatest(USER, AGENT_ID, 'erp-lookup', { replace: true })).toMatchObject({ ok: false, code: 'up_to_date' })
    link(1)
    expect(await skillPublishService.getLatest(USER, AGENT_ID, 'erp-lookup')).toMatchObject({ ok: false, code: 'up_to_date' })
    expect(cinnaFetchBytes).not.toHaveBeenCalled()
    expect(skillsListing()).toEqual(['erp-lookup'])
  })

  it('refuses a skill with no record, one not in the listing, and an agent the person may not change', async () => {
    await listAt(2, V2)
    expect(await skillPublishService.getLatest(USER, AGENT_ID, 'erp-lookup')).toMatchObject({ ok: false, code: 'not_linked' })
    link(1)
    listing.value = { items: [], agents: [] }
    expect(await skillPublishService.getLatest(USER, AGENT_ID, 'erp-lookup')).toMatchObject({ ok: false, code: 'package_not_found' })
    mkdirSync(join(agentDir, 'app-data'), { recursive: true })
    writeFileSync(join(agentDir, 'app-data', 'desktop.json'), JSON.stringify({ shared_remote: { kind: 'cinna', repo_id: 'r1', clone_url: `${HOST}/git/r1.git` } }))
    await listAt(2, V2)
    listing.value!.agents = [{ repoId: 'r1', access: 'use' }]
    expect(await skillPublishService.getLatest(USER, AGENT_ID, 'erp-lookup')).toMatchObject({ ok: false, code: 'read_only' })
    expect(cinnaFetchBytes).not.toHaveBeenCalled()
  })

  it('with replace, keeps the edited folder in a backup outside the agent and brings the latest in', async () => {
    link(1)
    writeFileSync(join(skillDir(), 'scripts', 'run.sh'), '#!/bin/sh\necho mine\n')
    await listAt(2, V2)
    await serveArchive(V2)
    const outcome = await skillPublishService.getLatest(USER, AGENT_ID, 'erp-lookup', { replace: true })
    expect(outcome).toMatchObject({ ok: true, revisionNumber: 2 })
    const backup = (outcome as { backupPath: string }).backupPath
    expect(backup.startsWith(join(host.userData, 'skill-backups', 'folder-11111111-2222-4333-8444-555566667777', 'erp-lookup-'))).toBe(true)
    expect(readFileSync(join(backup, 'scripts', 'run.sh'), 'utf8')).toBe('#!/bin/sh\necho mine\n')
    expect(readFileSync(join(backup, 'SKILL.md'), 'utf8')).toBe(SKILL_MD)
    expect(readFileSync(join(skillDir(), 'scripts', 'run.sh'), 'utf8')).toBe('#!/bin/sh\necho two\n')
    expect(skillsListing()).toEqual(['erp-lookup'])
    expect(record()).toMatchObject({ revision_number: 2, content_hash: archiveHash(V2) })
  })

  it('touches nothing when the copy does not hash to the listing’s content hash', async () => {
    link(1)
    await listAt(2, V2, { content_hash: 'a'.repeat(64) })
    await serveArchive(V2)
    const ledger = readFileSync(join(agentDir, 'publications.json'), 'utf8')
    expect(await skillPublishService.getLatest(USER, AGENT_ID, 'erp-lookup')).toMatchObject({ ok: false, code: 'download_mismatch' })
    expect(readFileSync(join(skillDir(), 'SKILL.md'), 'utf8')).toBe(SKILL_MD)
    expect(readFileSync(join(agentDir, 'publications.json'), 'utf8')).toBe(ledger)
    expect(skillsListing()).toEqual(['erp-lookup'])
  })

  it('puts the old folder and the record back when the record cannot be written after the swap', async () => {
    link(1)
    await listAt(2, V2)
    await serveArchive(V2)
    const ledger = readFileSync(join(agentDir, 'publications.json'), 'utf8')
    // skills/ stays writable, so the swap happens; the agent folder does not, so publications.json cannot be written.
    chmodSync(agentDir, 0o555)
    const outcome = await skillPublishService.getLatest(USER, AGENT_ID, 'erp-lookup')
    chmodSync(agentDir, 0o755)
    expect(outcome).toEqual({ ok: false, code: 'write_failed', message: SKILL_PUBLISH_SENTENCES.write_failed })
    expect(readFileSync(join(skillDir(), 'SKILL.md'), 'utf8')).toBe(SKILL_MD)
    expect(readFileSync(join(skillDir(), 'scripts', 'run.sh'), 'utf8')).toBe('#!/bin/sh\n')
    expect(readFileSync(join(agentDir, 'publications.json'), 'utf8')).toBe(ledger)
    expect(skillsListing()).toEqual(['erp-lookup'])
  })
})

describe('the Share dialog’s guards in main (co-maintainers D4)', () => {
  it('publishMeta sends the recorded version as the base, and new_package only on a first share', () => {
    expect(publishMeta({ agentId: AGENT_ID, name: 'erp-lookup' }, UUID, 3)).toEqual({ package_uuid: UUID, base_revision_number: 3 })
    expect(publishMeta({ agentId: AGENT_ID, name: 'erp-lookup' }, null, 3)).toEqual({})
    expect(publishMeta({ agentId: AGENT_ID, name: 'erp-lookup', newPackage: true, everyone: true }, null)).toEqual({ new_package: true, visibility: 'public' })
    expect(publishMeta({ agentId: AGENT_ID, name: 'erp-lookup', newPackage: true }, UUID, 2)).toEqual({ package_uuid: UUID, base_revision_number: 2 })
  })

  it('previews a recorded skill with its base, and reads stale and the editable packages', async () => {
    link(2, 'x')
    cinnaSend.mockResolvedValue({
      status: 200,
      ok: true,
      body: previewBody({
        is_republish: true,
        package_uuid: UUID,
        next_revision_number: 4,
        stale: true,
        latest_revision_number: 3,
        latest_version: '1.0.2',
        latest_published_by: { user_id: 'u-ann', display_name: 'Ann' }
      })
    })
    const outcome = await skillPublishService.preview(USER, AGENT_ID, 'erp-lookup')
    expect((previews()[0][2] as { json: Record<string, unknown> }).json).toMatchObject({ package_uuid: UUID, base_revision_number: 2 })
    expect(outcome).toMatchObject({ ok: true, preview: { stale: { latestRevision: 3, version: '1.0.2', publishedBy: 'Ann' }, editablePackages: [] } })

    const first = toPreviewDto(
      'erp-lookup',
      previewBody({
        stale: null,
        editable_packages: [
          { package_uuid: UUID, package_id: PACKAGE_ID, publisher: { user_id: 'u-ann', display_name: 'Ann' }, access: 'edit', latest_revision_number: 2, latest_version: '1.0.1' },
          { package_id: 'no-uuid' }
        ]
      })
    )
    expect(first).toMatchObject({
      stale: null,
      editablePackages: [{ packageUuid: UUID, packageId: PACKAGE_ID, publisher: 'Ann', access: 'edit', latestRevisionNumber: 2, latestVersion: '1.0.1' }]
    })
  })

  it('answers a stale share as `stale` with who shared which version, and writes nothing', async () => {
    link(1, 'x')
    const ledger = readFileSync(join(agentDir, 'publications.json'), 'utf8')
    cinnaSend.mockResolvedValue(
      refusal(409, {
        code: 'stale_base',
        message: 'Ann published Version 2 since your copy. Get it first, then publish your changes.',
        latest_revision_number: 2,
        latest_version: '1.0.1',
        published_by: { user_id: 'u-ann', display_name: 'Ann' }
      })
    )
    expect(await skillPublishService.publish(USER, { agentId: AGENT_ID, name: 'erp-lookup', releaseNotes: 'Mine' })).toEqual({
      ok: false,
      code: 'stale',
      message: 'Ann published Version 2 since your copy. Get it first, then publish your changes.',
      stale: { latestRevision: 2, version: '1.0.1', publishedBy: 'Ann' }
    })
    expect(partsOf(uploads()[0]).meta).toEqual({ package_uuid: UUID, base_revision_number: 1, release_notes: 'Mine' })
    expect(uploads()).toHaveLength(1)
    expect(readFileSync(join(skillDir(), 'SKILL.md'), 'utf8')).toBe(SKILL_MD)
    expect(readFileSync(join(agentDir, 'publications.json'), 'utf8')).toBe(ledger)
  })

  it('shares as the next version of a chosen editable package: its uuid and base, no access or provided credentials', async () => {
    cinnaSend.mockResolvedValueOnce({ status: 200, ok: true, body: revisionBody({ revision_number: 3, version: '1.0.2', content_hash: 'core-hash-3' }) })
    const outcome = await skillPublishService.publish(USER, {
      agentId: AGENT_ID,
      name: 'erp-lookup',
      releaseNotes: 'From B',
      packageUuid: UUID,
      baseRevisionNumber: 2,
      everyone: true,
      people: [{ userId: 'u-bob', access: 'maintain' }],
      publisherCredentials: [{ slot: 'erp.example.com', credentialId: 'cred-1' }]
    })
    expect(outcome).toMatchObject({ ok: true, revisionNumber: 3, packageUuid: UUID })
    expect(partsOf(uploads()[0]).meta).toEqual({ package_uuid: UUID, base_revision_number: 2, release_notes: 'From B' })
    // Recorded with core's content hash (O1), as on any share.
    expect(record()).toMatchObject({ package_uuid: UUID, revision_number: 3, content_hash: 'core-hash-3' })
  })

  it('shares as a separate skill with new_package, and answers editable_package_exists with its candidates', async () => {
    cinnaSend.mockResolvedValueOnce(
      refusal(409, {
        code: 'editable_package_exists',
        message: "You can edit Ann's skill 'erp-lookup'. Share this as a new version of it, or as a separate skill.",
        candidates: [{ package_uuid: UUID, package_id: PACKAGE_ID, publisher: { user_id: 'u-ann', display_name: 'Ann' }, access: 'edit', latest_revision_number: 2, latest_version: '1.0.1' }]
      })
    )
    expect(await skillPublishService.publish(USER, { agentId: AGENT_ID, name: 'erp-lookup' })).toEqual({
      ok: false,
      code: 'editable_package_exists',
      message: "You can edit Ann's skill 'erp-lookup'. Share this as a new version of it, or as a separate skill.",
      candidates: [{ packageUuid: UUID, packageId: PACKAGE_ID, publisher: 'Ann', access: 'edit', latestRevisionNumber: 2, latestVersion: '1.0.1' }]
    })
    expect(existsSync(join(agentDir, 'publications.json'))).toBe(false)

    cinnaSend.mockResolvedValueOnce({ status: 200, ok: true, body: revisionBody() })
    await skillPublishService.publish(USER, { agentId: AGENT_ID, name: 'erp-lookup', newPackage: true, people: [{ userId: 'u-ann', access: 'use' }] })
    expect(partsOf(uploads()[1]).meta).toEqual({ new_package: true, visibility: 'users', grants: [{ principal: { user_id: 'u-ann' }, access: 'use' }] })
  })
})

describe('Get Version N: what can change while it runs (co-maintainers fix round)', () => {
  it('refuses with has_changes, edit intact, when the folder is edited during the download', async () => {
    link(1)
    await listAt(2, V2)
    const digest = await sha256(V2)
    const ledger = readFileSync(join(agentDir, 'publications.json'), 'utf8')
    cinnaFetchBytes.mockImplementation(async () => {
      writeFileSync(join(skillDir(), 'scripts', 'run.sh'), '#!/bin/sh\necho typed meanwhile\n')
      return { ok: true, bytes: V2, headers: new Headers({ 'X-Content-SHA256': digest }) }
    })
    expect(await skillPublishService.getLatest(USER, AGENT_ID, 'erp-lookup')).toEqual({
      ok: false,
      code: 'has_changes',
      message: SKILL_PUBLISH_SENTENCES.has_changes
    })
    expect(cinnaFetchBytes).toHaveBeenCalledTimes(1)
    expect(readFileSync(join(skillDir(), 'scripts', 'run.sh'), 'utf8')).toBe('#!/bin/sh\necho typed meanwhile\n')
    expect(readFileSync(join(agentDir, 'publications.json'), 'utf8')).toBe(ledger)
    expect(skillsListing()).toEqual(['erp-lookup'])
  })

  it('with replace, an edit made during the download goes to the backup', async () => {
    link(1)
    await listAt(2, V2)
    const digest = await sha256(V2)
    cinnaFetchBytes.mockImplementation(async () => {
      writeFileSync(join(skillDir(), 'scripts', 'run.sh'), '#!/bin/sh\necho typed meanwhile\n')
      return { ok: true, bytes: V2, headers: new Headers({ 'X-Content-SHA256': digest }) }
    })
    const outcome = await skillPublishService.getLatest(USER, AGENT_ID, 'erp-lookup', { replace: true })
    expect(outcome).toMatchObject({ ok: true, revisionNumber: 2 })
    expect(readFileSync(join((outcome as { backupPath: string }).backupPath, 'scripts', 'run.sh'), 'utf8')).toBe('#!/bin/sh\necho typed meanwhile\n')
  })

  it('puts back a folder a crash left set aside before it runs, and removes stale staged copies', async () => {
    link(1)
    await listAt(2, V2)
    await serveArchive(V2)
    const skills = join(agentDir, 'skills')
    const old = Date.now() - 60 * 60 * 1000
    // The crash: skills/erp-lookup/ moved aside, the staged copy never renamed in.
    const { renameSync } = await import('node:fs')
    renameSync(skillDir(), join(skills, `.erp-lookup.cinna-previous-1-${old}`))
    mkdirSync(join(skills, `.erp-lookup.cinna-staging-1-${old}`))
    // A staged copy of a swap that may still be running (another instance) is left alone.
    mkdirSync(join(skills, `.erp-lookup.cinna-staging-2-${Date.now()}`))
    expect(await skillPublishService.getLatest(USER, AGENT_ID, 'erp-lookup')).toMatchObject({ ok: true, revisionNumber: 2 })
    expect(readFileSync(join(skillDir(), 'scripts', 'run.sh'), 'utf8')).toBe('#!/bin/sh\necho two\n')
    expect(skillsListing().filter((entry) => entry.includes('cinna-previous') || entry.includes(`staging-1-`))).toEqual([])
    expect(skillsListing().filter((entry) => entry.includes('staging-2-'))).toHaveLength(1)
  })
})

describe('moveTree across volumes', () => {
  const exdev = (): never => {
    throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' })
  }
  const real = {
    copy: (from: string, to: string, overwrite: boolean) => cpSync(from, to, { recursive: true, errorOnExist: !overwrite, force: overwrite }),
    remove: (path: string) => rmSync(path, { recursive: true, force: true })
  }

  it('fills the source back from the copy when the source cannot be removed, and throws', () => {
    const from = skillDir()
    const to = join(root, 'elsewhere', 'erp-lookup')
    mkdirSync(join(root, 'elsewhere'))
    const ops = {
      rename: exdev,
      copy: real.copy,
      remove: (path: string) => {
        if (path === from) {
          // Half removed, then refused.
          rmSync(join(from, 'scripts'), { recursive: true, force: true })
          throw new Error('EACCES')
        }
        real.remove(path)
      }
    }
    expect(() => moveTree(from, to, ops)).toThrow('EACCES')
    expect(readFileSync(join(from, 'scripts', 'run.sh'), 'utf8')).toBe('#!/bin/sh\n')
    expect(readFileSync(join(from, 'SKILL.md'), 'utf8')).toBe(SKILL_MD)
    expect(existsSync(to)).toBe(false)
  })

  it('names the full copy when the source can be neither removed nor filled back', () => {
    const from = skillDir()
    const to = join(root, 'elsewhere', 'erp-lookup')
    mkdirSync(join(root, 'elsewhere'))
    let copies = 0
    const ops = {
      rename: exdev,
      copy: (a: string, b: string, overwrite: boolean) => {
        copies += 1
        if (copies > 1) throw new Error('EROFS')
        real.copy(a, b, overwrite)
      },
      remove: (path: string) => {
        if (path === from) throw new Error('EACCES')
        real.remove(path)
      }
    }
    let thrown: unknown
    try {
      moveTree(from, to, ops)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(MoveTreeIncomplete)
    expect((thrown as InstanceType<typeof MoveTreeIncomplete>).copyAt).toBe(to)
    expect(readFileSync(join(to, 'scripts', 'run.sh'), 'utf8')).toBe('#!/bin/sh\n')
  })

  it('moves by copy and removal when rename crosses volumes', () => {
    const from = skillDir()
    const to = join(root, 'elsewhere', 'erp-lookup')
    mkdirSync(join(root, 'elsewhere'))
    moveTree(from, to, { rename: exdev, ...real })
    expect(existsSync(from)).toBe(false)
    expect(readFileSync(join(to, 'SKILL.md'), 'utf8')).toBe(SKILL_MD)
  })
})
