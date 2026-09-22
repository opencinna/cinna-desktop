#!/usr/bin/env node
/**
 * `make kit-sync` — re-bundle cinna-core's kit contract into
 * `resources/cinna-kit-contract/`, byte for byte.
 *
 *   node --experimental-strip-types scripts/kit-sync/sync.mjs [--core <path>] [--ref <rev>]
 *
 * Core is the only place a contract version is minted, and its templates are
 * canonical (drafts: kit_contract_unification, decisions 8–9). This script is
 * the one way the desktop copy changes: it renders `docs/local_agent_kit/`
 * exactly as core's `LocalAgentKitService` does (backend/app/services/cli/
 * local_agent_kit_service.py — `_read_snapshot`, `_render_tree`, `_render_bytes`,
 * `_content_version`, `_is_contract_member`) with public-cloud placeholder
 * values, keeps only the contract members, and replaces the bundle wholesale.
 * `scripts/kit-sync/contract.lock.json` records what was rendered and a tree
 * hash that `src/main/kit/contractBundle.test.ts` recomputes, so a hand edit to
 * the bundle fails the unit suite.
 *
 * `--core` defaults to `$CINNA_CORE_PATH`, else `../workflow-runner-core`.
 * `--ref <rev>` reads core at that git revision (kit tree, service source and
 * config defaults alike); without it, core's working tree.
 *
 * Everything this script cannot read unambiguously out of core — the member
 * set, the CLI defaults, the token set — fails loudly instead of guessing.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareUtf8, contractTreeHash } from '../../src/main/kit/contractTreeHash.ts'
import { applyTarballModes, freshWorkDir, swapInto } from './bundleFiles.ts'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const BUNDLE = join(REPO, 'resources', 'cinna-kit-contract')
const LOCK = join(REPO, 'scripts', 'kit-sync', 'contract.lock.json')
/**
 * Where the new tree is built and the old one parked during the swap. Inside
 * the repo so the rename stays on one filesystem; gitignored. Kept out of the
 * app by `!scripts/**` in electron-builder.yml (its default `files` would
 * otherwise pack it), and emptied at the start of every run so a tree left by
 * an interrupted one does not linger.
 */
const WORK = join(REPO, 'scripts', 'kit-sync', '.work')

const KIT_REL = 'docs/local_agent_kit'
const SERVICE_REL = 'backend/app/services/cli/local_agent_kit_service.py'
const CONFIG_REL = 'backend/app/core/config.py'

// Mirrors of core constants. Each is checked against core's source below, so a
// change there stops the sync instead of silently rendering differently.
const SKIP_DIRS = ['.git', '.pytest_cache', '__pycache__']
const MAX_RENDERED_BYTES = 5 * 1024 * 1024
const VERSION_TOKEN = '{{KIT_VERSION}}'

function fail(message) {
  console.error(`kit-sync: ${message}`)
  process.exit(1)
}

// ── Arguments ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { core: null, ref: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--core' || arg === '--ref') {
      const value = argv[++i]
      if (!value) fail(`${arg} needs a value`)
      args[arg.slice(2)] = value
    } else if (arg === '-h' || arg === '--help') {
      console.log('usage: sync.mjs [--core <path>] [--ref <rev>]')
      process.exit(0)
    } else {
      fail(`unknown argument ${arg}`)
    }
  }
  const envCore = process.env.CINNA_CORE_PATH
  args.core = resolve(args.core ?? (envCore && envCore !== '' ? envCore : join(REPO, '..', 'workflow-runner-core')))
  return args
}

function git(core, args, options = {}) {
  const result = spawnSync('git', ['-C', core, ...args], { encoding: options.encoding ?? 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) {
    fail(`git ${args.join(' ')} failed in ${core}: ${String(result.stderr).trim()}`)
  }
  return result.stdout
}

// ── Reading core ─────────────────────────────────────────────────────────

/** A text file of core, at the ref or in the working tree. */
function readCoreText(core, ref, rel) {
  if (ref) return git(core, ['show', `${ref}:${rel}`])
  const path = join(core, rel)
  if (!existsSync(path)) fail(`${path} not found`)
  return readFileSync(path, 'utf8')
}

/**
 * `_read_snapshot`: every regular file, symlinks never followed nor read,
 * nothing under a skipped directory name, sizes capped.
 */
function readSnapshot(kitDir) {
  if (!existsSync(kitDir) || !statSync(kitDir).isDirectory()) fail(`kit directory missing at ${kitDir}`)
  const raw = new Map()
  let total = 0
  const walk = (dir, parts) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name)
      const relParts = [...parts, name]
      if (relParts.some((part) => SKIP_DIRS.includes(part))) continue
      const stat = lstatSync(abs)
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        walk(abs, relParts)
        continue
      }
      if (!stat.isFile()) continue
      total += stat.size
      if (total > MAX_RENDERED_BYTES) fail(`kit at ${kitDir} exceeds ${MAX_RENDERED_BYTES} bytes`)
      raw.set(relParts.join('/'), readFileSync(abs))
    }
  }
  walk(kitDir, [])
  if (raw.size === 0) fail(`kit at ${kitDir} is empty`)
  return raw
}

/** Check out `docs/local_agent_kit/` at `ref` into a temp dir. */
function extractKitAtRef(core, ref) {
  const dir = mkdtempSync(join(tmpdir(), 'cinna-kit-sync-'))
  const archive = spawnSync('git', ['-C', core, 'archive', '--format=tar', ref, KIT_REL], { maxBuffer: 256 * 1024 * 1024 })
  if (archive.status !== 0) fail(`git archive ${ref} ${KIT_REL} failed: ${String(archive.stderr).trim()}`)
  const untar = spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout })
  if (untar.status !== 0) fail(`extracting the archive failed: ${String(untar.stderr).trim()}`)
  return { dir, kitDir: join(dir, KIT_REL) }
}

// ── Parsing core's Python source ─────────────────────────────────────────

/** Module-level `NAME = "literal"` string constants. */
function stringConstants(source) {
  const constants = new Map()
  for (const match of source.matchAll(/^([A-Z_][A-Z0-9_]*)\s*=\s*"([^"\\]*)"\s*$/gm)) {
    constants.set(match[1], match[2])
  }
  return constants
}

/** Resolve a comma list of identifiers / string literals, or fail. */
function resolveItems(body, constants, what) {
  const items = body
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
  if (items.length === 0) fail(`could not parse ${what}: empty`)
  return items.map((item) => {
    const literal = /^"([^"\\]*)"$/.exec(item) ?? /^'([^'\\]*)'$/.exec(item)
    if (literal) return literal[1]
    if (/^[A-Z_][A-Z0-9_]*$/.test(item) && constants.has(item)) return constants.get(item)
    return fail(`could not parse ${what}: cannot resolve ${JSON.stringify(item)}`)
  })
}

function parseService(source) {
  const constants = stringConstants(source)

  const members = /^CONTRACT_MEMBERS\s*=\s*frozenset\(\s*\{([^}]*)\}\s*\)/m.exec(source)
  if (!members) fail(`could not find CONTRACT_MEMBERS = frozenset({...}) in ${SERVICE_REL}`)
  const prefixes = /^CONTRACT_MEMBER_PREFIXES\s*=\s*\(([^)]*)\)/m.exec(source)
  if (!prefixes) fail(`could not find CONTRACT_MEMBER_PREFIXES = (...) in ${SERVICE_REL}`)

  const skip = /^_SKIP_DIRS\s*=\s*\{([^}]*)\}/m.exec(source)
  if (!skip) fail(`could not find _SKIP_DIRS in ${SERVICE_REL}`)
  const skipDirs = resolveItems(skip[1], constants, '_SKIP_DIRS').sort()
  if (skipDirs.join('\n') !== [...SKIP_DIRS].sort().join('\n')) {
    fail(`core's _SKIP_DIRS is ${JSON.stringify(skipDirs)}; this script mirrors ${JSON.stringify(SKIP_DIRS)} — update it`)
  }
  const cap = /^MAX_RENDERED_BYTES\s*=\s*(.+)$/m.exec(source)
  if (!cap || cap[1].replace(/\s+/g, '') !== '5*1024*1024') {
    fail(`core's MAX_RENDERED_BYTES changed (${cap?.[1] ?? 'not found'}); update this script`)
  }
  if (constants.get('_VERSION_TOKEN') !== VERSION_TOKEN) {
    fail(`core's _VERSION_TOKEN is not ${VERSION_TOKEN}; update this script`)
  }

  // The token set of `placeholders()`: every `"TOKEN":` key in its returned dict.
  const body = /def placeholders\(\)[\s\S]*?return \{([\s\S]*?)\n\s*\}/.exec(source)
  if (!body) fail(`could not find placeholders() in ${SERVICE_REL}`)
  const tokens = [...body[1].matchAll(/^\s*"([A-Z_]+)":/gm)].map((m) => m[1])
  const expected = Object.keys(PUBLIC_VALUES_WITHOUT_CLI).concat(['CLI_INSTALL_SPEC', 'MIN_CLI_VERSION'])
  if (tokens.join(',') !== expected.join(',')) {
    fail(`core's placeholder token set is ${tokens.join(',')}; this script renders ${expected.join(',')} — update it`)
  }

  return {
    members: new Set(resolveItems(members[1], constants, 'CONTRACT_MEMBERS')),
    prefixes: resolveItems(prefixes[1], constants, 'CONTRACT_MEMBER_PREFIXES')
  }
}

/** The default of a `NAME: str = "value"` settings field. */
function configDefault(source, name) {
  const match = new RegExp(`^\\s+${name}\\s*:\\s*str\\s*=\\s*"([^"\\\\]*)"\\s*(#.*)?$`, 'm').exec(source)
  if (!match) fail(`could not find a string default for ${name} in ${CONFIG_REL}`)
  return match[1]
}

// ── Rendering (LocalAgentKitService._render_tree) ────────────────────────

/** Public-cloud values, in core's `placeholders()` order. */
const PUBLIC_VALUES_WITHOUT_CLI = {
  PLATFORM_URL: 'https://opencinna.io',
  KIT_BASE_URL: 'https://opencinna.io/api/agent-start',
  START_URL: 'https://opencinna.io/agent-start',
  SIGNUP_URL: 'https://opencinna.io/signup',
  LOGIN_URL: 'https://opencinna.io/login',
  INSTANCE_NAME: 'Cinna'
}

/** Python `json.dumps(value)[1:-1]` — ASCII-only output, lower-case hex escapes. */
function pythonJsonEscape(value) {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    const code = value.charCodeAt(i)
    if (ch === '"') out += '\\"'
    else if (ch === '\\') out += '\\\\'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (ch === '\b') out += '\\b'
    else if (ch === '\f') out += '\\f'
    // UTF-16 code units: an astral char becomes its surrogate pair, as Python does.
    else if (code < 0x20 || code > 0x7e) out += `\\u${code.toString(16).padStart(4, '0')}`
    else out += ch
  }
  return out
}

// `ignoreBOM: true` keeps a leading U+FEFF, as Python's 'utf-8' codec does.
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function renderBytes(content, values, jsonMode) {
  let text
  try {
    text = strictUtf8.decode(content)
  } catch {
    return content
  }
  for (const [token, raw] of Object.entries(values)) {
    const value = jsonMode ? pythonJsonEscape(raw) : raw
    text = text.split(`{{${token}}}`).join(value)
  }
  return Buffer.from(text, 'utf8')
}

function contentVersion(staged) {
  const digest = createHash('sha256')
  for (const rel of [...staged.keys()].sort(compareUtf8)) {
    digest.update(Buffer.from(`${rel}\0`, 'utf8'))
    digest.update(createHash('sha256').update(staged.get(rel)).digest())
  }
  return digest.digest('hex').slice(0, 16)
}

function replaceBytes(content, search, replacement) {
  const parts = []
  let from = 0
  for (let at = content.indexOf(search, from); at !== -1; at = content.indexOf(search, from)) {
    parts.push(content.subarray(from, at), replacement)
    from = at + search.length
  }
  if (parts.length === 0) return content
  parts.push(content.subarray(from))
  return Buffer.concat(parts)
}

function renderTree(raw, values) {
  const staged = new Map()
  for (const [rel, content] of raw) staged.set(rel, renderBytes(content, values, rel.toLowerCase().endsWith('.json')))
  const version = contentVersion(staged)
  const token = Buffer.from(VERSION_TOKEN, 'utf8')
  const stamp = Buffer.from(version, 'utf8')
  const rendered = new Map()
  for (const [rel, content] of staged) rendered.set(rel, replaceBytes(content, token, stamp))
  return { version, rendered }
}

// ── Contract coherence (LocalAgentKitService._contract_defect_reason) ────

function contractVersionOf(rendered) {
  const missing = ['kit.json', 'layout.json', 'CONTRACT_VERSION'].filter((m) => !rendered.has(m))
  if (missing.length > 0) fail(`contract is not serviceable: missing ${missing.join(', ')}`)
  let declared
  try {
    declared = strictUtf8.decode(rendered.get('CONTRACT_VERSION')).trim()
  } catch {
    declared = ''
  }
  if (declared === '') fail('contract is not serviceable: CONTRACT_VERSION is empty or undecodable')
  const all = { CONTRACT_VERSION: declared }
  for (const member of ['kit.json', 'layout.json']) {
    let doc
    try {
      doc = JSON.parse(strictUtf8.decode(rendered.get(member)))
    } catch {
      fail(`contract is not serviceable: unparseable ${member}`)
    }
    const value = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc.contract_version : undefined
    if (typeof value !== 'string' || value.trim() === '') fail(`contract is not serviceable: no usable contract_version in ${member}`)
    all[member] = value.trim()
  }
  if (new Set(Object.values(all)).size > 1) {
    fail(`contract_version disagrees across the kit: ${Object.entries(all).map(([m, v]) => `${m}=${v}`).join(', ')}`)
  }
  return declared
}

// ── Source identity ──────────────────────────────────────────────────────

function sourceIdentity(core, ref) {
  if (ref) {
    return { commit: git(core, ['rev-parse', '--verify', `${ref}^{commit}`]).trim(), source: `ref:${ref}`, dirty: false }
  }
  const commit = git(core, ['rev-parse', '--verify', 'HEAD^{commit}']).trim()
  const status = git(core, ['status', '--porcelain', '--untracked-files=all', '--', KIT_REL, SERVICE_REL, CONFIG_REL])
  return { commit, source: 'working-tree', dirty: status.trim() !== '' }
}

// ── Main ─────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(join(args.core, '.git')) && !existsSync(join(args.core, SERVICE_REL))) {
    fail(`no cinna-core checkout at ${args.core} (pass --core or set CINNA_CORE_PATH)`)
  }

  const service = parseService(readCoreText(args.core, args.ref, SERVICE_REL))
  const config = readCoreText(args.core, args.ref, CONFIG_REL)
  const values = {
    ...PUBLIC_VALUES_WITHOUT_CLI,
    CLI_INSTALL_SPEC: configDefault(config, 'CINNA_CLI_INSTALL_SPEC'),
    MIN_CLI_VERSION: configDefault(config, 'MINIMUM_CLI_VERSION')
  }

  const identity = sourceIdentity(args.core, args.ref)
  let extracted = null
  let kitDir = join(args.core, KIT_REL)
  if (args.ref) {
    extracted = extractKitAtRef(args.core, args.ref)
    kitDir = extracted.kitDir
  }

  let raw
  try {
    raw = readSnapshot(kitDir)
  } finally {
    if (extracted) rmSync(extracted.dir, { recursive: true, force: true })
  }

  const { version: kitVersion, rendered } = renderTree(raw, values)
  const contractVersion = contractVersionOf(rendered)
  const isMember = (rel) => service.members.has(rel) || service.prefixes.some((prefix) => rel.startsWith(prefix))
  const members = [...rendered.keys()].filter(isMember).sort(compareUtf8)

  // Build in the work dir, then swap: the old tree is replaced wholesale, so
  // nothing that core no longer ships survives.
  freshWorkDir(WORK)
  const staging = mkdtempSync(join(WORK, 'staging-'))
  try {
    for (const rel of members) {
      const target = join(staging, ...rel.split('/'))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, rendered.get(rel))
    }
    applyTarballModes(staging)
  } catch (err) {
    rmSync(staging, { recursive: true, force: true })
    throw err
  }
  swapInto(staging, BUNDLE)
  const tree = contractTreeHash(BUNDLE)
  const lock = {
    comment: 'Written by `make kit-sync` (scripts/kit-sync/sync.mjs). Never edit this or resources/cinna-kit-contract/ by hand.',
    core_commit: identity.commit,
    core_source: identity.source,
    core_dirty: identity.dirty,
    contract_version: contractVersion,
    kit_version: kitVersion,
    file_count: tree.fileCount,
    tree_hash: tree.hash,
    tree_hash_algorithm: 'sha256 over "<path>\\0<sha256 hex of file>\\n" per file, paths relative and POSIX, sorted by UTF-8 bytes (src/main/kit/contractTreeHash.ts)'
  }
  writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`)

  console.log(
    `kit-sync: contract ${contractVersion}, kit ${kitVersion}, ${tree.fileCount} files from ${identity.source} @ ${identity.commit.slice(0, 12)}` +
      (identity.dirty ? ' (DIRTY working tree)' : '')
  )
}

main()
