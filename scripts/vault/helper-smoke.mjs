#!/usr/bin/env node
// Drives a TEST-flavor VaultHelper.app end to end against the real guest image:
// hello, availability, vault.create in a temp dir, unlock (cold boot + format),
// a vaultd hello over channel.open, approvals (a guest-verified token accepted
// by vaultd, a forged one refused), egress through the proxy from inside the
// guest (allowed and denied host), hold/release and the unlock window running
// out → locked, unlock again (resume), the screen-lock stand-in (SIGUSR1),
// setEgress/resize with helper-verified tokens, tamper detection, destroy, and
// stdin close ⇒ exit. Review round 1 (D35–D40, M1–M5, L1): the parent-check
// probes (verdict via `hello`, enforced with CINNA_VAULT_TEST_ENFORCE_PARENT,
// per-frame peer pinning), install hosts only with a live proxy credential
// (refused without, revoked at exec-end, on lock, and when a vaultd restart drops the event
// subscription, which the helper then reopens), lock wins over a pending
// unlock, holds capped, one flock per data.img, unlock refused while the screen
// is locked, the pinned SecureAgents dir, the single-file vault.json with its
// pending/current digest slots, and a failed formatted:true write stopping the vault.
//
//   sh scripts/vault/build-helper.sh            # FLAVOR=test (default)
//   node scripts/vault/helper-smoke.mjs [--keep] [--no-net]
//   FLAVOR=dev sh scripts/vault/build-helper.sh && node scripts/vault/helper-smoke.mjs --keychain [--presence]
//   (dev/release: the smoke re-runs itself under a copy of node signed as Cinna with your team identity;
//   --presence raises four real Touch ID prompts: unlock, resume, an export approval, destroy)
//
// Needs build/vault-guest/rootfs.img (make vault-image). No prompts, no
// billing; --no-net skips the two curl probes that reach the internet.
import { spawn, spawnSync } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { chmodSync, openSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
// The canonical details main computes (Node strips the types); the helper must agree.
const { approvalDetail } = await import(join(ROOT, 'src/shared/vault/protocol.ts'))
const HELPER = join(ROOT, 'resources/vault/VaultHelper.app/Contents/MacOS/VaultHelper')
const ROOTFS = process.env.VAULT_ROOTFS ?? join(ROOT, 'build/vault-guest/rootfs.img')
const KEEP = process.argv.includes('--keep')
const NO_NET = process.argv.includes('--no-net')
const WINDOW_MS = 3000
const PAUSED_STOP_MS = 6000
const HOLD_MAX_MS = 8000
const UNLOCK_DELAY_MS = 1500

const t0 = Date.now()
const stamp = () => `${String(Date.now() - t0).padStart(6)} ms`
const say = (...a) => console.log(stamp(), ...a)
let failures = 0
function check(ok, what, extra = '') {
  if (!ok) failures++
  console.log(stamp(), ok ? 'PASS' : 'FAIL', what, extra)
}

// ---- frames (protocol.ts HELPER_FRAME_*) -------------------------------------
const T = { ctl: 0, data: 1, eof: 2, rst: 3 }
function frame(type, channel, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(9)
  head.writeUInt32BE(5 + payload.length, 0)
  head.writeUInt8(type, 4)
  head.writeUInt32BE(channel, 5)
  return Buffer.concat([head, payload])
}

if (!existsSync(HELPER)) throw new Error(`no helper at ${HELPER}: run sh scripts/vault/build-helper.sh`)
if (!existsSync(ROOTFS)) throw new Error(`no guest rootfs at ${ROOTFS}: run make vault-image`)

// A dev or release helper enforces its parent (D35): signed by the team, with
// Cinna's identifier, hardened. Stand in for Cinna with a throwaway copy of this
// node signed that way (dev: Apple Development or Developer ID; release:
// Developer ID only) and run the whole smoke under it.
const FLAVOR = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CinnaVaultFlavor', join(HELPER, '../../Info.plist')], { encoding: 'utf8' }).stdout.trim() || 'test'
if (FLAVOR !== 'test' && !process.env.CINNA_SMOKE_STANDIN) {
  const identities = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }).stdout
  const pick = (kind) => new RegExp(`([0-9A-F]{40}) "${kind}: [^"]*\\(G5E484HA2U\\)"`).exec(identities)?.[1]
  const identity = FLAVOR === 'release' ? pick('Developer ID Application') : (pick('Apple Development') ?? pick('Developer ID Application'))
  if (!identity) throw new Error(`no ${FLAVOR === 'release' ? 'Developer ID Application' : 'Apple Development / Developer ID'} identity of team G5E484HA2U to sign the stand-in parent`)
  const standDir = mkdtempSync(join(tmpdir(), 'cinna-vault-standin-'))
  const standIn = join(standDir, 'node')
  writeFileSync(standIn, readFileSync(process.execPath))
  chmodSync(standIn, 0o755)
  const ents = join(standDir, 'node.entitlements')
  writeFileSync(ents, '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/></dict></plist>\n')
  const sign = spawnSync('codesign', ['-f', '-s', identity, '-o', 'runtime', '--identifier', 'io.opencinna.desktop', '--entitlements', ents, standIn], { encoding: 'utf8' })
  if (sign.status !== 0) throw new Error(`codesign of the stand-in parent failed: ${sign.stderr}`)
  console.log(stamp(), `stand-in parent: ${standIn} signed as io.opencinna.desktop (${FLAVOR} helper)`)
  const run = spawnSync(standIn, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, CINNA_SMOKE_STANDIN: '1' } })
  rmSync(standDir, { recursive: true, force: true })
  process.exit(run.status ?? 1)
}

const dir = mkdtempSync(join(tmpdir(), 'cinna-vault-smoke-'))
const secureAgents = join(dir, 'SecureAgents')
const stderrLog = []

// ---- vault.json (M1): {"sig":"<hex>","vault":<body>} --------------------------
const TEST_SIGNING_KEY = createHash('sha256').update('cinna-vault-test-flavor-signing-key-v1').digest()
const readVault = (id) => JSON.parse(readFileSync(join(secureAgents, id, 'vault.json'), 'utf8')).vault
function signedFile(bodyText) {
  const sig = createHmac('sha256', TEST_SIGNING_KEY).update(bodyText).digest('hex')
  return `{"sig":"${sig}","vault":${bodyText}}`
}
const bodyOf = (fileText) => fileText.slice('{"sig":"'.length + 64 + '","vault":'.length, -1)
const sha = (text) => createHash('sha256').update(text).digest('hex')

// ---- parent-check probes (D35), before the main run --------------------------
// An intermediate node process is the helper's parent: it spawns the helper with
// stdio pipes (socketpairs), sends `hello`, and prints the reply and the helper's
// stderr. `rogue` additionally has a second process write a frame on the same
// stdin socket after the honest hello (the exec-race accomplice).
const PROBE = `
const { spawn } = require('node:child_process')
const [helperPath, rogue] = process.argv.slice(1)
const h = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
const frame = (o) => { const p = Buffer.from(JSON.stringify(o)); const b = Buffer.alloc(9); b.writeUInt32BE(5 + p.length, 0); b.writeUInt8(0, 4); b.writeUInt32BE(0, 5); return Buffer.concat([b, p]) }
let out = Buffer.alloc(0), err = ''
const replies = []
h.stderr.on('data', (d) => { err += d })
h.stdout.on('data', (d) => { out = Buffer.concat([out, d]); while (out.length >= 4 && out.length >= 4 + out.readUInt32BE(0)) { const n = out.readUInt32BE(0); replies.push(JSON.parse(out.subarray(9, 4 + n).toString())); out = out.subarray(4 + n) } })
h.on('exit', (code) => { console.log(JSON.stringify({ replies, err, code })) })
h.stdin.write(frame({ id: 1, method: 'hello', params: { protocol: 1 } }))
h.stdin.write(frame({ id: 2, method: 'vault.list', params: { dir: '/nonexistent-cinna-probe' } }))
setTimeout(() => {
  if (rogue === '1') {
    const b = spawn(process.execPath, ['-e', 'const p=Buffer.from(JSON.stringify({id:3,method:"hello",params:{protocol:1}}));const h=Buffer.alloc(9);h.writeUInt32BE(5+p.length,0);h.writeUInt32BE(0,5);require("fs").writeSync(3,Buffer.concat([h,p]))'], { stdio: ['ignore', 'inherit', 'inherit', h.stdin] })
    b.on('exit', () => setTimeout(() => h.stdin.end(), 1500))
  } else {
    h.stdin.end()
  }
}, 1500)
`
function parentProbe({ env = {}, parentEnv = {}, rogue = false } = {}) {
  const r = spawnSync(process.execPath, ['-e', PROBE, HELPER, rogue ? '1' : '0'], {
    encoding: 'utf8', timeout: 20_000, env: { ...process.env, ...parentEnv, ...env }
  })
  try { return JSON.parse(r.stdout.trim().split('\n').pop()) } catch { return { replies: [], err: r.stderr + r.stdout, code: r.status } }
}
const nodeSigned = spawnSync('codesign', ['-dv', process.execPath], { encoding: 'utf8' }).stderr ?? ''
const nodeTeam = /TeamIdentifier=(\w+)/.exec(nodeSigned)?.[1]
const nodeIdent = /Identifier=(\S+)/.exec(nodeSigned)?.[1]
if (FLAVOR !== 'test') {
  say(`  SKIP parent-check probes: they need the test flavor's overrides (this helper is ${FLAVOR}; its parent is the signed stand-in)`)
} else {
  say('parent-check probes (D35)')
  const def = parentProbe()
  const h0 = def.replies.find((m) => m.id === 1)?.result
  check(h0?.parent?.verified === false && /is not io\.opencinna\.desktop signed as required/.test(h0.parent.detail) && h0.parent.trusted === true,
    'test flavor reports (does not enforce) that a node parent is not Cinna', JSON.stringify(h0?.parent))
  const enf = parentProbe({ env: { CINNA_VAULT_TEST_ENFORCE_PARENT: '1' } })
  check(enf.replies.find((m) => m.id === 2)?.error?.message === 'helper-untrusted', 'enforced: a parent that is not Cinna gets helper-untrusted', JSON.stringify(enf.replies))
  if (nodeTeam && nodeIdent && /flags=0x10000\(runtime\)/.test(nodeSigned) && /Developer ID Application/.test(spawnSync('codesign', ['-dvv', process.execPath], { encoding: 'utf8' }).stderr)) {
    const asNode = { CINNA_VAULT_TEST_ENFORCE_PARENT: '1', CINNA_VAULT_TEST_PARENT_IDENTIFIER: nodeIdent, CINNA_VAULT_TEST_PARENT_TEAM: nodeTeam }
    const ok = parentProbe({ env: asNode })
    const okHello = ok.replies.find((m) => m.id === 1)?.result
    check(okHello?.parent?.verified === true && ok.replies.find((m) => m.id === 2)?.result?.vaults?.length === 0,
      'enforced: a parent satisfying the requirement (Developer-ID node standing in for Cinna) is trusted', JSON.stringify(okHello?.parent))
    const run = parentProbe({ env: asNode, parentEnv: { ELECTRON_RUN_AS_NODE: '1' } })
    check(/runs as plain Node \(ELECTRON_RUN_AS_NODE\)/.test(run.replies.find((m) => m.id === 1)?.result?.parent?.detail ?? ''),
      'enforced: the same parent with ELECTRON_RUN_AS_NODE is refused', run.replies.find((m) => m.id === 1)?.result?.parent?.detail)
    const rogue = parentProbe({ env: asNode, rogue: true })
    check(rogue.code === 2 && /untrusted: stdin peer is now \d+\/-?\d+, not the verified parent/.test(rogue.err) && !rogue.replies.some((m) => m.id === 3),
      'enforced: a frame written by another process on the same stdin socket ends the helper (peer pinning)', `exit ${rogue.code}; ${/untrusted: [^\n]*/.exec(rogue.err)?.[0] ?? rogue.err.slice(-300)}`)
  } else {
    say('  SKIP trusted-parent probes: this node is not a hardened Developer-ID binary', process.execPath)
  }
  // (spawnSync's `input` is a socketpair too: hand it /dev/null instead.)
  const fileStdin = spawnSync(HELPER, [], { stdio: [openSync('/dev/null', 'r'), 'pipe', 'pipe'], encoding: 'utf8', timeout: 10_000, env: { ...process.env, CINNA_VAULT_TEST_ENFORCE_PARENT: '1' } })
  check(/stdin is not a socket/.test(fileStdin.stderr), 'stdin that is not a socket is untrusted', /start:[^\n]*/.exec(fileStdin.stderr)?.[0])
}

const helperEnv = {
  ...process.env, CINNA_VAULT_TEST_WINDOW_MS: String(WINDOW_MS), CINNA_VAULT_TEST_PAUSED_STOP_MS: String(PAUSED_STOP_MS),
  CINNA_VAULT_TEST_HOLD_MAX_MS: String(HOLD_MAX_MS), CINNA_VAULT_TEST_UNLOCK_DELAY_MS: String(UNLOCK_DELAY_MS),
  // vault-init kills vaultd once when the agent folder gets .cinna-smoke-killvaultd (the restart step).
  CINNA_VAULT_TEST_GUEST_SMOKE: 'killvaultd=touch'
}
const helper = spawn(HELPER, [], { stdio: ['pipe', 'pipe', 'pipe'], env: helperEnv })
helper.stderr.on('data', (d) => {
  for (const line of String(d).split('\n').filter(Boolean)) { stderrLog.push(line); console.log(stamp(), '  [helper]', line) }
})
const exited = new Promise((r) => helper.on('exit', (code, signal) => r({ code, signal, at: Date.now() })))

let nextId = 1
const pending = new Map()
const events = []
const eventWaiters = []
const channels = new Map() // id → {chunks: Buffer[], eof, rst, waiters}

let buf = Buffer.alloc(0)
helper.stdout.on('data', (d) => {
  buf = Buffer.concat([buf, d])
  while (buf.length >= 4) {
    const len = buf.readUInt32BE(0)
    if (buf.length < 4 + len) break
    const type = buf.readUInt8(4), ch = buf.readUInt32BE(5), payload = buf.subarray(9, 4 + len)
    buf = buf.subarray(4 + len)
    if (type === T.ctl) {
      const msg = JSON.parse(payload.toString('utf8'))
      if (msg.id !== undefined) {
        const p = pending.get(msg.id); pending.delete(msg.id)
        msg.error ? p.reject(Object.assign(new Error(`${msg.error.code}: ${msg.error.message}`), { code: msg.error.code })) : p.resolve(msg.result)
      } else {
        events.push({ ...msg, at: Date.now() })
        if (msg.event === 'vault.state') say('  event vault.state', msg.state, msg.until === undefined ? '' : `until=${msg.until === null ? 'null' : `+${msg.until - Date.now()}ms`}`, msg.error ?? '')
        else if (msg.event === 'egress') say('  event egress', msg.host, msg.verdict)
        else say('  event', JSON.stringify(msg))
        for (const w of [...eventWaiters]) if (w.pred(msg)) { eventWaiters.splice(eventWaiters.indexOf(w), 1); w.resolve(msg) }
      }
    } else {
      const c = channels.get(ch) ?? { chunks: [], eof: false, rst: null, waiters: [] }
      channels.set(ch, c)
      if (type === T.data) c.chunks.push(Buffer.from(payload))
      if (type === T.eof) c.eof = true
      if (type === T.rst) c.rst = payload.toString('utf8') || 'rst'
      for (const w of [...c.waiters]) w()
    }
  }
})

function call(method, params = {}) {
  const id = nextId++
  helper.stdin.write(frame(T.ctl, 0, Buffer.from(JSON.stringify({ id, method, params }))))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}
function waitEvent(pred, ms = 60_000) {
  return new Promise((resolve, reject) => {
    const w = { pred, resolve }
    eventWaiters.push(w)
    setTimeout(() => { const i = eventWaiters.indexOf(w); if (i >= 0) { eventWaiters.splice(i, 1); reject(new Error('event timeout')) } }, ms)
  })
}
const send = (ch, text) => helper.stdin.write(frame(T.data, ch, Buffer.from(text)))
function channelText(ch) { return Buffer.concat(channels.get(ch)?.chunks ?? []).toString('utf8') }
function waitChannel(ch, pred, ms = 30_000) {
  const c = channels.get(ch) ?? { chunks: [], eof: false, rst: null, waiters: [] }
  channels.set(ch, c)
  return new Promise((resolve, reject) => {
    const test = () => { if (pred(channelText(ch), c)) { c.waiters.splice(c.waiters.indexOf(test), 1); resolve(channelText(ch)) } }
    c.waiters.push(test)
    setTimeout(() => { const i = c.waiters.indexOf(test); if (i >= 0) { c.waiters.splice(i, 1); reject(new Error(`channel ${ch} timeout; got: ${channelText(ch).slice(-400)}`)) } }, ms)
    test()
  })
}
/** One vaultd JSON-RPC call on a fresh control channel. */
async function vaultd(vaultId, method, params = {}) {
  const { channel } = await call('channel.open', { vaultId })
  send(channel, '{"type":"control"}\n' + JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n')
  const text = await waitChannel(channel, (t) => t.split('\n').some((l) => { try { return JSON.parse(l).id === 1 } catch { return false } }))
  helper.stdin.write(frame(T.eof, channel))
  helper.stdin.write(frame(T.rst, channel))
  return { channel, reply: text.split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } }).find((m) => m?.id === 1) }
}

async function step(name, fn) {
  const s = Date.now()
  try {
    const r = await fn()
    say(`step ${name}: ${Date.now() - s} ms`)
    return r
  } catch (e) {
    failures++
    say(`FAIL step ${name} after ${Date.now() - s} ms: ${e.message}`)
    return undefined
  }
}

const vaultId = `smoke-${Math.random().toString(16).slice(2, 10)}`

// --keychain: a dev or release helper's keychain plumbing (D17) with no prompt:
// vault.create creates the Secure Enclave key (first time), wraps a disk key and
// signs vault.json with the group's HMAC key; vault.list verifies it, an edit is
// tampered, the original bytes verify again. Needs an unlocked screen (the SE
// key is WhenUnlockedThisDeviceOnly). Leaves one rollback-digest item in the
// group per run (deleting it needs vault.destroy, which prompts).
if (process.argv.includes('--keychain')) {
  const hello = await call('hello', { protocol: 1 })
  check(hello.flavor !== 'test', 'helper is dev or release', hello.flavor)
  const c = await call('vault.create', { dir: secureAgents, vaultId, agentId: 'folder:kc', agentName: 'Keychain probe', engine: 'claude', sizeBytes: 1024 ** 3, egress: { hosts: [] }, rootfsPath: ROOTFS }).catch((e) => e)
  check(c?.vault?.state === 'stopped', 'vault.create with the Secure Enclave key', c?.message ?? '')
  if (c?.vault) {
    const p = join(secureAgents, vaultId, 'vault.json'), orig = readFileSync(p)
    check(Buffer.from(JSON.parse(orig).vault.wrappedKey, 'base64').length === 124, 'disk key wrapped (ECIES blob, 124 bytes)')
    check((await call('vault.list', { dir: secureAgents })).vaults[0]?.state === 'stopped', 'signature + digest verify')
    writeFileSync(p, orig.toString().replace('"formatted":false', '"formatted":true'))
    check((await call('vault.list', { dir: secureAgents })).vaults[0]?.state === 'tampered', 'edited vault.json → tampered')
    writeFileSync(p, orig)
    check((await call('vault.list', { dir: secureAgents })).vaults[0]?.state === 'stopped', 'original bytes verify again')
  }
  // --presence: the real Touch ID / password prompts, a person at the Mac.
  // Four prompts: unlock (cold boot), unlock again (resume after a lock), an
  // export approval, and the destroy approval (which also removes this run's
  // keychain digest item).
  if (c?.vault && process.argv.includes('--presence')) {
    const ask = (what) => say(`>>> ${what}: approve the prompt that appears now (or cancel it to see a refusal)`)
    ask('1/4 unlock the vault (cold boot)')
    const u1 = await step('vault.unlock with Touch ID (cold boot + LUKS format)', () => call('vault.unlock', { vaultId, purpose: 'presence smoke' }))
    check(u1?.state === 'unlocked', 'unlocked after the prompt', JSON.stringify(u1))
    if (u1?.state === 'unlocked') {
      const h = await step('vaultd hello inside the VM', () => vaultd(vaultId, 'hello'))
      check(h?.reply?.result?.protocol === 1, 'vaultd answers over channel.open')
      await call('vault.lock', { vaultId })
      check((await call('vault.status', { vaultId })).state === 'locked', 'locked (key wiped, VM paused)')
      ask('2/4 unlock again (resume)')
      const u2 = await step('vault.unlock with Touch ID (resume)', () => call('vault.unlock', { vaultId, purpose: 'presence smoke resume' }))
      check(u2?.state === 'unlocked', 'resumed after the prompt', JSON.stringify(u2))
      ask('3/4 approve an export')
      const ex = await step('vault.approve export with Touch ID', () => call('vault.approve', { vaultId, action: 'export', detail: approvalDetail({ method: 'files.export', path: 'agent/presence.txt' }) }))
      check(typeof ex?.token === 'string', 'export approval token issued')
    }
    ask('4/4 approve deleting the probe vault')
    const ds = await step('vault.approve destroy with Touch ID', () => call('vault.approve', { vaultId, action: 'destroy', detail: approvalDetail({ method: 'vault.destroy' }) }))
    if (ds?.token) await step('vault.destroy', () => call('vault.destroy', { vaultId, token: ds.token }))
    check(!existsSync(join(secureAgents, vaultId)), 'probe vault deleted')
  }
  helper.stdin.end()
  await exited
  rmSync(dir, { recursive: true, force: true })
  say(failures === 0 ? 'ALL PASSED' : `${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

try {
  const hello = await step('hello', () => call('hello', { protocol: 1 }))
  check(hello?.flavor === 'test', 'hello reports the test flavor', JSON.stringify(hello))
  check(/^[0-9a-f]{64}$/.test(hello?.guest?.rootHash ?? ''), 'hello carries the compiled guest root hash')
  const bad = await call('hello', { protocol: 2 }).catch((e) => e)
  check(bad.code === 'invalid', 'hello refuses another protocol version')

  const avail = await step('availability', () => call('availability'))
  check(avail?.ok === true, 'availability ok', JSON.stringify(avail))

  const badName = await call('vault.create', {
    dir: secureAgents, vaultId, agentId: 'folder:smoke', agentName: 'Smoke \u201CAgent\u201D\n\u202Eevil',
    engine: 'claude', sizeBytes: 1024 ** 3, egress: { hosts: [] }, rootfsPath: ROOTFS
  }).catch((e) => e)
  check(badName.code === 'invalid', 'L1: an agent name with quotes, a newline or a bidi override is refused', badName.message)
  const created = await step('vault.create', () => call('vault.create', {
    dir: secureAgents, vaultId, agentId: 'folder:smoke', agentName: "Smoke Agent's (v1.0)",
    engine: 'claude', sizeBytes: 1024 ** 3, egress: { hosts: ['API.anthropic.com', 'api.anthropic.com'] }, rootfsPath: ROOTFS
  }))
  check(created?.vault?.state === 'stopped', 'created vault is stopped', JSON.stringify(created?.vault))
  check(JSON.stringify(created?.vault?.egress) === '{"hosts":["api.anthropic.com"]}', 'egress hosts canonicalised')
  const dup = await call('vault.create', { dir: secureAgents, vaultId, agentId: 'x', agentName: 'x', engine: 'claude', sizeBytes: 1024 ** 3, egress: { hosts: [] }, rootfsPath: ROOTFS }).catch((e) => e)
  check(dup.code === 'busy', 'a second create with the same id is refused')
  const badId = await call('vault.create', { dir: secureAgents, vaultId: '../x', agentId: 'x', agentName: 'x', engine: 'claude', sizeBytes: 1024 ** 3, egress: { hosts: [] }, rootfsPath: ROOTFS }).catch((e) => e)
  check(badId.code === 'invalid', 'a path-like vaultId is refused')
  const vj = readVault(vaultId)
  check(vj.formatted === false && vj.wrappedKey === 'test-flavor-plaintext', 'vault.json: not formatted, test-flavor key marker')
  check(!existsSync(join(secureAgents, vaultId, 'vault.json.sig')), 'M1: signature lives inside vault.json (no .sig file)')
  check(readFileSync(join(secureAgents, vaultId, 'test-digest.current'), 'utf8') === sha(readFileSync(join(secureAgents, vaultId, 'vault.json'), 'utf8')) &&
    !existsSync(join(secureAgents, vaultId, 'test-digest.pending')), 'M1: current digest slot recorded, pending slot cleared')

  const listed = await step('vault.list', () => call('vault.list', { dir: secureAgents }))
  check(listed?.vaults?.length === 1 && listed.vaults[0].vaultId === vaultId, 'vault.list finds it')
  const otherDir = await call('vault.list', { dir: join(dir, 'Elsewhere') }).catch((e) => e)
  check(otherDir.code === 'invalid', 'M5: a second SecureAgents dir is refused', otherDir.message)

  const preLocked = await call('channel.open', { vaultId }).catch((e) => e)
  check(preLocked.code === 'locked', 'channel.open refused while stopped')

  const firstBoot = await step('vault.unlock (cold boot + LUKS format)', () => call('vault.unlock', { vaultId, purpose: 'smoke' }))
  check(firstBoot?.state === 'unlocked', 'unlock → unlocked')
  check(stderrLog.some((l) => l.includes("unlock the vault of agent \u201CSmoke Agent's (v1.0)\u201D")), 'unlock reason names the agent')
  const vj2 = readVault(vaultId)
  check(vj2.formatted === true, 'vault.json marked formatted after the guest answered')

  const h = await step('vaultd hello over channel.open', () => vaultd(vaultId, 'hello'))
  check(h?.reply?.result?.protocol === 1 && h.reply.result.fake === false, 'vaultd answers hello inside the VM', JSON.stringify(h?.reply?.result))
  await step('layout.ensure', () => vaultd(vaultId, 'layout.ensure'))

  // Guest-verified token: accepted by vaultd for the right call, refused when forged.
  const exp = await step('vault.approve export', () => call('vault.approve', { vaultId, action: 'export', detail: approvalDetail({ method: 'files.export', path: 'agent/missing.txt' }) }))
  check(events.some((e) => e.event === 'log' && /test gate granted: export \u201Cagent\/missing\.txt\u201D from the vault of agent/.test(e.message)), 'approve prompt text is composed by the helper')
  // vaultd resolves an export path before the token, so the token checks go through exec:
  // a forged terminal token and an export token used for a terminal are both refused.
  const term0 = await call('vault.approve', { vaultId, action: 'terminal', detail: approvalDetail({ method: 'exec', preset: 'shell' }) })
  const forged = term0.token.slice(0, -4) + (term0.token.endsWith('AAAA') ? 'BBBB' : 'AAAA')
  const noTok = await vaultd(vaultId, 'exec', { preset: 'shell', token: forged })
  check(noTok.reply?.error?.data?.code === 'bad_token', 'vaultd refuses a forged token', JSON.stringify(noTok.reply?.error))
  const wrongAction = await vaultd(vaultId, 'exec', { preset: 'shell', token: exp?.token })
  check(wrongAction.reply?.error?.data?.code === 'bad_token', 'vaultd refuses an export token for a terminal', JSON.stringify(wrongAction.reply?.error))
  const badDetail = await call('vault.approve', { vaultId, action: 'terminal', detail: 'run anything' }).catch((e) => e)
  check(badDetail.code === 'invalid', 'approve refuses a non-canonical terminal detail')

  // L1: main's free text for move-in/install is logged, never part of the prompt.
  const inst0 = await call('vault.approve', { vaultId, action: 'install', detail: 'EVIL-PROMPT-TEXT click allow' })
  const grant = [...events].reverse().find((e) => e.event === 'log' && /test gate granted: install/.test(e.message))?.message ?? ''
  check(grant === "test gate granted: install or update dependencies in the vault of agent \u201CSmoke Agent's (v1.0)\u201D", 'L1: install prompt carries no main-supplied text', grant)
  const credOf = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()).proxyCred
  check(/^[0-9a-f]{32}$/.test(credOf(inst0.token) ?? ''), 'D37: an install approval carries a 32-hex proxyCred claim')
  const termTok = await call('vault.approve', { vaultId, action: 'terminal', detail: approvalDetail({ method: 'exec', preset: 'shell' }) })
  check(credOf(termTok.token) === undefined, 'D37: a terminal approval carries no proxyCred')

  /** Runs `script` in a fresh gated terminal inside the guest; resolves with its output. */
  async function guestShell(script, done) {
    const term = await call('vault.approve', { vaultId, action: 'terminal', detail: approvalDetail({ method: 'exec', preset: 'shell' }) })
    const { reply } = await vaultd(vaultId, 'exec', { preset: 'shell', token: term.token })
    if (!reply?.result?.stream) throw new Error(`exec: ${JSON.stringify(reply)}`)
    const { channel } = await call('channel.open', { vaultId })
    send(channel, JSON.stringify({ type: 'attach', stream: reply.result.stream }) + '\n')
    send(channel, script + '; echo SHELL-DONE; exit\n')
    const out = await waitChannel(channel, (t, c) => c.eof || c.rst || /SHELL-DONE\s/.test(t), 90_000)
    helper.stdin.write(frame(T.rst, channel))
    return out
  }
  // http_code / CONNECT response code for one URL, optionally through an explicit proxy credential.
  const probeCmd = (tag, url, cred) =>
    `curl -sS -o /dev/null --max-time 20 -w "${tag}=%{http_code}/%{http_connect}\\n" ${cred ? `-x http://cinna:${cred}@127.0.0.1:3128 ` : ''}${url} 2>/dev/null || true`
  const codeOf = (out, tag) => new RegExp(`${tag}=(\\d+)/(\\d+)`).exec(out)?.slice(1).join('/')

  if (!NO_NET) {
    await step('egress from inside the guest', async () => {
      const cred = credOf(inst0.token)
      const out = await guestShell([
        probeCmd('ALLOWED', 'https://api.anthropic.com/'),
        'curl -sS -o /dev/null https://example.com/ 2>&1 | head -1 | sed "s/^/DENIED=/"',
        'ip -o link | wc -l | sed "s/^/LINKS=/"',
        probeCmd('NOCRED', 'https://pypi.org/simple/'),
        probeCmd('BADCRED', 'https://pypi.org/simple/', '0'.repeat(32)),
        probeCmd('WITHCRED', 'https://pypi.org/simple/', cred),
        probeCmd('CREDOTHER', 'https://example.com/', cred)
      ].join('; '))
      const allowed = /ALLOWED=(\d+)/.exec(out)?.[1]
      check(allowed && allowed !== '000', 'allowlisted host reachable through the proxy (no credential needed)', `http ${allowed}`)
      check(/DENIED=.*(403|CONNECT tunnel failed)/.test(out), 'non-allowlisted host refused with 403', /DENIED=.*/.exec(out)?.[0] ?? out.slice(-300))
      check(/LINKS=1\b/.test(out), 'guest has only lo', /LINKS=\d+/.exec(out)?.[0])
      check(events.some((e) => e.event === 'egress' && e.host === 'example.com' && e.verdict === 'denied'), 'egress event: example.com denied')
      check(codeOf(out, 'NOCRED') === '000/403', 'D37: install host refused without a proxy credential', codeOf(out, 'NOCRED'))
      check(codeOf(out, 'BADCRED') === '000/403', 'D37: install host refused with an unknown credential', codeOf(out, 'BADCRED'))
      check(/^[23]\d\d\/200$/.test(codeOf(out, 'WITHCRED') ?? ''), 'D37: install host allowed with the approval\'s credential', codeOf(out, 'WITHCRED'))
      check(codeOf(out, 'CREDOTHER') === '000/403', 'D37: the credential opens install hosts only', codeOf(out, 'CREDOTHER'))
    })

    await step('install credential revoked at exec-end', async () => {
      const inst = await call('vault.approve', { vaultId, action: 'install', detail: 'exec-end probe' })
      const cred = credOf(inst.token)
      // uv-python-install carries the credential (D37); `check` (agent code) never does.
      const { reply } = await vaultd(vaultId, 'exec', { preset: 'uv-python-install', token: inst.token })
      if (!reply?.result?.stream) throw new Error(`exec uv-python-install: ${JSON.stringify(reply)}`)
      const { channel } = await call('channel.open', { vaultId })
      send(channel, JSON.stringify({ type: 'attach', stream: reply.result.stream }) + '\n')
      await waitChannel(channel, (t, c) => c.eof || c.rst, 120_000).catch(() => {})
      helper.stdin.write(frame(T.rst, channel))
      await new Promise((r) => setTimeout(r, 1500))
      const unsupported = stderrLog.some((l) => l.includes('no subscribe support'))  // refused, closed or silent
      const revoked = stderrLog.some((l) => l.includes('install credential revoked'))
      const out = await guestShell(probeCmd('AFTEREND', 'https://pypi.org/simple/', cred))
      if (unsupported) {
        say('  SKIP exec-end revocation: this guest image closes the subscribe connection (older vaultd); after exec:', codeOf(out, 'AFTEREND'))
      } else {
        check(revoked && codeOf(out, 'AFTEREND') === '000/403', 'D37: install host refused once vaultd reported exec-end', `${codeOf(out, 'AFTEREND')}, revoked log ${revoked}`)
      }
    })

    // D37 fail closed: a vaultd restart drops the event subscription; every live credential is
    // revoked then, and the helper reopens the subscription (vault-init's killvaultd=touch hook).
    await step('vaultd restart: credentials revoked, subscription back', async () => {
      // Waiting for the reopen involves no gated action: hold the vault open past the short window.
      await call('vault.hold', { vaultId, holdId: 'restart-probe' })
      try { await restartProbe() } finally { await call('vault.release', { vaultId, holdId: 'restart-probe' }).catch(() => {}) }
    })
    async function restartProbe() {
      const inst = await call('vault.approve', { vaultId, action: 'install', detail: 'restart probe' })
      const cred = credOf(inst.token)
      const before = await guestShell(probeCmd('BEFOREKILL', 'https://pypi.org/simple/', cred))
      const opens = () => stderrLog.filter((l) => l.includes('event subscription open')).length
      const opened0 = opens()
      const closed0 = stderrLog.filter((l) => l.includes('event subscription closed')).length
      await guestShell('touch /vault/agent/.cinna-smoke-killvaultd').catch(() => {})
      const t = Date.now()
      while (Date.now() - t < 30_000 && opens() <= opened0) await new Promise((r) => setTimeout(r, 200))
      const closed = stderrLog.filter((l) => l.includes('event subscription closed')).length > closed0
      check(closed && opens() > opened0, 'D37: the helper sees the subscription drop and reopens it after vaultd restarts', `closed ${closed}, opens ${opened0} → ${opens()}`)
      const after = await guestShell(probeCmd('AFTERKILL', 'https://pypi.org/simple/', cred))
      check(/^[23]\d\d\/200$/.test(codeOf(before, 'BEFOREKILL') ?? '') && codeOf(after, 'AFTERKILL') === '000/403',
        'D37: a credential live before the drop is refused after it (fail closed)', `${codeOf(before, 'BEFOREKILL')} → ${codeOf(after, 'AFTERKILL')}`)
      // The reopened subscription carries exec-end again.
      const inst2 = await call('vault.approve', { vaultId, action: 'install', detail: 'after restart probe' })
      const cred2 = credOf(inst2.token)
      const revokedBefore = stderrLog.filter((l) => l.includes('install credential revoked')).length
      const { reply } = await vaultd(vaultId, 'exec', { preset: 'uv-python-install', token: inst2.token })
      if (!reply?.result?.stream) throw new Error(`exec uv-python-install: ${JSON.stringify(reply)}`)
      const { channel } = await call('channel.open', { vaultId })
      send(channel, JSON.stringify({ type: 'attach', stream: reply.result.stream }) + '\n')
      await waitChannel(channel, (t2, c) => c.eof || c.rst, 120_000).catch(() => {})
      helper.stdin.write(frame(T.rst, channel))
      await new Promise((r) => setTimeout(r, 1500))
      const out2 = await guestShell(probeCmd('AFTEREND2', 'https://pypi.org/simple/', cred2))
      check(stderrLog.filter((l) => l.includes('install credential revoked')).length > revokedBefore && codeOf(out2, 'AFTEREND2') === '000/403',
        'D37: exec-end over the reopened subscription revokes the credential', codeOf(out2, 'AFTEREND2'))
    }
  }

  // Holds keep it open; the window closes WINDOW_MS after the last release.
  await call('vault.hold', { vaultId, holdId: 'turn-1' })
  const held = await call('vault.status', { vaultId })
  check(held.state === 'unlocked' && held.until === null, 'held: until is null')
  await new Promise((r) => setTimeout(r, WINDOW_MS + 500))
  check((await call('vault.status', { vaultId })).state === 'unlocked', 'still unlocked past the window while held')
  const released = Date.now()
  const lockedEv = waitEvent((e) => e.event === 'vault.state' && e.vaultId === vaultId && e.state === 'locked', WINDOW_MS + 20_000)
  await call('vault.release', { vaultId, holdId: 'turn-1' })
  await step('window expiry → locked', () => lockedEv)
  say(`  locked ${Date.now() - released} ms after release (window ${WINDOW_MS} ms)`)
  const lockedCh = await call('channel.open', { vaultId }).catch((e) => e)
  check(lockedCh.code === 'locked', 'channel.open refused while locked')
  const holdLocked = await call('vault.hold', { vaultId, holdId: 'turn-2' }).catch((e) => e)
  check(holdLocked.code === 'locked', 'hold refused while locked')

  const resumed = await step('vault.unlock (resume from pause)', () => call('vault.unlock', { vaultId, purpose: 'smoke resume' }))
  check(resumed?.state === 'unlocked', 'resume → unlocked', JSON.stringify(resumed))
  if (resumed?.state === 'unlocked') {
    const h2 = await step('vaultd hello after resume', () => vaultd(vaultId, 'hello'))
    check(h2?.reply?.result?.protocol === 1, 'vaultd answers after resume')
  }

  if (!NO_NET) {
    await step('install credential revoked by lock', async () => {
      if ((await call('vault.status', { vaultId })).state !== 'unlocked') await call('vault.unlock', { vaultId, purpose: 'smoke' })
      const inst = await call('vault.approve', { vaultId, action: 'install', detail: 'lock probe' })
      const before = await guestShell(probeCmd('BEFORELOCK', 'https://pypi.org/simple/', credOf(inst.token)))
      await call('vault.lock', { vaultId })
      await call('vault.unlock', { vaultId, purpose: 'smoke' })
      const after = await guestShell(probeCmd('AFTERLOCK', 'https://pypi.org/simple/', credOf(inst.token)))
      check(/^[23]\d\d\/200$/.test(codeOf(before, 'BEFORELOCK') ?? '') && codeOf(after, 'AFTERLOCK') === '000/403',
        'D37: a credential that worked before a lock is refused after it', `${codeOf(before, 'BEFORELOCK')} → ${codeOf(after, 'AFTERLOCK')}`)
    })
  }

  // D40: a hold keeps the window open for at most HOLD_MAX_MS.
  await step('hold capped (D40)', async () => {
    if ((await call('vault.status', { vaultId })).state !== 'unlocked') await call('vault.unlock', { vaultId, purpose: 'smoke' })
    const heldAt = Date.now()
    const lockedByCap = waitEvent((e) => e.event === 'vault.state' && e.vaultId === vaultId && e.state === 'locked', HOLD_MAX_MS + WINDOW_MS + 15_000)
    await call('vault.hold', { vaultId, holdId: 'forever' })
    await lockedByCap
    const took = Date.now() - heldAt
    check(took >= HOLD_MAX_MS && took < HOLD_MAX_MS + WINDOW_MS + 5000, 'a hold that is never released stops counting after the cap', `${took} ms (cap ${HOLD_MAX_MS} + window ${WINDOW_MS})`)
  })

  // D40: lock wins over an unlock whose prompt is still up (test delay UNLOCK_DELAY_MS).
  await step('lock during a pending resume (D40)', async () => {
    const pendingUnlock = call('vault.unlock', { vaultId, purpose: 'race' }).then((r) => r, (e) => e)
    await new Promise((r) => setTimeout(r, UNLOCK_DELAY_MS / 3))
    helper.kill('SIGUSR1')
    const r = await pendingUnlock
    const st = (await call('vault.status', { vaultId })).state
    check(r.code === 'locked' && st === 'locked', 'an unlock pending when the screen locks ends locked', `${r.code ?? r.state}: ${r.message ?? ''}; state ${st}`)
  })

  // Screen-lock stand-in.
  if ((await call('vault.status', { vaultId })).state !== 'unlocked') await call('vault.unlock', { vaultId, purpose: 'smoke' })
  check((await call('vault.status', { vaultId })).until !== null, 'D40: holds were cleared by the lock (window runs again)')
  const sigLocked = waitEvent((e) => e.event === 'vault.state' && e.vaultId === vaultId && (e.state === 'locked' || e.state === 'stopped'), 20_000)
  helper.kill('SIGUSR1')
  const sl = await step('SIGUSR1 (screen lock) → locked', () => sigLocked)
  check(sl?.state === 'locked', 'screen lock pauses the vault', sl?.state)

  // Helper-verified tokens.
  const eg = await call('vault.approve', { vaultId, action: 'egress', detail: approvalDetail({ method: 'vault.setEgress', policy: { hosts: ['PyPI.org', 'api.anthropic.com'] } }) })
  const wrongPolicy = await call('vault.setEgress', { vaultId, policy: { hosts: ['evil.example.com'] }, token: eg.token }).catch((e) => e)
  check(wrongPolicy.code === 'bad_token', 'setEgress refuses a token approved for another policy')
  await call('vault.setEgress', { vaultId, policy: { hosts: ['pypi.org', 'api.anthropic.com'] }, token: eg.token })
  check(JSON.stringify((await call('vault.status', { vaultId })).egress.hosts) === '["api.anthropic.com","pypi.org"]', 'setEgress applied')
  const replay = await call('vault.setEgress', { vaultId, policy: { hosts: ['pypi.org', 'api.anthropic.com'] }, token: eg.token }).catch((e) => e)
  check(replay.code === 'bad_token', 'helper token is single use')
  const rs = await call('vault.approve', { vaultId, action: 'resize', detail: approvalDetail({ method: 'vault.resize', sizeBytes: 2 * 1024 ** 3 }) })
  await call('vault.resize', { vaultId, sizeBytes: 2 * 1024 ** 3, token: rs.token })
  check(readVault(vaultId).pendingGrowTo === 2 * 1024 ** 3, 'resize records pendingGrowTo')

  // Lock timeout: 5 min by default; shorter needs no token, longer a lock-timeout token for exactly that value.
  check((await call('vault.status', { vaultId })).lockAfterMs === 300_000, 'lock timeout defaults to 5 minutes')
  await call('vault.setLockTimeout', { vaultId, lockAfterMs: 30_000 })
  check(readVault(vaultId).lockAfterMs === 30_000, 'a shorter lock timeout is saved without a token')
  const noToken = await call('vault.setLockTimeout', { vaultId, lockAfterMs: 0 }).catch((e) => e)
  check(noToken.code === 'bad_token', 'a longer lock timeout without a token is refused', noToken.code)
  const lt = await call('vault.approve', { vaultId, action: 'lock-timeout', detail: approvalDetail({ method: 'vault.setLockTimeout', lockAfterMs: 0 }) })
  const wrongValue = await call('vault.setLockTimeout', { vaultId, lockAfterMs: 300_000, token: lt.token }).catch((e) => e)
  check(wrongValue.code === 'bad_token', 'a lock-timeout token is for exactly one value', wrongValue.code)
  const odd = await call('vault.setLockTimeout', { vaultId, lockAfterMs: 60_000 }).catch((e) => e)
  check(odd.code === 'invalid', 'a timeout not offered is invalid', odd.code)
  const lt2 = await call('vault.approve', { vaultId, action: 'lock-timeout', detail: approvalDetail({ method: 'vault.setLockTimeout', lockAfterMs: 300_000 }) })
  await call('vault.setLockTimeout', { vaultId, lockAfterMs: 300_000, token: lt2.token })
  check(readVault(vaultId).lockAfterMs === 300_000 && (await call('vault.status', { vaultId })).lockAfterMs === 300_000, 'a longer lock timeout is saved with its token')

  // D33: a paused vault is stopped cold after PAUSED_STOP_MS; the next unlock boots and grows the disk.
  const coldEv = await step('paused → stopped (D33)', () => waitEvent((e) => e.event === 'vault.state' && e.vaultId === vaultId && e.state === 'stopped', PAUSED_STOP_MS + 10_000))
  check(coldEv?.state === 'stopped', 'paused vault stopped cold after the paused limit')
  await step('vault.unlock (cold boot + grow)', () => call('vault.unlock', { vaultId, purpose: 'grow' }))
  const grown = readVault(vaultId)
  check(grown.sizeBytes === 2 * 1024 ** 3 && grown.pendingGrowTo === undefined, 'grow applied and recorded', JSON.stringify({ size: grown.sizeBytes, pending: grown.pendingGrowTo }))
  const usage = await vaultd(vaultId, 'disk.usage')
  check(usage.reply?.result?.sizeBytes > 1.9 * 1024 ** 3, 'guest sees the grown filesystem', JSON.stringify(usage.reply?.result ?? usage.reply?.error))

  // vault.touch restarts an unlocked vault's window (the test window override still sets its length).
  const before = (await call('vault.status', { vaultId })).until
  await new Promise((r) => setTimeout(r, 300))
  await call('vault.touch', { vaultId })
  const after = (await call('vault.status', { vaultId })).until
  check(typeof before === 'number' && typeof after === 'number' && after > before, 'touch moves the unlock deadline', `${before} → ${after}`)

  // Lock → stop cold via destroy-less path: lock is a no-op when locked; tamper needs a stopped VM.
  const stopEv = waitEvent((e) => e.event === 'vault.state' && e.vaultId === vaultId && e.state === 'stopped', 20_000).catch(() => null)
  const ds = await call('vault.approve', { vaultId, action: 'destroy', detail: approvalDetail({ method: 'vault.destroy' }) })
  // Tamper check on a copy first: flip a byte in a second vault's vault.json.
  const otherId = `${vaultId}-b`
  await call('vault.create', { dir: secureAgents, vaultId: otherId, agentId: 'folder:b', agentName: 'B', engine: 'claude', sizeBytes: 1024 ** 3, egress: { hosts: [] }, rootfsPath: ROOTFS })
  const p = join(secureAgents, otherId, 'vault.json')
  writeFileSync(p, readFileSync(p, 'utf8').replace('"egress":{"hosts":[]}', '"egress":{"hosts":["evil.example.com"]}'))
  const afterTamper = await call('vault.list', { dir: secureAgents })
  check(afterTamper.vaults.find((v) => v.vaultId === otherId)?.state === 'tampered', 'edited vault.json → tampered')
  const tUnlock = await call('vault.unlock', { vaultId: otherId, purpose: 'x' }).catch((e) => e)
  check(tUnlock.code === 'tampered', 'a tampered vault does not unlock')

  // M1: the pending/current digest slots (test flavor keeps them as files beside test.key).
  await step('digest slots (M1)', async () => {
    const dId = `${vaultId}-d`
    await call('vault.create', { dir: secureAgents, vaultId: dId, agentId: 'folder:d', agentName: 'D', engine: 'claude', sizeBytes: 1024 ** 3, egress: { hosts: [] }, rootfsPath: ROOTFS })
    const vdir = join(secureAgents, dId), file = join(vdir, 'vault.json'), cur = join(vdir, 'test-digest.current'), pend = join(vdir, 'test-digest.pending')
    const stateOf = async () => (await call('vault.list', { dir: secureAgents })).vaults.find((v) => v.vaultId === dId)
    const f1 = readFileSync(file, 'utf8')
    writeFileSync(pend, 'junk')
    check((await stateOf()).state === 'stopped' && !existsSync(pend), 'a junk pending slot is dropped; the current file still verifies')
    // A save interrupted after the file write: pending = new file, current = old.
    const f2 = signedFile(bodyOf(f1).replace('"egress":{"hosts":[]}', '"egress":{"hosts":["pypi.org"]}'))
    writeFileSync(pend, sha(f2)); writeFileSync(file, f2)
    const v2 = await stateOf()
    check(v2.state === 'stopped' && v2.egress.hosts[0] === 'pypi.org' && readFileSync(cur, 'utf8') === sha(f2) && !existsSync(pend),
      'an interrupted save (file written, current not) is finished on load', JSON.stringify({ state: v2.state, egress: v2.egress }))
    // A save interrupted before the file write: pending = new file, file still old.
    const f3 = signedFile(bodyOf(f2).replace('"pypi.org"', '"files.pythonhosted.org"'))
    writeFileSync(pend, sha(f3))
    check((await stateOf()).state === 'stopped' && !existsSync(pend), 'a save interrupted before the file write keeps the current file')
    // Rollback: the older, validly signed f1.
    writeFileSync(file, f1)
    check((await stateOf()).state === 'tampered', 'an older validly signed vault.json is a rollback (tampered)')
    writeFileSync(file, f2)
    check((await stateOf()).state === 'stopped', 'the current file verifies again')
  })

  // H3/D38: if formatted:true cannot be recorded, the unlock fails and the VM is stopped.
  await step('formatted:true not recorded (D38)', async () => {
    const eId = `${vaultId}-e`
    await call('vault.create', { dir: secureAgents, vaultId: eId, agentId: 'folder:e', agentName: 'E', engine: 'claude', sizeBytes: 1024 ** 3, egress: { hosts: [] }, rootfsPath: ROOTFS })
    const vdir = join(secureAgents, eId)
    writeFileSync(join(vdir, 'console.log'), '')
    chmodSync(vdir, 0o500)  // the digest slot and the atomic vault.json write now fail
    try {
      const r = await call('vault.unlock', { vaultId: eId, purpose: 'h3' }).catch((e) => e)
      const st = await call('vault.status', { vaultId: eId })
      check(r.code === 'internal' && /could not record/.test(r.message) && st.state === 'error', 'the unlock fails and the vault is stopped in error', `${r.code}: ${r.message}; state ${st.state}`)
    } finally {
      chmodSync(vdir, 0o700)
    }
  })

  await step('vault.destroy', () => call('vault.destroy', { vaultId, token: ds.token }))
  await stopEv
  check(!existsSync(join(secureAgents, vaultId)), 'destroy removed the vault folder')

  // A running vault, then stdin close ⇒ the helper stops it and exits.
  const third = `${vaultId}-c`
  await call('vault.create', { dir: secureAgents, vaultId: third, agentId: 'folder:c', agentName: 'C', engine: 'claude', sizeBytes: 1024 ** 3, egress: { hosts: [] }, rootfsPath: ROOTFS })
  await step('lock during a pending cold boot (D40)', async () => {
    const pendingUnlock = call('vault.unlock', { vaultId: third, purpose: 'race' }).then((r) => r, (e) => e)
    await new Promise((r) => setTimeout(r, UNLOCK_DELAY_MS / 3))
    helper.kill('SIGUSR1')
    const r = await pendingUnlock
    const st = (await call('vault.status', { vaultId: third })).state
    check(r.code === 'locked' && st === 'stopped', 'an unlock pending when the screen locks never boots', `${r.code ?? r.state}: ${r.message ?? ''}; state ${st}`)
  })
  await step('vault.unlock third vault', () => call('vault.unlock', { vaultId: third, purpose: 'exit test' }))

  // A second helper on the same SecureAgents dir: data.img is flock'ed (D40),
  // and a helper whose session reports a locked screen refuses to unlock.
  const otherHelper = async (extraEnv) => {
    const h = spawn(HELPER, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...helperEnv, ...extraEnv } })
    let out = Buffer.alloc(0)
    const waiting = new Map()
    h.stdout.on('data', (d) => {
      out = Buffer.concat([out, d])
      while (out.length >= 4 && out.length >= 4 + out.readUInt32BE(0)) {
        const n = out.readUInt32BE(0), m = JSON.parse(out.subarray(9, 4 + n).toString()); out = out.subarray(4 + n)
        if (m.id !== undefined) waiting.get(m.id)?.(m)
      }
    })
    h.stderr.on('data', () => {})
    let id = 0
    const rpc = (method, params) => new Promise((r) => { const i = ++id; waiting.set(i, r); h.stdin.write(frame(T.ctl, 0, Buffer.from(JSON.stringify({ id: i, method, params })))) })
    await rpc('vault.list', { dir: secureAgents })
    const r = await rpc('vault.unlock', { vaultId: third, purpose: 'second helper' })
    h.stdin.end()
    await new Promise((res) => h.on('exit', res))
    return r
  }
  const second = await step('second helper, same disk', () => otherHelper({}))
  check(second?.error?.code === 'internal' && /another process is using this vault's disk/.test(second.error.message), 'D40: a second helper cannot boot a disk the first holds', JSON.stringify(second?.error))
  const screen = await step('helper with a locked screen', () => otherHelper({ CINNA_VAULT_TEST_SCREEN_LOCKED: '1' }))
  check(screen?.error?.code === 'denied' && /screen is locked/.test(screen.error.message), 'D40: unlock refused while the screen is locked', JSON.stringify(screen?.error))
  check((await call('vault.status', { vaultId: third })).state === 'unlocked', 'the first helper\'s vault is unaffected')
} catch (e) {
  failures++
  say('FAIL', e.stack)
}

const closedAt = Date.now()
helper.stdin.end()
const ex = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 10_000))])
check(ex !== null && ex.code === 0, 'stdin close ⇒ helper stops its VMs and exits 0', ex ? `in ${ex.at - closedAt} ms` : 'did not exit')
if (ex === null) helper.kill('SIGKILL')
if (!KEEP) rmSync(dir, { recursive: true, force: true })
else say('kept', dir)
say(failures === 0 ? 'ALL PASSED' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
