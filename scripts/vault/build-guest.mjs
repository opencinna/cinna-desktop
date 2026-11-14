// make vault-image (through scripts/vault/build-guest.sh, which compiles vzbuild first).
// Downloads and sha256-checks every pinned input on every run, stages a build initramfs
// (Alpine minirootfs + linux-virt modules + native/vault/guest/build/init-build + /inputs),
// boots it with NAT, receives rootfs.img / initrd.img / build.json over vsock 1095, and writes
// build/vault-guest/{Image,initrd.img,rootfs.img,guest.lock.json}.
//   RELEASE=1          fail without the real out/main/vaultd.js
//   VERSION=<x.y.z-n>  image version (default 1.0.0-<yyyymmdd>)
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { REPO, GUEST_OUT, log, socketDir, unixServer, sha256File, startVM, cpuCount } from './vz.mjs'

const GUEST_SRC = path.join(REPO, 'native/vault/guest')
const LOCK_PATH = path.join(GUEST_SRC, 'build/inputs.lock')
const CACHE = path.join(GUEST_OUT, 'cache')
const WORK = path.join(GUEST_OUT, 'work')
const VAULTD = path.join(REPO, 'out/main/vaultd.js')
const RELEASE = process.env.RELEASE === '1'
const BUILD_TIMEOUT_MS = 40 * 60_000
const SCRATCH_BYTES = 8 * 1024 ** 3

const today = new Date()
const ymd = today.toISOString().slice(0, 10).replaceAll('-', '')
const VERSION = process.env.VERSION || `1.0.0-${ymd}`
// File times inside the images: SOURCE_DATE_EPOCH, else midnight UTC of the build day.
const EPOCH = Number(process.env.SOURCE_DATE_EPOCH) || Math.floor(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) / 1000)

function fail(msg) {
  console.error(`vault-image: ${msg}`)
  process.exit(1)
}

function sh(script, args = [], opts = {}) {
  return execFileSync('/bin/sh', ['-c', script, 'sh', ...args], { stdio: ['ignore', 'pipe', 'inherit'], ...opts })
}

/** Cached download, verified against the pin every time; a mismatch deletes the file and fails. */
async function input(name, pin) {
  const file = path.join(CACHE, path.basename(new URL(pin.url).pathname))
  if (!fs.existsSync(file)) {
    log(`download ${name}: ${pin.url}`)
    const part = `${file}.part`
    execFileSync('curl', ['-fL', '--retry', '3', '-sS', '-o', part, pin.url], { stdio: 'inherit' })
    fs.renameSync(part, file)
  }
  const got = await sha256File(file)
  if (got !== pin.sha256) {
    fs.rmSync(file, { force: true })
    fail(`${name}: sha256 ${got} does not match the pin ${pin.sha256} (${pin.url}); the cached copy was deleted`)
  }
  return file
}

/** Alpine's vmlinuz-virt is an EFI zboot image; VZLinuxBootLoader needs the raw arm64 Image inside it. */
function unpackZboot(vmlinuz) {
  const b = fs.readFileSync(vmlinuz)
  if (b.toString('latin1', 0, 2) !== 'MZ' || b.toString('latin1', 4, 8) !== 'zimg') fail('vmlinuz-virt is not an EFI zboot image')
  const comp = b.toString('latin1', 24, 32).replace(/\0.*$/, '')
  if (comp !== 'gzip') fail(`vmlinuz-virt payload is ${comp}, expected gzip`)
  const off = b.readUInt32LE(8)
  const size = b.readUInt32LE(12)
  const image = zlib.gunzipSync(b.subarray(off, off + size))
  // arm64 Image header: magic "ARM\x64" at 0x38.
  if (image.toString('latin1', 0x38, 0x3c) !== 'ARM\x64') fail('unpacked kernel has no arm64 Image magic')
  return image
}

async function main() {
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'))
  const pins = lock.files
  fs.mkdirSync(CACHE, { recursive: true })
  fs.rmSync(WORK, { recursive: true, force: true })
  fs.mkdirSync(WORK, { recursive: true })

  const files = {}
  for (const [name, pin] of Object.entries(pins)) files[name] = await input(name, pin)
  log('inputs verified:', Object.keys(files).join(', '))

  // Kernel + modules from the linux-virt package.
  const KVER = pins['linux-virt'].kernelRelease
  const kdir = path.join(WORK, 'kernel')
  fs.mkdirSync(kdir)
  sh('bsdtar -xf "$1" -C "$2" boot/vmlinuz-virt lib/modules 2>/dev/null', [files['linux-virt'], kdir])
  if (!fs.existsSync(path.join(kdir, 'lib/modules', KVER, 'modules.dep'))) fail(`linux-virt has no modules for ${KVER}`)
  const image = unpackZboot(path.join(kdir, 'boot/vmlinuz-virt'))
  fs.writeFileSync(path.join(WORK, 'Image'), image)

  // vaultd: the real bundle, or a placeholder that refuses to run (dev only).
  let vaultdSource = VAULTD
  let vaultdPlaceholder = false
  if (!fs.existsSync(VAULTD)) {
    if (RELEASE) fail(`RELEASE=1 needs ${path.relative(REPO, VAULTD)}: run npx electron-vite build first`)
    vaultdPlaceholder = true
    vaultdSource = path.join(WORK, 'vaultd-placeholder.js')
    fs.writeFileSync(vaultdSource, "console.error('vaultd missing'); process.exit(1)\n")
    console.warn(`vault-image: WARNING ${path.relative(REPO, VAULTD)} not found; the image gets a placeholder vaultd that exits at once`)
  }

  // Build initramfs: Alpine minirootfs + modules + init-build + /inputs.
  const stage = path.join(WORK, 'stage')
  const inputs = path.join(stage, 'inputs')
  fs.mkdirSync(inputs, { recursive: true })
  fs.mkdirSync(path.join(stage, 'lib/modules'), { recursive: true })
  fs.cpSync(path.join(kdir, 'lib/modules', KVER), path.join(stage, 'lib/modules', KVER), { recursive: true })
  fs.copyFileSync(path.join(GUEST_SRC, 'build/init-build'), path.join(stage, 'init'))
  fs.chmodSync(path.join(stage, 'init'), 0o755)
  fs.copyFileSync(files.node, path.join(inputs, 'node.tar.xz'))
  fs.copyFileSync(files.uv, path.join(inputs, 'uv.tar.gz'))
  sh('bsdtar -xOf "$1" data.tar.xz | bsdtar -xOf - ./usr/share/keyrings/debian-archive-keyring.pgp > "$2"', [
    files['debian-archive-keyring'],
    path.join(inputs, 'debian-archive-keyring.gpg')
  ])
  if (fs.statSync(path.join(inputs, 'debian-archive-keyring.gpg')).size < 1000) fail('could not extract the Debian archive keyring')
  fs.copyFileSync(vaultdSource, path.join(inputs, 'vaultd.js'))
  fs.copyFileSync(path.join(GUEST_SRC, 'rootfs/usr/lib/cinna/boot.js'), path.join(inputs, 'boot.js'))
  fs.copyFileSync(path.join(GUEST_SRC, 'rootfs/sbin/vault-init'), path.join(inputs, 'vault-init'))
  fs.copyFileSync(path.join(GUEST_SRC, 'initrd/init'), path.join(inputs, 'initrd-init'))
  const imageJson = { version: VERSION, node: pins.node.version, uv: pins.uv.version }
  fs.writeFileSync(path.join(inputs, 'image.json'), JSON.stringify(imageJson) + '\n')
  const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`
  fs.writeFileSync(
    path.join(inputs, 'build.env'),
    [
      `KVER=${q(KVER)}`,
      `IMAGE_VERSION=${q(VERSION)}`,
      `DEBIAN_SUITE=${q(lock.debian.suite)}`,
      `DEBIAN_MIRROR=${q(lock.debian.mirror)}`,
      `DEBIAN_INCLUDE=${q(lock.debian.include.join(','))}`,
      `NODE_VERSION=${q(pins.node.version)}`,
      `UV_VERSION=${q(pins.uv.version)}`
    ].join('\n') + '\n'
  )
  const buildInitrd = path.join(WORK, 'build.cpio.gz')
  sh('cd "$1" && bsdtar --uid 0 --gid 0 --format newc -cf - @"$2" . | gzip -1 > "$3"', [stage, files['alpine-minirootfs'], buildInitrd])
  log(`build initramfs ${(fs.statSync(buildInitrd).size / 1e6).toFixed(1)} MB`)

  // Scratch disk for debootstrap and the images.
  const scratch = path.join(WORK, 'scratch.img')
  const fd = fs.openSync(scratch, 'w')
  fs.ftruncateSync(fd, SCRATCH_BYTES)
  fs.closeSync(fd)

  const sockets = socketDir('build')
  const artifactsTar = path.join(WORK, 'artifacts.tar')
  let received = false
  const recv = unixServer(path.join(sockets, 'recv.sock'), (c) => {
    const w = fs.createWriteStream(artifactsTar)
    c.pipe(w)
    w.on('finish', () => {
      received = true
      log(`artifacts received: ${(fs.statSync(artifactsTar).size / 1e6).toFixed(1)} MB`)
    })
  })

  const consoleLog = path.join(GUEST_OUT, 'build-console.log')
  let failed = null
  const vm = startVM(
    {
      kernel: path.join(WORK, 'Image'),
      initrd: buildInitrd,
      cmdline: `console=hvc0 loglevel=4 vault.time=${Math.floor(Date.now() / 1000)} vault.epoch=${EPOCH}`,
      disks: [{ path: scratch, readOnly: false }],
      memMB: 4096,
      cpus: cpuCount(4),
      nat: true,
      console: consoleLog,
      listen: [{ port: 1095, unix: path.join(sockets, 'recv.sock') }],
      connect: []
    },
    {
      configPath: path.join(WORK, 'vm.json'),
      onConsole: (line) => {
        log('guest:', line)
        if (line.includes('VAULT build FAILED')) failed = line
      }
    }
  )
  const timeout = setTimeout(() => {
    failed = `build VM still running after ${BUILD_TIMEOUT_MS / 60_000} min`
    vm.stop()
  }, BUILD_TIMEOUT_MS)
  await vm.exited
  clearTimeout(timeout)
  await new Promise((r) => setTimeout(r, 300))
  recv.close()
  fs.rmSync(sockets, { recursive: true, force: true })
  fs.rmSync(scratch, { force: true })
  if (failed) fail(`${failed} (console: ${path.relative(REPO, consoleLog)})`)
  if (!received) fail(`the build VM sent no artifacts (console: ${path.relative(REPO, consoleLog)})`)

  // Unpack exactly the expected members.
  const expected = ['build.json', 'packages.txt', 'rootfs.img', 'initrd.img']
  const members = sh('bsdtar -tf "$1"', [artifactsTar]).toString().split('\n').filter(Boolean)
  if (members.sort().join(',') !== [...expected].sort().join(',')) fail(`unexpected artifact members: ${members.join(', ')}`)
  const art = path.join(WORK, 'artifacts')
  fs.mkdirSync(art)
  sh('bsdtar -xf "$1" -C "$2" --no-same-owner --no-same-permissions', [artifactsTar, art])
  fs.rmSync(artifactsTar, { force: true })
  const build = JSON.parse(fs.readFileSync(path.join(art, 'build.json'), 'utf8'))
  if (!/^[0-9a-f]{64}$/.test(build.rootHash) || !Number.isSafeInteger(build.hashOffset)) fail('build.json has no root hash / hash offset')

  for (const f of ['Image', 'initrd.img', 'rootfs.img', 'guest.lock.json', 'packages.txt']) fs.rmSync(path.join(GUEST_OUT, f), { force: true })
  fs.renameSync(path.join(WORK, 'Image'), path.join(GUEST_OUT, 'Image'))
  fs.renameSync(path.join(art, 'initrd.img'), path.join(GUEST_OUT, 'initrd.img'))
  fs.renameSync(path.join(art, 'rootfs.img'), path.join(GUEST_OUT, 'rootfs.img'))
  fs.renameSync(path.join(art, 'packages.txt'), path.join(GUEST_OUT, 'packages.txt'))

  const out = {}
  for (const f of ['Image', 'initrd.img', 'rootfs.img']) {
    const p = path.join(GUEST_OUT, f)
    out[f] = { sha256: await sha256File(p), size: fs.statSync(p).size }
  }
  const guestLock = {
    version: VERSION,
    rootHash: build.rootHash,
    hashOffset: build.hashOffset,
    files: out,
    inputs: pins,
    debian: lock.debian,
    node: pins.node.version,
    uv: pins.uv.version,
    kernelRelease: KVER,
    verity: {
      dataBlocks: build.dataBlocks,
      dataBlockSize: build.dataBlockSize,
      hashBlockSize: build.hashBlockSize,
      hashAlgorithm: build.hashAlgorithm,
      salt: build.salt
    },
    vaultd: { sha256: await sha256File(vaultdSource), placeholder: vaultdPlaceholder },
    tools: { erofs: build.erofs, cryptsetup: build.cryptsetup },
    sourceDateEpoch: EPOCH,
    builtAt: new Date().toISOString()
  }
  fs.writeFileSync(path.join(GUEST_OUT, 'guest.lock.json'), JSON.stringify(guestLock, null, 2) + '\n')
  fs.rmSync(WORK, { recursive: true, force: true })

  log(`done: ${path.relative(REPO, GUEST_OUT)}/  version ${VERSION}  root hash ${build.rootHash}`)
  for (const [f, v] of Object.entries(out)) log(`  ${f.padEnd(11)} ${(v.size / 1e6).toFixed(1).padStart(7)} MB  ${v.sha256}`)
  if (vaultdPlaceholder) console.warn('vault-image: WARNING built with the placeholder vaultd; rebuild after npx electron-vite build')
}

main().catch((e) => fail(e.stack || String(e)))
