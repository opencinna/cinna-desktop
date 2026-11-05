import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'

/**
 * A loopback cinna-core for catalog skills, model-free: the discovery document
 * a Cinna profile needs (`/.well-known/cinna-desktop`, with the three auth
 * endpoints, else main refuses it), the unified listing
 * `GET /api/v1/catalog/items`, one item's detail, and the revision archive
 * `catalogSkillService.fetchRevision` downloads
 * (`GET /api/v1/skills/packages/{uuid}/revisions/{n}/download`, a gzip ustar
 * under `skills/<name>/` whose sha256 is both the `X-Content-SHA256` header and
 * the listing's `skill.archive_sha256`).
 *
 * The profile is made a signed-in Cinna account against it with
 * `linkSandboxAccount(cinna, core.host)` (`jobRemoteService.ts`).
 *
 * The listing can be **held** (`holdListing(true)`, answered by `released()`)
 * to keep a lookup pending, or **dropped** (`dropListing(true)`: the socket is
 * destroyed with no answer) to make the server unreachable for that one route.
 */

/* ------------------------------------------------------------- archives */

function tarHeader(path: string, type: '0' | '5', size: number, mode: number): Buffer {
  const header = Buffer.alloc(512)
  header.write(path, 0, 100, 'utf8')
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii')
  header.write('0000000\0', 108, 8, 'ascii')
  header.write('0000000\0', 116, 8, 'ascii')
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
  header.write('00000000000\0', 136, 12, 'ascii')
  header.fill(0x20, 148, 156)
  header.write(type, 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}

/** A skill archive as core serves it: a gzip tar with every member under `skills/<name>/`. */
export function skillArchive(name: string, files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [tarHeader('skills/', '5', 0, 0o755), tarHeader(`skills/${name}/`, '5', 0, 0o755)]
  for (const [path, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8')
    blocks.push(tarHeader(`skills/${name}/${path}`, '0', data.length, 0o644), data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

export const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

/* -------------------------------------------------------------- catalog */

export interface FakeSkill {
  uuid: string
  packageId: string
  /** The folder name (what a pin is called). */
  name: string
  title: string
  description: string
  publisher: string
  /** The latest revision, newest last; each has its own archive. */
  revisions: { number: number; version: string | null; bytes: Buffer }[]
  access: 'use' | 'edit' | 'maintain'
}

export function fakeSkill(input: { packageId: string; name: string; title: string; description: string; publisher: string; version?: string }): FakeSkill {
  const skill: FakeSkill = {
    uuid: randomUUID(),
    packageId: input.packageId,
    name: input.name,
    title: input.title,
    description: input.description,
    publisher: input.publisher,
    revisions: [],
    access: 'use'
  }
  addRevision(skill, input.version ?? '1.0.0')
  return skill
}

/** Publish the next revision of `skill`: a new archive, a new digest, the listing's `latest`. */
export function addRevision(skill: FakeSkill, version: string | null): void {
  const number = skill.revisions.length + 1
  const md = ['---', `name: ${skill.name}`, `description: ${skill.description}`, '---', '', `# ${skill.title}`, '', `Revision ${number}.`, ''].join('\n')
  skill.revisions.push({ number, version, bytes: skillArchive(skill.name, { 'SKILL.md': md }) })
}

/** A desktop agent in the listing: what makes a folder linked to it a team agent with this access. */
export interface FakeTeamAgent {
  uuid: string
  bundleId: string
  repoId: string
  slug: string
  title: string
  access: 'use' | 'edit' | 'maintain'
}

const person = (name: string): { user_id: string; display_name: string } => ({ user_id: `user-${name.toLowerCase().replace(/\W+/g, '-')}`, display_name: name })

function skillItem(skill: FakeSkill): Record<string, unknown> {
  const latest = skill.revisions[skill.revisions.length - 1]
  return {
    kind: 'skill',
    runs_on: null,
    uuid: skill.uuid,
    id: skill.packageId,
    name: skill.name,
    display_name: skill.title,
    description: skill.description,
    publisher: person(skill.publisher),
    maintainers: [person(skill.publisher)],
    access: skill.access,
    visibility: 'users',
    is_listed: true,
    latest: {
      revision_number: latest.number,
      version: latest.version,
      published_at: '2026-11-01T09:00:00Z',
      published_by: person(skill.publisher),
      release_notes: null
    },
    install_count: 0,
    my_installs: [],
    required_credential_specs: [],
    skills: null,
    desktop: null,
    skill: { frontmatter: { name: skill.name, description: skill.description }, archive_sha256: sha256(latest.bytes), size_bytes: latest.bytes.length }
  }
}

function agentItem(agent: FakeTeamAgent, host: string): Record<string, unknown> {
  return {
    kind: 'agent',
    runs_on: 'desktop',
    uuid: agent.uuid,
    id: agent.bundleId,
    name: agent.slug,
    display_name: agent.title,
    description: agent.title,
    publisher: person('Team Admin'),
    maintainers: [person('Team Admin')],
    access: agent.access,
    visibility: 'users',
    is_listed: true,
    latest: null,
    install_count: 1,
    my_installs: [],
    required_credential_specs: [],
    skills: [],
    desktop: {
      repo_id: agent.repoId,
      clone_url: `${host}/git/${agent.repoId}.git`,
      default_branch: 'main',
      head_sha: null,
      manifest_id: `manifest-${agent.repoId}`,
      slug: agent.slug,
      engine: null,
      contract_version: null
    },
    skill: null
  }
}

export async function fakeCatalogCore(skills: FakeSkill[], agents: FakeTeamAgent[] = []) {
  let host = ''
  const requests: string[] = []
  const held: Array<() => void> = []
  let hold = false
  let drop = false

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    requests.push(`${req.method} ${url.pathname}${url.search}`)
    req.resume()
    const send = (value: unknown, status = 200): void => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(value))
    }
    if (req.method === 'GET' && url.pathname === '/.well-known/cinna-desktop') {
      return send({
        authorization_endpoint: `${host}/oauth/authorize`,
        token_endpoint: `${host}/oauth/token`,
        userinfo_endpoint: `${host}/oauth/userinfo`,
        instance_name: 'Acme Labs'
      })
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/catalog/items') {
      if (drop) {
        res.destroy()
        return
      }
      const answer = (): void => {
        const data = [...skills.map(skillItem), ...agents.map((agent) => agentItem(agent, host))]
        send({ data, count: data.length })
      }
      if (hold) held.push(answer)
      else answer()
      return
    }
    const detail = /^\/api\/v1\/catalog\/items\/([0-9a-f-]{36})$/.exec(url.pathname)
    if (req.method === 'GET' && detail) {
      const skill = skills.find((s) => s.uuid === detail[1])
      if (!skill) return send({ detail: 'Not found' }, 404)
      const revisions = [...skill.revisions].reverse().map((r) => ({
        revision_number: r.number,
        version: r.version,
        published_at: '2026-11-01T09:00:00Z',
        published_by: person(skill.publisher),
        release_notes: null,
        origin: 'skill',
        git_commit_sha: null
      }))
      return send({ ...skillItem(skill), revisions })
    }
    const download = /^\/api\/v1\/skills\/packages\/([0-9a-f-]{36})\/revisions\/(\d+)\/download$/.exec(url.pathname)
    if (req.method === 'GET' && download) {
      const skill = skills.find((s) => s.uuid === download[1])
      const revision = skill?.revisions.find((r) => r.number === Number(download[2]))
      if (!skill || !revision) return send({ detail: 'Not found' }, 404)
      res.statusCode = 200
      res.setHeader('content-type', 'application/gzip')
      res.setHeader('x-content-sha256', sha256(revision.bytes))
      res.end(revision.bytes)
      return
    }
    send({ detail: 'No fixture route for this request' }, 404)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    host,
    /** `127.0.0.1:<port>`, as the offer names the server. */
    hostLabel: new URL(host).host,
    requests,
    held,
    /** Hold every listing request until `releaseListings()`. */
    holdListing(on: boolean): void {
      hold = on
    },
    /** Answer every held listing request. */
    releaseListings(): void {
      held.splice(0).forEach((answer) => answer())
    },
    /** Close the connection of every listing request without an answer: the server is unreachable for it. */
    dropListing(on: boolean): void {
      drop = on
    },
    /** How many listing reads main made so far. */
    listingReads(): number {
      return requests.filter((line) => line === 'GET /api/v1/catalog/items').length
    },
    async close(): Promise<void> {
      held.splice(0).forEach((answer) => answer())
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
export type FakeCatalogCore = Awaited<ReturnType<typeof fakeCatalogCore>>
