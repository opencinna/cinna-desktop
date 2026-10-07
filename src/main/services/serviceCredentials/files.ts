import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { runtimeHost } from '../../host/runtimeHost'
import { handoverGit } from '../handoverGit'
import { isIgnoredPath } from '../../kit/validator'
import type { LocalAgentKind } from '../../../shared/localAgents'
import type { ServiceCredentialBundle, ServiceCredentialEntry } from '../../../shared/serviceCredentials'

export function agentCredentialKey(path: string): string { return createHash('sha256').update(realpathSync(path)).digest('hex').slice(0, 32) }
function secureDir(path: string): void {
  if (existsSync(path)) { if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error('Credential storage must be a real directory.') }
  else mkdirSync(path, { recursive: true, mode: 0o700 })
  chmodSync(path, 0o700)
}
export function atomicSecret(path: string, bytes: string): void {
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error('Credential storage must be a regular file.')
    if (readFileSync(path, 'utf8') === bytes) { chmodSync(path, 0o600); return }
  }
  const temp = `${path}.${randomUUID()}.tmp`
  const fd = openSync(temp, 'wx', 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  try { renameSync(temp, path) } finally { if (existsSync(temp)) unlinkSync(temp) }
}
export async function checkCredentialPaths(agentDir: string, names = ['credentials.json']): Promise<void> {
  const folder = join(agentDir, 'credentials')
  secureDir(folder)
  const ignore = join(folder, '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n!.gitignore\n!README.md\n!*.example\n', { flag: 'wx', mode: 0o600 })
  for (const name of names) {
    const rel = `credentials/${name}`
    const check = await handoverGit.check(agentDir, rel)
    if (!isIgnoredPath(agentDir, rel) || !['ignored', 'not_a_repo'].includes(check.result)) throw new Error('Credential files must be untracked and covered by the kit’s git ignore policy.')
  }
}
interface Inventory { agentDir: string; kind: LocalAgentKind; files: string[]; generation: string }
function storage(agentDir: string) {
  const root = join(runtimeHost.getPath('userData'), 'agent-credentials')
  secureDir(root)
  const folder = join(root, agentCredentialKey(agentDir)); secureDir(folder)
  return folder
}
export function generatedPath(agentDir: string, kind: LocalAgentKind): string {
  return join(kind === 'kit' ? join(agentDir, 'credentials') : storage(agentDir), 'credentials.json')
}
/** Where a generation's files live: the kit's own `credentials/`, or Desktop storage for a bare folder. */
function generatedDir(agentDir: string, kind: LocalAgentKind, store: string): string { return kind === 'kit' ? join(agentDir, 'credentials') : store }
/** The exact files a generation consists of, by name. Pure: no filesystem access. */
function renderFiles(directory: string, kind: LocalAgentKind, bundles: ServiceCredentialBundle[], synthetic: ServiceCredentialEntry[]): Map<string, string> {
  const files = new Map<string, string>()
  const entries: ServiceCredentialEntry[] = []
  for (const bundle of bundles) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(bundle.id)) throw new Error('Invalid credential identity.')
    const entry = structuredClone(bundle.entry)
    if (bundle.service_account_file) {
      const name = `${bundle.id}.json`
      entry.credential_data.file_path = kind === 'kit' ? `credentials/${name}` : join(directory, name)
      files.set(name, JSON.stringify(bundle.service_account_file, null, 2) + '\n')
    }
    entries.push(entry)
  }
  if (entries.length) files.set('credentials.json', JSON.stringify([...entries, ...synthetic], null, 2) + '\n')
  return files
}
/**
 * The generation currently on disk (inventory-owned files and their bytes) next to
 * the one these bundles would produce. Null when the inventory is missing or any
 * owned file is unreadable — the caller then treats the change as not comparable.
 */
export function compareGeneration(agentDir: string, kind: LocalAgentKind, bundles: ServiceCredentialBundle[], synthetic: ServiceCredentialEntry[]): { current: Map<string, string>; next: Map<string, string> } | null {
  const store = storage(agentDir), inventoryPath = join(store, 'inventory.json')
  if (!existsSync(inventoryPath)) return null
  const directory = generatedDir(agentDir, kind, store)
  try {
    const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8')) as Inventory
    if (inventory.kind !== kind || !Array.isArray(inventory.files)) return null
    const current = new Map<string, string>()
    for (const name of inventory.files) {
      const path = join(directory, name)
      if (!/^(credentials|[a-zA-Z0-9_-]+)\.json$/.test(name) || !existsSync(path) || lstatSync(path).isSymbolicLink()) return null
      current.set(name, readFileSync(path, 'utf8'))
    }
    return { current, next: renderFiles(directory, kind, bundles, synthetic) }
  } catch { return null }
}
/** Only inventory-owned names can be replaced/deleted. Authored side files survive. */
export async function writeCredentials(agentDir: string, kind: LocalAgentKind, bundles: ServiceCredentialBundle[], synthetic: ServiceCredentialEntry[], generation: string, validate: () => void = () => {}): Promise<string | undefined> {
  const store = storage(agentDir), inventoryPath = join(store, 'inventory.json')
  let old: Inventory = { agentDir, kind, files: [], generation: '' }
  if (existsSync(inventoryPath)) old = JSON.parse(readFileSync(inventoryPath, 'utf8'))
  const directory = generatedDir(agentDir, kind, store)
  if (old.files.length) secureDir(directory)
  const files = renderFiles(directory, kind, bundles, synthetic)
  if (files.size && kind === 'kit') await checkCredentialPaths(agentDir, [...files.keys()])
  validate()
  if (files.size) secureDir(directory)
  // Check all collisions before writing any bytes.
  for (const name of files.keys()) if (existsSync(join(directory, name)) && !old.files.includes(name)) throw new Error('An authored credential file already exists. Move it before attaching credentials.')
  // Persist ownership before writes, so crash recovery can clean partial generation.
  const owned = [...new Set([...old.files, ...files.keys()])]
  atomicSecret(inventoryPath, JSON.stringify({ agentDir, kind, files: owned, generation }))
  for (const name of old.files) if (!files.has(name)) {
    if (!/^(credentials|[a-zA-Z0-9_-]+)\.json$/.test(name)) throw new Error('Invalid generated file inventory.')
    const path = join(directory, name)
    if (existsSync(path)) { if (lstatSync(path).isSymbolicLink()) throw new Error('Generated credential file was replaced by a link.'); unlinkSync(path) }
  }
  for (const [name, bytes] of files) atomicSecret(join(directory, name), bytes)
  atomicSecret(inventoryPath, JSON.stringify({ agentDir, kind, files: [...files.keys()], generation }))
  return files.size ? join(directory, 'credentials.json') : undefined
}

/** Only after a full scan: a moved/deleted bare folder has a new identity.
 * Never follow a sidecar link or delete authored/unrecorded files. */
export function collectOrphanBareCredentials(knownPaths: string[]): void {
  const root = join(runtimeHost.getPath('userData'), 'agent-credentials')
  if (!existsSync(root)) return
  secureDir(root)
  const known = new Set(knownPaths.map(path => realpathSync(path)))
  for (const key of readdirSync(root)) {
    if (!/^[a-f0-9]{32}$/.test(key)) continue
    const folder = join(root, key), index = join(folder, 'inventory.json')
    try {
      if (lstatSync(folder).isSymbolicLink() || !lstatSync(folder).isDirectory() || lstatSync(index).isSymbolicLink()) continue
      const inventory = JSON.parse(readFileSync(index, 'utf8')) as Inventory
      if (inventory.kind !== 'bare' || typeof inventory.agentDir !== 'string' || existsSync(inventory.agentDir) || known.has(inventory.agentDir)) continue
      if (!Array.isArray(inventory.files) || inventory.files.some(name => !/^(credentials|[a-zA-Z0-9_-]+)\.json$/.test(name))) continue
      for (const name of inventory.files) {
        const file = join(folder, name)
        if (existsSync(file) && !lstatSync(file).isSymbolicLink()) unlinkSync(file)
      }
      unlinkSync(index)
      if (!readdirSync(folder).length) rmdirSync(folder)
    } catch { /* An unreadable/incomplete inventory never grants deletion rights. */ }
  }
}
