/**
 * The vault guest image (D27, D32): which `rootfs.img` a new vault boots, and
 * the download of the pinned one into `<SecureAgents>/.images/` for a packaged
 * build.
 *
 * - **Packaged:** `RUNTIME_PINS.vaultGuest`. Unpublished ⇒ unavailable
 *   (`image-missing`). Published ⇒ `<SecureAgents>/.images/rootfs-<version>.img`,
 *   downloaded on first use and checked against the pin's sha256 by the shared
 *   managed-asset code; the file's presence is the proof it was verified (it
 *   is only ever published by a rename after the digest check).
 * - **Unpackaged:** `CINNA_VAULT_GUEST_DIR/rootfs.img`, else
 *   `<repo>/build/vault-guest/rootfs.img`, as `make vault-image` leaves it.
 *
 * The helper boots the rootfs with the verity root hash compiled into it, so a
 * helper built for another image could never boot this one: {@link
 * guestHashMismatch} says so before anything is created. For the same reason
 * every unlock hands the helper the image pinned *now* (a vault records the
 * one it was created with, which an update replaces), and {@link
 * pruneGuestImages} deletes the images no pin names any more.
 */
import { existsSync, readFileSync, type Dirent } from 'node:fs'
import { chmod, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { runtimeHost } from '../host/runtimeHost'
import { createLogger } from '../logger/logger'
import { downloadToFile, isFile, sweepStaging, withVerifiedFile, type DownloadProgress } from '../managed/managedAsset'
import { RUNTIME_PINS, type VaultGuestPin } from '../../shared/runtimePins'

const logger = createLogger('vault-image')

/** Where downloaded guest images live inside `SecureAgents/` (hidden; the folder's `.gitignore` is `*`). */
export const GUEST_IMAGES_DIR = '.images'

let pinOverride: VaultGuestPin | null = null

/** The guest pin in force (a test may replace it). */
export function guestPin(): VaultGuestPin {
  return pinOverride ?? RUNTIME_PINS.vaultGuest
}

/** Test seam: pretend another image is pinned; `null` restores the real pin. */
export function setGuestPinForTest(pin: VaultGuestPin | null): void {
  pinOverride = pin
}

function devGuestDir(): string {
  return process.env['CINNA_VAULT_GUEST_DIR'] || join(runtimeHost.getAppPath(), 'build', 'vault-guest')
}

/** `<SecureAgents>/.images/rootfs-<version>.img`. */
export function guestImagePath(secureAgentsDir: string, pin: VaultGuestPin = guestPin()): string {
  return join(secureAgentsDir, GUEST_IMAGES_DIR, `rootfs-${pin.version.replace(/[^A-Za-z0-9._-]/g, '_')}.img`)
}

/**
 * Whether a guest image can be had, without touching the network. Packaged
 * and published: `path` is null (it is downloaded into `SecureAgents/` when a
 * vault is created, by {@link ensureGuestImage}). Unpackaged: the dev image.
 */
export function guestRootfs(): { ok: true; path: string | null; version: string } | { ok: false; detail: string } {
  const pin = guestPin()
  if (runtimeHost.isPackaged) {
    if (!pin.published) return { ok: false, detail: GUEST_IMAGE_UNPUBLISHED }
    return { ok: true, path: null, version: pin.version }
  }
  const path = join(devGuestDir(), 'rootfs.img')
  if (existsSync(path)) return { ok: true, path, version: 'dev' }
  // The UI says what is missing, never how to rebuild it: the developer's
  // hint (which folder, which make target) goes to the log only.
  const where = process.env['CINNA_VAULT_GUEST_DIR'] || 'build/vault-guest'
  logger.warn(`no dev guest image in ${where}: run make vault-image (or make vault-dev-restart)`)
  return { ok: false, detail: GUEST_IMAGE_MISSING }
}

/** This version of Cinna pins no published image: no vault can start. */
export const GUEST_IMAGE_UNPUBLISHED = "The vault system image for this version of Cinna is not available yet, so vaults can't start."
/** The image this build boots is not on this Mac. */
export const GUEST_IMAGE_MISSING = "The vault system image is missing, so the vault can't start."

/**
 * The root hash the image to boot was built with: the pin's when packaged,
 * the dev image's `guest.lock.json` otherwise (null when it cannot be read:
 * then nothing is compared).
 */
function expectedRootHash(): string | null {
  if (runtimeHost.isPackaged) return guestPin().published ? guestPin().rootHash.toLowerCase() : null
  try {
    const lock = JSON.parse(readFileSync(join(devGuestDir(), 'guest.lock.json'), 'utf8')) as { rootHash?: unknown }
    return typeof lock.rootHash === 'string' && lock.rootHash ? lock.rootHash.toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * Null when the helper can boot the image this build would hand it; else the
 * sentence why not (its compiled-in verity root hash is another image's).
 */
export function guestHashMismatch(helperRootHash: string): string | null {
  const expected = expectedRootHash()
  if (expected === null) return null
  if (helperRootHash.toLowerCase() === expected) return null
  return `The vault helper was built for another guest image (root hash ${helperRootHash.slice(0, 12) || 'none'}…, this build expects ${expected.slice(0, 12)}…).`
}

/** Test seam for {@link ensureGuestImage}. */
export interface EnsureGuestImageOptions {
  download?: (url: string, dest: string, onProgress?: DownloadProgress, expectedBytes?: number) => Promise<void>
}

/**
 * Downloads in flight per target path: a second move joins the first, and
 * hears its progress too (from the last percent reached).
 */
const inflight = new Map<string, { done: Promise<string>; listeners: Set<(percent: number) => void>; lastPercent: number | null }>()

/**
 * The path of the rootfs a new vault in `secureAgentsDir` boots. Unpackaged:
 * the dev image. Packaged: the pinned image, downloaded and sha256-checked
 * into `.images/` when it is not there yet, with byte progress to
 * `onProgress` (percent, 0–100). Throws the managed-asset error (with a
 * sentence) when it cannot be had.
 */
export async function ensureGuestImage(
  secureAgentsDir: string,
  onProgress?: (percent: number) => void,
  options: EnsureGuestImageOptions = {}
): Promise<string> {
  const image = guestRootfs()
  if (!image.ok) throw new Error(image.detail)
  if (image.path) return image.path
  const pin = guestPin()
  const target = guestImagePath(secureAgentsDir, pin)
  if (await isFile(target)) return target
  let pending = inflight.get(target)
  if (!pending) {
    const entry = { done: null as unknown as Promise<string>, listeners: new Set<(percent: number) => void>(), lastPercent: null as number | null }
    const broadcast = (percent: number): void => {
      entry.lastPercent = percent
      for (const listener of entry.listeners) {
        try { listener(percent) } catch { /* a listener's own failure is not the download's */ }
      }
    }
    entry.done = downloadGuestImage(secureAgentsDir, target, pin, broadcast, options).finally(() => inflight.delete(target))
    inflight.set(target, entry)
    pending = entry
  } else if (onProgress && pending.lastPercent !== null) {
    onProgress(pending.lastPercent)
  }
  if (onProgress) pending.listeners.add(onProgress)
  return pending.done
}

async function downloadGuestImage(
  secureAgentsDir: string,
  target: string,
  pin: VaultGuestPin,
  onProgress: ((percent: number) => void) | undefined,
  options: EnsureGuestImageOptions
): Promise<string> {
  const root = join(secureAgentsDir, GUEST_IMAGES_DIR)
  await mkdir(root, { recursive: true })
  // Leftovers of a download a quit interrupted.
  await sweepStaging(root)
  const download = options.download ?? downloadToFile
  let lastPercent = -1
  const progress: DownloadProgress = (received, total) => {
    const denominator = total ?? pin.rootfs.size
    if (!onProgress || !denominator) return
    const percent = Math.min(100, Math.floor((received / denominator) * 100))
    if (percent === lastPercent) return
    lastPercent = percent
    onProgress(percent)
  }
  await withVerifiedFile(
    {
      root,
      label: 'vault image',
      archiveName: pin.rootfs.file || 'rootfs.img',
      url: pin.rootfs.url,
      sha256: pin.rootfs.sha256,
      name: 'rootfs.img',
      download: (url, dest) => download(url, dest, progress, pin.rootfs.size || undefined),
      // Not an archive: the verified file itself is what is published.
      extract: (archive, dest) => rename(archive, join(dest, 'rootfs.img')),
      notFoundMessage: 'The downloaded vault image was not where it was expected.'
    },
    async (file) => {
      await chmod(file, 0o444)
      // Published only now, verified: the path existing means these bytes.
      await rename(file, target)
    }
  )
  logger.info('downloaded the vault guest image', { version: pin.version })
  return target
}

/** A downloaded guest image's name in `.images/`. */
const GUEST_IMAGE_NAME = /^rootfs-[A-Za-z0-9._-]+\.img$/

/**
 * Packaged, published pin: deletes the guest images in
 * `<secureAgentsDir>/.images/` that are not the pinned one, and the staging
 * leftovers of an interrupted download. Safe because every unlock boots the
 * pinned image (a running VM keeps the inode it opened). Touches only
 * `rootfs-*.img` entries and `.staging-*` directories directly inside
 * `.images/`, and nothing when `.images` is not a real directory. Never
 * throws; the names it removed.
 */
export async function pruneGuestImages(secureAgentsDir: string, pin: VaultGuestPin = guestPin()): Promise<string[]> {
  if (!runtimeHost.isPackaged || !pin.published) return []
  const root = join(secureAgentsDir, GUEST_IMAGES_DIR)
  try {
    if (!(await lstat(root)).isDirectory()) return []
  } catch {
    return []
  }
  const keep = basename(guestImagePath(secureAgentsDir, pin))
  const entries: Dirent[] = await readdir(root, { withFileTypes: true }).catch((): Dirent[] => [])
  const removed: string[] = []
  for (const entry of entries) {
    if (entry.name === keep || !GUEST_IMAGE_NAME.test(entry.name)) continue
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    try {
      await rm(join(root, entry.name), { force: true })
      removed.push(entry.name)
    } catch (error) {
      logger.warn('could not delete an old vault guest image', { name: entry.name, error: error instanceof Error ? error.message : String(error) })
    }
  }
  // Partial downloads (a download running in this process keeps its own).
  await sweepStaging(root).catch(() => undefined)
  if (removed.length > 0) logger.info('deleted old vault guest images', { removed, kept: keep })
  return removed
}
