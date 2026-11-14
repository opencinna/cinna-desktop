// Boot smoke test for the Agent Vault guest built by make vault-image. Run by hand:
//   node scripts/vault/guest-smoke.mjs
// No network for the guest (no NAT), no engines, nothing billed. Needs build/vault-guest/ with
// the real vaultd (guest.lock.json vaultd.placeholder false) and vzbuild from make vault-image.
//
//  1. fresh sparse 2 GB data disk; boot with format:true; hello, layout.ensure, disk.usage, kv.put marker
//  1b. boot with format:true AGAIN on the formatted disk (D38): opened, not reformatted; marker kept
//  1c. a fresh disk whose first boot stalls after luksFormat (vault.smoke.stallafterluks) and is killed;
//      the next format:true boot finds LUKS but no filesystem (blkid -p) and makes it; a third keeps it
//  2. cold boot with format:false and the same key; hello, kv.get marker survives
//  3. boot with a wrong disk key: must fail before vaultd
//  4. rootfs copy with one byte flipped in data block 0 (erofs superblock): verity must stop the boot
//  5. rootfs copy with one byte flipped mid data area: boots (verity checks blocks lazily, on read),
//     and reading every file on the root must hit an I/O error
// Boots 2 and 5 also run a gated `exec shell` (terminal token minted with the boot approval key)
// for in-guest checks: no NIC, proxy deny/allow, read-only root, disk key nowhere in argv/env/tmpfs,
// and D36: the shell is uid 1000 agent with no capabilities and cannot read the key files, reach
// vaultd's sockets, write the console, read the dm table or the kernel log; no setuid file left.
// Boot 2 also runs the `rebuild` exec with a move-in token carrying proxyCred (D37): the proxy must
// see Proxy-Authorization for cinna:<cred> from uv, the agent shell none, and the helper socket
// subscriber gets exec-end with the cred; with a pyproject and no uv.lock the sync step refuses; the
// `check` preset (the agent's kit.py) runs with no credential and pushes no exec-end.
// 6. boot with vault.smoke.killvaultd: a spent terminal token is still refused after vaultd restarts.
// Boot 2 then does the lock/unlock round trip over vsock 5001: suspend -> pause VM -> resume VM ->
// resume with a wrong key (refused) -> resume with the key -> kv.get on the old and a new 5000 connection.
// Results: build/vault-guest/smoke/results.json; exit 1 on any failed check.
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { GUEST_OUT, log, socketDir, unixServer, startVM, cpuCount } from './vz.mjs'

const SMOKE = path.join(GUEST_OUT, 'smoke')
const lock = JSON.parse(fs.readFileSync(path.join(GUEST_OUT, 'guest.lock.json'), 'utf8'))
if (lock.vaultd?.placeholder) {
  console.error('guest-smoke: the image was built with the placeholder vaultd; run npx electron-vite build, then make vault-image')
  process.exit(1)
}
fs.rmSync(SMOKE, { recursive: true, force: true })
fs.mkdirSync(SMOKE, { recursive: true })
const DATA = path.join(SMOKE, 'data.img')
const VAULT_ID = 'smoke-vault'
const results = { image: { version: lock.version, rootHash: lock.rootHash }, boots: [], checks: {} }
let failures = 0
function check(name, ok, detail) {
  results.checks[name] = { ok, ...(detail === undefined ? {} : { detail }) }
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  if (!ok) failures++
}

// ---------------------------------------------------------------- host services

const proxyLog = []
const ALLOW = new Set(['example.com'])
function proxyServer(sock) {
  return unixServer(sock, (c) => {
    let buf = Buffer.alloc(0)
    const onData = (d) => {
      buf = Buffer.concat([buf, d])
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) return
      c.off('data', onData)
      const [method, target] = buf.subarray(0, end).toString().split(' ')
      if (method !== 'CONNECT') return c.end('HTTP/1.1 405 Only CONNECT\r\n\r\n')
      const [host, port] = target.split(':')
      const ok = ALLOW.has(host)
      const auth = /\r\nproxy-authorization: *([^\r]*)/i.exec(buf.subarray(0, end).toString())?.[1] ?? null
      proxyLog.push({ host, port, verdict: ok ? 'allowed' : 'denied', auth })
      if (!ok) return c.end('HTTP/1.1 403 Not on the vault allowlist\r\n\r\n')
      const rest = buf.subarray(end + 4)
      const up = net.connect(Number(port || 443), host, () => {
        c.write('HTTP/1.1 200 Connection established\r\n\r\n')
        if (rest.length) up.write(rest)
        c.pipe(up)
        up.pipe(c)
      })
      up.on('error', () => c.destroy())
      c.on('error', () => up.destroy())
    }
    c.on('data', onData)
  })
}

/** Serves the boot message once; a second request (a reboot the test did not ask for) gets nothing. */
function bootSecretServer(sock, message) {
  let served = 0
  const server = unixServer(sock, (c) => {
    served++
    if (served > 1) return c.destroy()
    c.end(JSON.stringify(message) + '\n')
  })
  return { server, served: () => served }
}

// ---------------------------------------------------------------- vaultd client

function vaultdConnect(sock, { retryUntilMs }) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const s = net.connect(sock)
      let buf = ''
      let id = 0
      let answered = false
      const pending = new Map()
      const notifications = []
      const call = (method, params = {}) =>
        new Promise((res, rej) => {
          const i = ++id
          pending.set(i, { res, rej })
          s.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n')
        })
      s.on('data', (d) => {
        buf += d
        let k
        while ((k = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, k)
          buf = buf.slice(k + 1)
          if (!line.trim()) continue
          const msg = JSON.parse(line)
          if (msg.id !== undefined && pending.has(msg.id)) {
            answered = true
            const p = pending.get(msg.id)
            pending.delete(msg.id)
            msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result)
          } else if (msg.method) notifications.push(msg)
        }
      })
      s.on('error', () => {})
      s.on('close', () => {
        for (const p of pending.values()) p.rej(new Error('closed'))
        pending.clear()
        if (!answered) retry()
      })
      const retry = () => (Date.now() - started > retryUntilMs ? reject(new Error('vaultd never answered')) : setTimeout(attempt, 25))
      s.on('connect', () => {
        s.write(JSON.stringify({ type: 'control' }) + '\n')
        call('hello')
          .then((hello) => resolve({ hello, call, notifications, close: () => s.end() }))
          .catch(() => {})
      })
    }
    attempt()
  })
}

// ---------------------------------------------------------------- one boot

async function boot(tag, { message, rootfs = path.join(GUEST_OUT, 'rootfs.img'), data = DATA, expect = 'ready', stallLine, timeoutMs = 30_000, cmdline = '', then }) {
  const sockets = socketDir('smoke')
  const secret = bootSecretServer(path.join(sockets, 'boot.sock'), message)
  const proxy = proxyServer(path.join(sockets, 'proxy.sock'))
  const consoleLines = []
  const record = { tag, expect, console: consoleLines }
  results.boots.push(record)
  const t0 = Date.now()
  const vm = startVM(
    {
      kernel: path.join(GUEST_OUT, 'Image'),
      initrd: path.join(GUEST_OUT, 'initrd.img'),
      cmdline: `console=hvc0 quiet loglevel=0 init_on_free=1 init_on_alloc=1 vault.time=${Math.floor(Date.now() / 1000)} vault.roothash=${lock.rootHash} vault.hashoffset=${lock.hashOffset} root=/dev/vda${cmdline ? ' ' + cmdline : ''}`,
      disks: [
        { path: rootfs, readOnly: true },
        { path: data, readOnly: false }
      ],
      memMB: 4096,
      cpus: cpuCount(4),
      nat: false,
      console: path.join(SMOKE, `console-${tag}.log`),
      listen: [
        { port: 1080, unix: path.join(sockets, 'proxy.sock') },
        { port: 1090, unix: path.join(sockets, 'boot.sock') }
      ],
      connect: [
        { port: 5000, unix: path.join(sockets, 'vaultd.sock') },
        { port: 5001, unix: path.join(sockets, 'helper.sock') }
      ]
    },
    {
      configPath: path.join(SMOKE, `vm-${tag}.json`),
      onConsole: (line, ms) => {
        consoleLines.push({ ms, line })
        log(`guest[${tag}] +${ms}ms:`, line)
      }
    }
  )
  const stopped = vm.exited.then(() => 'stopped')
  try {
    if (expect === 'ready') {
      const client = await Promise.race([
        vaultdConnect(path.join(sockets, 'vaultd.sock'), { retryUntilMs: timeoutMs }),
        stopped.then(() => {
          throw new Error('VM stopped before vaultd answered')
        })
      ])
      record.coldBootToHelloMs = Date.now() - t0
      record.hello = client.hello
      log(`[${tag}] vaultd hello after ${record.coldBootToHelloMs} ms`)
      await then(client, record, path.join(sockets, 'vaultd.sock'), { vm, helperSock: path.join(sockets, 'helper.sock'), consoleLines })
      client.close()
    } else if (expect === 'stall') {
      // The guest stalls on a smoke hook; the VM is killed on its console line (finally below).
      const seen = await until(() => consoleLines.some((l) => l.line.includes(stallLine)), timeoutMs)
      record.outcome = seen ? 'stalled' : 'no stall line'
      record.reachedReady = consoleLines.some((l) => l.line.includes('VAULT ready'))
    } else {
      const outcome = await Promise.race([stopped, new Promise((r) => setTimeout(() => r('timeout'), timeoutMs))])
      record.outcome = outcome
      record.reachedReady = consoleLines.some((l) => l.line.includes('VAULT ready'))
      record.failedLine = consoleLines.find((l) => l.line.includes('VAULT FAILED'))?.line ?? null
    }
  } finally {
    await vm.stop()
    record.bootSecretServed = secret.served()
    secret.server.close()
    proxy.close()
    fs.rmSync(sockets, { recursive: true, force: true })
  }
  return record
}

// ---------------------------------------------------------------- gated shell

function terminalToken(approvalKeyHex) {
  return token(approvalKeyHex, 'terminal', 'exec:shell')
}

function token(approvalKeyHex, action, detail, extra = {}) {
  const claims = {
    v: 1,
    vaultId: VAULT_ID,
    action,
    detailSha256: crypto.createHash('sha256').update(detail).digest('hex'),
    nonce: crypto.randomBytes(16).toString('hex'),
    exp: Date.now() + 10 * 60_000,
    ...extra
  }
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const mac = crypto.createHmac('sha256', Buffer.from(approvalKeyHex, 'hex')).update(body, 'ascii').digest('base64url')
  return `${body}.${mac}`
}

/** Runs `script` in the gated vault shell; returns {name: value} for every output line `@@name value`. */
async function guestShell(client, sock, approvalKeyHex, script, timeoutMs = 120_000, tok = terminalToken(approvalKeyHex)) {
  const { stream } = await client.call('exec', { preset: 'shell', token: tok })
  const s = net.connect(sock)
  let out = ''
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => (s.destroy(), reject(new Error(`guest shell timed out; output so far:\n${out.slice(-2000)}`))), timeoutMs)
    s.on('connect', () => {
      s.write(JSON.stringify({ type: 'attach', stream }) + '\n')
      s.write(['stty -echo', 'set +o history', 'PS1=', script, 'exit', ''].join('\n'))
    })
    s.on('data', (d) => (out += d))
    s.on('error', () => {})
    s.on('close', () => (clearTimeout(t), resolve()))
  })
  const vals = {}
  for (const line of out.replace(/\r/g, '').split('\n')) {
    const m = line.match(/^@@(\S+) ?(.*)$/)
    if (m) vals[m[1]] = m[2]
  }
  return vals
}

/** Runs a non-interactive exec preset to its end; returns {code, output}. */
async function runPreset(client, sock, preset, tok, timeoutMs = 120_000) {
  const { stream } = await client.call('exec', { preset, token: tok })
  const s = net.connect(sock)
  let out = ''
  await new Promise((resolve) => {
    const t = setTimeout(() => (s.destroy(), resolve()), timeoutMs)
    s.on('connect', () => s.write(JSON.stringify({ type: 'attach', stream }) + '\n'))
    s.on('data', (d) => (out += d))
    s.on('error', () => {})
    s.on('close', () => (clearTimeout(t), resolve()))
  })
  const started = Date.now()
  let exit
  while (!(exit = client.notifications.find((n) => n.method === 'exec.exit' && n.params?.stream === stream)) && Date.now() - started < 10_000) {
    await new Promise((r) => setTimeout(r, 50))
  }
  return { code: exit?.params?.code ?? null, output: out }
}

const until = async (fn, ms = 10_000) => {
  const t = Date.now()
  while (!fn() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 50))
  return fn()
}

// ---------------------------------------------------------------- helper control (vsock 5001)

function helperConnect(sock) {
  return new Promise((resolve, reject) => {
    const s = net.connect(sock)
    let buf = ''
    const waiting = []
    const events = []
    s.on('data', (d) => {
      buf += d
      let k
      while ((k = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, k)
        buf = buf.slice(k + 1)
        const msg = JSON.parse(line)
        if (msg.event) events.push(msg)
        else waiting.shift()?.(msg)
      }
    })
    s.on('error', reject)
    s.on('connect', () =>
      resolve({
        op: (msg) => new Promise((res) => (waiting.push(res), s.write(JSON.stringify(msg) + '\n'))),
        events,
        close: () => s.end()
      })
    )
  })
}

const timed = async (fn) => {
  const t = Date.now()
  const r = await fn()
  return [r, Date.now() - t]
}

function flipByte(src, dst, offset) {
  execFileSync('cp', ['-c', src, dst]) // APFS clone: instant, independent copy-on-write
  const fd = fs.openSync(dst, 'r+')
  const b = Buffer.alloc(1)
  fs.readSync(fd, b, 0, 1, offset)
  b[0] ^= 0xff
  fs.writeSync(fd, b, 0, 1, offset)
  fs.closeSync(fd)
}

// ---------------------------------------------------------------- run

async function main() {
  const fd = fs.openSync(DATA, 'w')
  fs.ftruncateSync(fd, 2 * 1024 ** 3)
  fs.closeSync(fd)
  const diskKey = crypto.randomBytes(32).toString('hex')
  const approvalKey = crypto.randomBytes(32).toString('hex')
  const marker = `smoke-${crypto.randomBytes(8).toString('hex')}`

  await boot('format', {
    message: { diskKey, approvalKey, format: true, vaultId: VAULT_ID },
    then: async (c, rec) => {
      check('hello.image matches guest.lock.json', c.hello?.image?.version === lock.version && c.hello?.image?.node === lock.node && c.hello?.image?.uv === lock.uv, c.hello?.image)
      check('hello.fake is false', c.hello?.fake === false, c.hello?.fake)
      await c.call('layout.ensure')
      const after = await c.call('hello')
      check('layout.ensure -> layoutReady', after.layoutReady === true)
      const usage = await c.call('disk.usage')
      rec.diskUsage = usage
      check('disk.usage sees the ~2 GB data disk', usage.sizeBytes > 1.5 * 1024 ** 3 && usage.sizeBytes <= 2 * 1024 ** 3, usage)
      await c.call('kv.put', { key: 'smoke.marker', value: marker })
    }
  })
  check('format boot reached vaultd', results.boots[0].hello !== undefined)

  // D38: format:true on a disk that already holds LUKS opens it instead of wiping it.
  await boot('format-again', {
    message: { diskKey, approvalKey, format: true, vaultId: VAULT_ID },
    then: async (c, rec, sock, { consoleLines }) => {
      const got = await c.call('kv.get', { key: 'smoke.marker' })
      check('format:true on a formatted disk keeps the data (isLuks guard)', got?.value === marker, got)
      check('console says VAULT disk kept, not formatted', consoleLines.some((l) => l.line.includes('VAULT disk kept')) && !consoleLines.some((l) => l.line.includes('VAULT disk formatted')), consoleLines.map((l) => l.line))
    }
  })

  await boot('reopen', {
    message: { diskKey, approvalKey, format: false, vaultId: VAULT_ID },
    then: async (c, rec, sock, { vm, helperSock }) => {
      const got = await c.call('kv.get', { key: 'smoke.marker' })
      check('marker survives a cold reboot with the same key', got?.value === marker, got)
      check('layout still ready after reboot', c.hello?.layoutReady === true)
      const v = await guestShell(c, sock, approvalKey, [
        `KEY=$(cat <<'EOF'\n${diskKey}\nEOF\n)`,
        'echo "@@links $(ls /sys/class/net | tr "\\n" " ")"',
        'echo "@@direct $(curl -sS -m 3 --noproxy "*" http://1.1.1.1 2>&1 | head -n 1)"',
        'echo "@@deny $(curl -sS -m 10 -o /dev/null -w "%{http_code}" https://denied.example.net 2>&1 | tail -c 100)"',
        'echo "@@allow $(curl -sS -m 15 -o /dev/null -w "%{http_code}" https://example.com 2>&1 | tail -c 100)"',
        'echo "@@rootro $(touch /usr/smoke 2>&1 | grep -c "Read-only")"',
        'echo "@@root $(findmnt -n -o SOURCE,FSTYPE /)"',
        'echo "@@vault $(findmnt -n -o SOURCE,FSTYPE /vault)"',
        // D36: who the terminal is, and what it cannot reach.
        'echo "@@ids $(id -u):$(id -g):$(id -G | tr " " ,)"',
        'echo "@@caps $(grep -E "^Cap(Inh|Prm|Eff|Amb)" /proc/self/status | awk "{print \\$2}" | tr "\\n" " ")"',
        'echo "@@nnp $(grep -E "^NoNewPrivs" /proc/self/status | awk "{print \\$2}")"',
        'echo "@@capbnd $(grep -E "^CapBnd" /proc/self/status | awk "{print \\$2}")"',
        // For files.export as agent: a readable file, one the agent made unreadable to itself, a link out.
        'echo hi >/vault/agent/smoke-export.txt; echo no >/vault/agent/smoke-unread.txt; chmod 000 /vault/agent/smoke-unread.txt; ln -sfn /vault/secrets /vault/agent/smoke-link',
        // For D37: a pyproject with no uv.lock (rebuild must refuse to sync), and a kit validator that reports
        // whether the check preset (agent code, run as build) got a proxy credential.
        `printf '[project]\\nname = "smoke"\\nversion = "0"\\n' >/vault/agent/pyproject.toml`,
        'mkdir -p /vault/agent/.cinna-kit/tools',
        `printf 'import os\\nprint("@@checkcred", sum("cinna:" in v for v in os.environ.values()))\\n' >/vault/agent/.cinna-kit/tools/kit.py`,
        'echo "@@approvalkey $(cat /run/vault/approval.key >/dev/null 2>&1 && echo readable || echo denied)"',
        'echo "@@vaultid $(cat /run/vault/vault-id >/dev/null 2>&1 && echo readable || echo denied)"',
        'echo "@@spent $(cat /run/vault/spent-nonces >/dev/null 2>&1 && echo readable || echo denied)"',
        'echo "@@dmtable $(dmsetup table --showkeys >/dev/null 2>&1 && echo readable || echo denied) $(command -v dmsetup || echo no-dmsetup)"',
        'echo "@@dmcontrol $(: </dev/mapper/control 2>/dev/null && echo open || echo denied)"',
        'echo "@@plaindev $(head -c 1 /dev/mapper/vault >/dev/null 2>&1 && echo readable || echo denied)"',
        'echo "@@sock $(socat -u /dev/null UNIX-CONNECT:/run/vaultd.sock 2>/dev/null && echo connected || echo denied)"',
        'echo "@@helpersock $(socat -u /dev/null UNIX-CONNECT:/run/vaultd-helper.sock 2>/dev/null && echo connected || echo denied)"',
        'echo "@@console $( (echo x >/dev/console) 2>/dev/null && echo writable || echo denied) $( (echo x >/dev/hvc0) 2>/dev/null && echo writable || echo denied)"',
        'echo "@@dmesg $(dmesg >/dev/null 2>&1 && echo readable || echo denied)"',
        'echo "@@secrets $(ls /vault/secrets >/dev/null 2>&1 && echo readable || echo denied)"',
        'echo "@@setuid $(find / -xdev -type f -perm /6000 2>/dev/null | wc -l)"',
        'echo "@@agentdir $(stat -c "%a %U %G" /vault/agent) $(touch /vault/agent/.smoke && stat -c "%a %U %G" /vault/agent/.smoke; rm -f /vault/agent/.smoke)"',
        'echo "@@home $(stat -c "%a %U" /vault/home)"',
        'echo "@@uvcache $(stat -c "%a %U %G" /vault/cache/uv) $(touch /vault/cache/uv/x 2>/dev/null && echo writable || echo denied)"',
        'echo "@@cred $(env | grep -c "cinna:")"',
        'echo "@@vaultdps $(ps -o user= -C node | sort | uniq -c | tr -s " " | tr "\\n" ";")"',
        'echo "@@keyhits $(grep -rlsF -f <(printf %s "$KEY") /run /tmp /etc /proc/[0-9]*/cmdline /proc/[0-9]*/environ 2>/dev/null | wc -l)"',
        // Positive control for the search above: a planted copy is found.
        'printf %s "$KEY" >/tmp/smoke-control',
        'echo "@@controlhits $(grep -rlsF -f <(printf %s "$KEY") /tmp 2>/dev/null | wc -l)"',
        'rm -f /tmp/smoke-control',
        'echo "@@image $(cat /etc/cinna/image.json)"',
        'echo "@@resolv $(cat /etc/resolv.conf)"',
        'echo "@@proxyenv $(. /etc/profile.d/cinna-proxy.sh; echo $HTTPS_PROXY)"'
      ].join('\n'))
      rec.shell = v
      check('guest has no NIC but lo', v.links?.trim() === 'lo', v.links)
      check('direct egress fails', /unreachable|Could not connect|Failed to connect/i.test(v.direct ?? ''), v.direct)
      check('proxy denies a host off the allowlist', /403/.test(v.deny ?? ''), v.deny)
      check('proxy lets an allowlisted host through', /^(200|301|302)$/.test(v.allow ?? ''), v.allow)
      check('root is read-only dm-verity erofs', v.rootro === '1' && /\/dev\/mapper\/root erofs/.test(v.root ?? ''), `${v.rootro} ${v.root}`)
      check('/vault is the LUKS mapping', /\/dev\/mapper\/vault ext4/.test(v.vault ?? ''), v.vault)
      check('terminal runs as agent 1000:1000, no other groups', v.ids === '1000:1000:1000', v.ids)
      check('terminal has no capabilities (inh/prm/eff/amb all zero)', /^(0{16} ){4}$/.test(v.caps ?? ''), v.caps)
      check('terminal has an empty bounding set and NoNewPrivs', v.capbnd === '0000000000000000' && v.nnp === '1', `CapBnd=${v.capbnd} NoNewPrivs=${v.nnp}`)

      // files.export runs tar as agent: what the agent cannot read cannot leave; links go out as links.
      const exportPath = async (p) => {
        const { stream } = await c.call('files.export', { path: p, token: token(approvalKey, 'export', `export:${p}`) })
        const s2 = net.connect(sock)
        const chunks = []
        await new Promise((resolve) => {
          s2.on('connect', () => s2.write(JSON.stringify({ type: 'attach', stream }) + '\n'))
          s2.on('data', (d) => chunks.push(d))
          s2.on('error', () => {})
          s2.on('close', resolve)
        })
        await until(() => c.notifications.some((n) => n.params?.stream === stream), 2000)
        return { bytes: Buffer.concat(chunks), error: c.notifications.some((n) => n.method === 'stream.error' && n.params?.stream === stream) }
      }
      const okExport = await exportPath('smoke-export.txt')
      check('export of a file the agent can read works', !okExport.error && okExport.bytes.includes(Buffer.from('hi\n')), { error: okExport.error, bytes: okExport.bytes.length })
      const unread = await exportPath('smoke-unread.txt')
      check('export of a file unreadable to agent fails (tar is not root)', unread.error && !unread.bytes.includes(Buffer.from('no\n')), { error: unread.error, bytes: unread.bytes.length })
      let linkRefused
      try {
        await exportPath('smoke-link')
        linkRefused = 'accepted'
      } catch (e) {
        linkRefused = String(e.message)
      }
      check('export of a link to /vault/secrets is refused (resolves outside the agent folder)', /Invalid path/.test(linkRefused), linkRefused)
      check('approval key, vault id, spent nonces unreadable to agent', v.approvalkey === 'denied' && v.vaultid === 'denied' && v.spent === 'denied', `${v.approvalkey} ${v.vaultid} ${v.spent}`)
      check('dm table (with keys) unreadable to agent', /^denied/.test(v.dmtable ?? '') && v.dmcontrol === 'denied', `${v.dmtable} control=${v.dmcontrol}`)
      check('plaintext /dev/mapper/vault unreadable to agent', v.plaindev === 'denied', v.plaindev)
      check('vaultd sockets refuse agent', v.sock === 'denied' && v.helpersock === 'denied', `${v.sock} ${v.helpersock}`)
      check('console not writable by agent', v.console === 'denied denied', v.console)
      check('kernel log unreadable to agent', v.dmesg === 'denied', v.dmesg)
      check('/vault/secrets unreadable to agent', v.secrets === 'denied', v.secrets)
      check('no setuid/setgid file on the rootfs', v.setuid === '0', v.setuid)
      check('/vault/agent is setgid vault and agent files are group-writable', /^2775 agent vault 664 agent vault$/.test(v.agentdir ?? ''), v.agentdir)
      check('/vault/home is agent-only', v.home === '700 agent', v.home)
      check('uv cache belongs to build, read-only to agent', /^2755 build build denied$/.test(v.uvcache ?? ''), v.uvcache)
      check('agent shell carries no proxy credential', v.cred === '0', v.cred)
      check('key search finds a planted copy (control)', Number(v.controlhits) >= 1, v.controlhits)
      check('disk key in no argv, env, /run, /tmp or /etc visible to agent', v.keyhits === '0', v.keyhits)
      check('resolv.conf points at 127.0.0.1', v.resolv === 'nameserver 127.0.0.1', v.resolv)
      check('proxy env default', v.proxyenv === 'http://127.0.0.1:3128', v.proxyenv)
      rec.vaultdps = v.vaultdps

      // D37: an install exec carries the token's proxy credential; the helper subscriber hears exec-end.
      const sub = await helperConnect(helperSock)
      const subOk = await sub.op({ op: 'subscribe' })
      check('helper subscribe -> ok', subOk.ok === true, subOk)
      const cred = crypto.randomBytes(16).toString('hex')
      const before = proxyLog.length
      const r1 = await runPreset(c, sock, 'rebuild', token(approvalKey, 'move-in', 'smoke move-in', { proxyCred: cred }))
      rec.installExec = { code: r1.code, output: r1.output.slice(-600) }
      const seen = proxyLog.slice(before)
      const want = 'Basic ' + Buffer.from(`cinna:${cred}`).toString('base64')
      check('uv sends Proxy-Authorization cinna:<cred> on CONNECT', seen.length > 0 && seen.every((e) => e.auth === want), seen)
      check('agent shell CONNECTs carried no Proxy-Authorization', proxyLog.slice(0, before).every((e) => e.auth === null), proxyLog.slice(0, before))
      const ended = await until(() => sub.events.some((e) => e.event === 'exec-end' && e.proxyCred === cred))
      check('exec-end with the cred pushed to the subscriber', ended, sub.events)
      check('rebuild exec ran as build and ended once (one exec-end for the cred)', r1.code !== null && sub.events.filter((e) => e.proxyCred === cred).length === 1, { code: r1.code, events: sub.events })
      // The smoke proxy has no install hosts, so rebuild stops at `uv python install`; the sync step
      // (the same script in uv-sync, which never carries a credential) is checked on its own.
      const rs = await runPreset(c, sock, 'uv-sync', token(approvalKey, 'move-in', 'smoke move-in', { proxyCred: cred }))
      rec.syncExec = { code: rs.code, output: rs.output.slice(-600) }
      check('sync refuses a pyproject without uv.lock (no uv lock, no download)', rs.code === 1 && /no uv\.lock/.test(rs.output), rec.syncExec)
      // check runs the agent's kit.py: same move-in token, but no credential and no exec-end. With no
      // Python in the vault, uv tries to fetch one: those CONNECTs must carry no Proxy-Authorization.
      const beforeCheck = proxyLog.length
      const r2 = await runPreset(c, sock, 'check', token(approvalKey, 'move-in', 'smoke move-in', { proxyCred: cred }))
      const checkConnects = proxyLog.slice(beforeCheck)
      rec.checkExec = { code: r2.code, output: r2.output.slice(-600), connects: checkConnects.length }
      check('check preset (agent code) gets no proxy credential', checkConnects.length > 0 && checkConnects.every((e) => e.auth === null) && !/@@checkcred [1-9]/.test(r2.output), rec.checkExec)
      await new Promise((res) => setTimeout(res, 500))
      check('check preset pushes no exec-end', sub.events.filter((e) => e.event === 'exec-end').length === 1, sub.events)
      sub.close()

      // Lock / unlock round trip (D22): the helper's side of it, driven by hand.
      const h = await helperConnect(helperSock)
      const t = {}
      let r
      ;[r, t.ping] = await timed(() => h.op({ op: 'ping' }))
      check('helper ping on 5001', r.ok === true, r)
      ;[r, t.luksSuspend] = await timed(() => h.op({ op: 'suspend' }))
      check('suspend -> ok', r.ok === true, r)
      vm.send('pause')
      t.pause = (await vm.waitEv('paused')).took
      await new Promise((res) => setTimeout(res, 1000))
      vm.send('resume')
      t.resume = (await vm.waitEv('resumed')).took
      ;[r, t.wrongKeyResume] = await timed(() => h.op({ op: 'resume', key: crypto.randomBytes(32).toString('hex') }))
      check('resume with a wrong key is refused', r.ok === false, r)
      ;[r, t.luksResume] = await timed(() => h.op({ op: 'resume', key: diskKey }))
      check('resume with the key -> ok', r.ok === true, r)
      let after
      ;[after, t.kvGetAfterResume] = await timed(() => c.call('kv.get', { key: 'smoke.marker' }))
      check('kv.get on the pre-lock 5000 connection reads the marker after resume', after?.value === marker, after)
      // kv.get may be served from memory; a write has to reach the unsuspended disk (it hangs while suspended).
      const wrote = await Promise.race([
        timed(() => c.call('kv.put', { key: 'smoke.afterResume', value: marker })),
        new Promise((res) => setTimeout(() => res(null), 10_000))
      ])
      if (wrote) t.kvPutAfterResume = wrote[1]
      check('kv.put after resume reaches the disk', wrote !== null, wrote ? `${wrote[1]} ms` : 'hung 10 s')
      const fresh = await vaultdConnect(sock, { retryUntilMs: 5000 })
      after = await fresh.call('kv.get', { key: 'smoke.marker' })
      check('kv.get on a new 5000 connection after resume', after?.value === marker, after)
      fresh.close()
      h.close()
      rec.lockRoundTripMs = t
      log('lock round trip (ms):', JSON.stringify(t))
    }
  })

  // A first boot killed between luksFormat and mkfs: the helper never recorded formatted:true, so the
  // next boot sends format:true again; the disk holds LUKS (kept, D38) but no filesystem, and
  // blkid -p decides that mkfs runs. An existing ext4 is never re-made (format-again above).
  const DATA2 = path.join(SMOKE, 'data-stall.img')
  const fd2 = fs.openSync(DATA2, 'w')
  fs.ftruncateSync(fd2, 2 * 1024 ** 3)
  fs.closeSync(fd2)
  const stallKey = crypto.randomBytes(32).toString('hex')
  const stall = await boot('stall-after-luks', {
    message: { diskKey: stallKey, approvalKey, format: true, vaultId: VAULT_ID },
    data: DATA2,
    cmdline: 'vault.smoke.stallafterluks=1',
    expect: 'stall',
    stallLine: 'VAULT smoke stalled after luksFormat'
  })
  check('first boot stalls right after luksFormat and the VM is killed there', stall.outcome === 'stalled' && !stall.reachedReady, stall.outcome)
  await boot('after-stall', {
    message: { diskKey: stallKey, approvalKey, format: true, vaultId: VAULT_ID },
    data: DATA2,
    then: async (c, rec, sock, { consoleLines }) => {
      check('boot after a cut-off first boot makes the filesystem and opens', consoleLines.some((l) => l.line.includes('VAULT disk formatted')), consoleLines.map((l) => l.line))
      await c.call('layout.ensure')
      await c.call('kv.put', { key: 'smoke.stall', value: marker })
      const got = await c.call('kv.get', { key: 'smoke.stall' })
      check('the vault works after the cut-off first boot', got?.value === marker, got)
    }
  })
  await boot('after-stall-reopen', {
    message: { diskKey: stallKey, approvalKey, format: true, vaultId: VAULT_ID },
    data: DATA2,
    then: async (c, rec, sock, { consoleLines }) => {
      const got = await c.call('kv.get', { key: 'smoke.stall' })
      check('the filesystem made after the cut-off boot is kept, not re-made', got?.value === marker && consoleLines.some((l) => l.line.includes('VAULT disk kept')), { got, console: consoleLines.map((l) => l.line) })
    }
  })
  fs.rmSync(DATA2, { force: true })

  const wrong = await boot('wrong-key', { message: { diskKey: crypto.randomBytes(32).toString('hex'), approvalKey, format: false, vaultId: VAULT_ID }, expect: 'fail' })
  check('wrong disk key stops the boot before vaultd', !wrong.reachedReady && /VAULT FAILED boot/.test(wrong.failedLine ?? ''), wrong.failedLine ?? wrong.outcome)

  // L3: a spent single-use nonce stays spent across a vaultd restart (vault-init restarts it).
  await boot('vaultd-restart', {
    message: { diskKey, approvalKey, format: false, vaultId: VAULT_ID },
    cmdline: 'vault.smoke.killvaultd=12',
    then: async (c, rec, sock, { consoleLines }) => {
      const tok = terminalToken(approvalKey)
      const v = await guestShell(c, sock, approvalKey, 'echo "@@me $(id -un)"', 60_000, tok)
      check('terminal token used once before the restart', v.me === 'agent', v)
      const restarted = await until(() => consoleLines.some((l) => l.line.includes('VAULT vaultd restarted')), 30_000)
      check('vaultd was killed and restarted by vault-init', restarted)
      const fresh = await vaultdConnect(sock, { retryUntilMs: 15_000 })
      let replay
      try {
        await fresh.call('exec', { preset: 'shell', token: tok })
        replay = 'accepted'
      } catch (e) {
        replay = String(e.message)
      }
      check('replayed terminal token refused after the restart', /already used/.test(replay), replay)
      const ok = await guestShell(fresh, sock, approvalKey, 'echo "@@me $(id -un)"', 60_000)
      check('a fresh terminal token still works after the restart', ok.me === 'agent', ok)
      fresh.close()
    }
  })

  const tampered0 = path.join(SMOKE, 'rootfs-tampered-block0.img')
  flipByte(path.join(GUEST_OUT, 'rootfs.img'), tampered0, 1024 + 8)
  const t0 = await boot('tamper-block0', { message: { diskKey, approvalKey, format: false, vaultId: VAULT_ID }, rootfs: tampered0, expect: 'fail' })
  check('flipped byte in data block 0: verity stops the boot', !t0.reachedReady && t0.bootSecretServed === 0, t0.failedLine ?? t0.outcome)

  const mid = Math.floor(lock.hashOffset / 2 / 4096) * 4096 + 123
  const tamperedMid = path.join(SMOKE, 'rootfs-tampered-mid.img')
  flipByte(path.join(GUEST_OUT, 'rootfs.img'), tamperedMid, mid)
  await boot('tamper-mid', {
    message: { diskKey, approvalKey, format: false, vaultId: VAULT_ID },
    rootfs: tamperedMid,
    then: async (c, rec, sock) => {
      const v = await guestShell(c, sock, approvalKey, [
        'find / -xdev -type f -exec cat {} + >/dev/null 2>/tmp/read.err',
        'echo "@@eio $(grep -c "Input/output error" /tmp/read.err)"',
        'echo "@@first $(grep -m 1 "Input/output error" /tmp/read.err)"',
        'echo "@@dmesg $(dmesg | grep -i -m 1 "verity")"'
      ].join('\n'), 300_000)
      rec.shell = v
      check('flipped byte mid data area: reading the root hits a verity I/O error', Number(v.eio) > 0, { offset: mid, ...v })
    }
  })
  for (const f of [tampered0, tamperedMid]) fs.rmSync(f, { force: true })

  results.proxy = proxyLog
  results.coldBootToHelloMs = results.boots.filter((b) => b.coldBootToHelloMs).map((b) => b.coldBootToHelloMs)
  fs.writeFileSync(path.join(SMOKE, 'results.json'), JSON.stringify(results, null, 2))
  log(`cold boot -> vaultd hello: ${results.coldBootToHelloMs.join(', ')} ms; results in build/vault-guest/smoke/results.json`)
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  fs.writeFileSync(path.join(SMOKE, 'results.json'), JSON.stringify({ ...results, error: String(e) }, null, 2))
  process.exit(1)
})
