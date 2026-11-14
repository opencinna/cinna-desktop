'use strict'
// Agent Vault boot step, run once by /sbin/vault-init with the helper's boot message on stdin
// (piped from vsock 1090, never stored): one JSON line
//   {diskKey: hex, approvalKey: hex, format: boolean, growTo?: bytes, vaultId: string}
// The disk key is the 64-char lowercase hex string itself, handed to cryptsetup as ASCII bytes on
// stdin only (never argv, env or a file); vaultd's luksResume passes the same bytes. The approval
// key is written to /run/vault/approval.key (tmpfs, 0600) and the vault id to /run/vault/vault-id
// (0600); cinna-vaultd reads both to verify approval tokens.
//
// Key bytes never become JS strings (D39): the line stays a Buffer, both keys are cut out of it by
// byte search and blanked before the rest is JSON-parsed, and every copy is zeroed.
// A disk that already holds LUKS is never formatted again (D38): `format` then opens it, and
// makes a filesystem only if `blkid -p` finds none (a first boot cut off before mkfs).
// The console gets fixed status words only (D36): no paths, ids or tool output.
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')

const DATA_DEV = '/dev/vdb'
const MAPPER = 'vault'
const MOUNT = '/vault'
const APPROVAL_KEY = '/run/vault/approval.key'
const VAULT_ID = '/run/vault/vault-id'

/** Fixed words only: `VAULT boot failed <step>`. */
function fail(step) {
  process.stdout.write(`VAULT boot failed ${step}\n`)
  process.exit(1)
}

/** Runs a tool with its output discarded (it would name devices and paths on the console). */
function run(step, cmd, args, input, okStatus = [0]) {
  const r = spawnSync(cmd, args, {
    input: input ?? Buffer.alloc(0),
    stdio: ['pipe', 'ignore', 'ignore'],
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' }
  })
  if (r.error || !okStatus.includes(r.status)) fail(step)
  return r.status
}

function readLine() {
  const chunks = []
  let total = 0
  const buf = Buffer.alloc(4096)
  for (;;) {
    let n
    try {
      n = fs.readSync(0, buf, 0, buf.length, null)
    } catch (e) {
      if (e.code === 'EAGAIN') continue
      if (e.code === 'EOF') break
      throw e
    }
    if (n === 0) break
    chunks.push(Buffer.from(buf.subarray(0, n)))
    total += n
    if (buf.subarray(0, n).includes(0x0a)) break
    if (total > 64 * 1024) {
      buf.fill(0)
      for (const c of chunks) c.fill(0)
      fail('message')
    }
  }
  buf.fill(0)
  const all = Buffer.concat(chunks)
  for (const c of chunks) c.fill(0)
  const nl = all.indexOf(0x0a)
  if (nl >= 0) all.fill(0, nl)
  return nl >= 0 ? all.subarray(0, nl) : all
}

const isLowerHex = (b) => (b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x66)

/**
 * Cuts the string value of `"<field>"` out of `line` as a fresh Buffer and overwrites it in
 * `line` with ASCII `0`. Null when the field is missing, not a string, or not lowercase hex.
 */
function takeHex(line, field) {
  const name = Buffer.from(`"${field}"`)
  const at = line.indexOf(name)
  if (at === -1) return null
  let i = at + name.length
  while (line[i] === 0x20 || line[i] === 0x09) i++
  if (line[i] !== 0x3a) return null
  i++
  while (line[i] === 0x20 || line[i] === 0x09) i++
  if (line[i] !== 0x22) return null
  const start = i + 1
  let end = start
  while (end < line.length && line[end] !== 0x22) end++
  if (end >= line.length) return null
  let ok = true
  for (let k = start; k < end; k++) if (!isLowerHex(line[k])) ok = false
  const value = ok ? Buffer.from(line.subarray(start, end)) : null
  line.fill(0x30, start, end)
  return value
}

/**
 * The boot message as {diskKey: Buffer, approvalKey: Buffer, format, growTo, vaultId}, or a
 * fixed failure word. `line` is zeroed.
 */
function parseBootMessage(line) {
  let diskKey = null
  let approvalKey = null
  const wipe = () => {
    if (diskKey) diskKey.fill(0)
    if (approvalKey) approvalKey.fill(0)
  }
  try {
    diskKey = takeHex(line, 'diskKey')
    approvalKey = takeHex(line, 'approvalKey')
    let msg
    try {
      msg = JSON.parse(line.toString('utf8'))
    } catch {
      wipe()
      return { error: 'message' }
    }
    if (!diskKey || diskKey.length !== 64) return wipe(), { error: 'disk-key' }
    if (!approvalKey || approvalKey.length < 64 || approvalKey.length % 2 !== 0) return wipe(), { error: 'approval-key' }
    if (typeof msg.format !== 'boolean') return wipe(), { error: 'message' }
    if (msg.growTo !== undefined && (!Number.isSafeInteger(msg.growTo) || msg.growTo <= 0)) return wipe(), { error: 'message' }
    if (typeof msg.vaultId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(msg.vaultId)) return wipe(), { error: 'message' }
    return { diskKey, approvalKey, format: msg.format, growTo: msg.growTo, vaultId: msg.vaultId }
  } finally {
    line.fill(0)
  }
}

/**
 * What to do with the data disk. `format` only ever applies to a disk that holds no LUKS
 * header: a formatted vault whose `formatted:true` the helper failed to persist is opened, not
 * wiped (D38). Such a disk may also be one whose first boot stopped between luksFormat and
 * mkfs, so `probe` asks for a filesystem check after the open (see `afterProbe`).
 */
function diskPlan(msg, isLuks) {
  const format = msg.format && !isLuks
  return {
    format,
    mkfs: format,
    probe: msg.format && isLuks,
    grow: !format && msg.growTo !== undefined,
    kept: msg.format && isLuks
  }
}

/**
 * The plan after `blkid -p` on the opened mapping, for a `probe` plan: exit 0 (a filesystem is
 * there) keeps it and is never re-made; exit 2 (nothing identified) makes one and skips the grow
 * (mkfs takes the whole mapping); anything else is a failure, never a format.
 */
function afterProbe(plan, blkidStatus) {
  if (!plan.probe) return plan
  if (blkidStatus === 0) return { ...plan, probe: false }
  if (blkidStatus === 2) return { ...plan, probe: false, mkfs: true, grow: false, kept: false }
  return null
}

/** `vault.smoke.<name>=<digits>` from the kernel cmdline (smoke hooks only; grants nothing). */
function smokeHook(name) {
  let cmdline = ''
  try {
    cmdline = fs.readFileSync('/proc/cmdline', 'utf8')
  } catch {
    return null
  }
  const m = cmdline.split(/\s+/).map((w) => /^vault\.smoke\.([a-z]+)=(\d+)$/.exec(w)).filter((x) => x && x[1] === name).pop()
  return m ? Number(m[2]) : null
}

function main() {
  const line = readLine()
  if (line.length === 0) fail('message')
  const msg = parseBootMessage(line)
  if (msg.error) fail(msg.error)
  const { diskKey } = msg

  fs.mkdirSync('/run/vault', { recursive: true, mode: 0o700 })
  fs.writeFileSync(APPROVAL_KEY, msg.approvalKey, { mode: 0o600 })
  msg.approvalKey.fill(0)
  fs.writeFileSync(VAULT_ID, msg.vaultId + '\n', { mode: 0o600 })

  for (let i = 0; !fs.existsSync(DATA_DEV); i++) {
    if (i > 500) fail('disk')
    spawnSync('sleep', ['0.01'])
  }

  // isLuks: 0 = LUKS header present, 1 = none, anything else = cannot tell (never format then).
  const luks = run('isluks', 'cryptsetup', ['isLuks', DATA_DEV], undefined, [0, 1]) === 0
  let plan = diskPlan(msg, luks)
  if (plan.format) {
    // The key is 32 random bytes, so the KDF only has to be cheap, not strong.
    run('format', 'cryptsetup', ['luksFormat', '--batch-mode', '--type', 'luks2', '--pbkdf', 'argon2id', '--pbkdf-force-iterations', '4', '--pbkdf-memory', '32768', '--pbkdf-parallel', '1', '--key-file', '-', DATA_DEV], diskKey)
    // Smoke hook (scripts/vault/guest-smoke.mjs): stop here, as if the VM died between luksFormat
    // and mkfs; the smoke kills the VM on this line. Grants nothing: the boot only stalls.
    if (smokeHook('stallafterluks') === 1) {
      diskKey.fill(0)
      process.stdout.write('VAULT smoke stalled after luksFormat\n')
      for (;;) spawnSync('sleep', ['3600'])
    }
  }
  run('open', 'cryptsetup', ['open', '--type', 'luks2', '--key-file', '-', DATA_DEV, MAPPER], diskKey)
  if (plan.probe) {
    // 0 = a filesystem, 2 = nothing identified; anything else fails the boot (afterProbe).
    plan = afterProbe(plan, run('probe', 'blkid', ['-p', `/dev/mapper/${MAPPER}`], undefined, [0, 2]))
    if (!plan) fail('probe')
  }
  if (plan.mkfs) {
    run('mkfs', 'mkfs.ext4', ['-q', '-L', 'vault', '-m', '0', `/dev/mapper/${MAPPER}`])
  } else if (plan.grow) {
    // The helper grew data.img before boot; take the LUKS mapping and ext4 out to the device end.
    run('grow', 'cryptsetup', ['resize', '--key-file', '-', MAPPER], diskKey)
    run('grow', 'e2fsck', ['-f', '-p', `/dev/mapper/${MAPPER}`], undefined, [0, 1])
    run('grow', 'resize2fs', [`/dev/mapper/${MAPPER}`])
  }
  diskKey.fill(0)
  run('mount', 'mount', ['-t', 'ext4', '-o', 'noatime,nodev,nosuid', `/dev/mapper/${MAPPER}`, MOUNT])
  if (plan.mkfs) process.stdout.write('VAULT disk formatted\n')
  else if (plan.kept) process.stdout.write('VAULT disk kept\n')
}

if (require.main === module) main()
else module.exports = { parseBootMessage, diskPlan, afterProbe, takeHex }
