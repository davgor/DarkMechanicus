import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, createReadStream, createWriteStream, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { promisify } from 'node:util'
import { logger } from './logger'

/**
 * macOS update path. Squirrel.Mac needs a Developer ID signature, which unsigned builds do not
 * have, so on macOS the app fetches the release DMG itself, checks it against the sha512 that
 * electron-builder published in `latest-mac.yml`, stages the `.app` under userData, and swaps it
 * in after the app has quit.
 */

const GITHUB_RELEASE_DOWNLOAD_BASE = 'https://github.com/davgor/DarkMechanicus/releases/download'
export const APP_BUNDLE_NAME = 'DarkMechanicus.app'
/** Upper bound for one DMG download, so a stalled connection cannot block update checks forever. */
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000

const execFileAsync = promisify(execFile)

interface MacUpdateFile {
  readonly url: string
  readonly sha512: string
}

export interface StagedMacUpdate {
  /** Path to the verified, unpacked `.app` waiting to replace the running bundle. */
  readonly appPath: string
  /** Private folder holding the staged app; removed after install or when superseded. */
  readonly workDir: string
}

/** Arch suffix electron-builder uses in DMG names (`DarkMechanicus-<version>-<arch>.dmg`). */
export function macArchSuffix(arch: string): 'arm64' | 'x64' {
  return arch === 'arm64' ? 'arm64' : 'x64'
}

/** Picks the DMG for this machine's architecture out of the `latest-mac.yml` file list. */
export function pickMacDmg(files: readonly MacUpdateFile[], arch: string): MacUpdateFile | undefined {
  const suffix = `-${macArchSuffix(arch)}.dmg`
  return files.find((file) => file.url.endsWith(suffix))
}

export function releaseAssetUrl(version: string, fileName: string): string {
  return `${GITHUB_RELEASE_DOWNLOAD_BASE}/v${version}/${fileName}`
}

/** Returns the `.app` bundle containing `execPath`, or undefined when not running from a bundle (dev). */
export function appBundlePathFromExecPath(execPath: string): string | undefined {
  const marker = `${APP_BUNDLE_NAME}/Contents/MacOS/`
  const index = execPath.indexOf(marker)
  return index === -1 ? undefined : execPath.slice(0, index + APP_BUNDLE_NAME.length)
}

/**
 * Installing into a DMG volume or a translocated quarantine copy would relaunch the old build on
 * every start, so refuse those locations.
 */
export function isInstallableLocation(targetApp: string): boolean {
  return !targetApp.startsWith('/Volumes/') && !targetApp.includes('AppTranslocation')
}

/** The swap creates and removes entries beside the bundle, so its folder must be writable. */
export function canReplaceBundle(targetApp: string): boolean {
  try {
    accessSync(dirname(targetApp), constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** Removes `dm-update-*` folders left in the staging root by earlier sessions. */
export function sweepStaleMacUpdates(stagingRoot: string): void {
  let entries: string[]
  try {
    entries = readdirSync(stagingRoot)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.startsWith('dm-update-')) {
      rmSync(join(stagingRoot, entry), { recursive: true, force: true })
    }
  }
}

/**
 * Runs after the app (pid $1) has exited. $2 is the staged app, $3 the installed bundle, $4 the
 * staging folder to delete. The new copy is made beside the old bundle and swapped in with two
 * renames, so a failed copy or rename leaves the current app in place. Positional arguments only.
 */
export const INSTALL_HELPER_SCRIPT = `
mkdir -p "$HOME/Library/Logs"
exec >>"$HOME/Library/Logs/DarkMechanicus-update.log" 2>&1
PID="$1"; SRC="$2"; DEST="$3"; CLEANUP="$4"
NEW="$DEST.new"; OLD="$DEST.old"
while kill -0 "$PID" 2>/dev/null; do sleep 0.5; done
rm -rf "$NEW" "$OLD"
if [ -d "$SRC/Contents/MacOS" ] && ditto "$SRC" "$NEW"; then
  xattr -dr com.apple.quarantine "$NEW" 2>/dev/null
  if { [ ! -e "$DEST" ] || mv "$DEST" "$OLD"; } && mv "$NEW" "$DEST"; then
    rm -rf "$OLD"
  else
    echo "install swap failed; restoring previous app"
    rm -rf "$NEW"
    if [ -e "$OLD" ] && [ ! -e "$DEST" ]; then mv "$OLD" "$DEST"; fi
  fi
else
  echo "staged copy failed or is incomplete; keeping current app"
  rm -rf "$NEW"
fi
rm -rf "$CLEANUP"
open "$DEST"
`

export function startInstallHelper(staged: StagedMacUpdate, targetApp: string, pid: number): void {
  if (!targetApp.endsWith(`/${APP_BUNDLE_NAME}`)) {
    throw new Error(`Refusing to replace unexpected bundle path: ${targetApp}`)
  }
  if (!isInstallableLocation(targetApp)) {
    throw new Error(`Cannot update an app running from ${targetApp}; move it to Applications first`)
  }
  const child = spawn(
    '/bin/sh',
    ['-c', INSTALL_HELPER_SCRIPT, 'dm-update', String(pid), staged.appPath, targetApp, staged.workDir],
    { detached: true, stdio: 'ignore' }
  )
  child.unref()
}

/** Deletes a staged update that will not be installed (superseded or failed). */
export function discardStagedMacUpdate(staged: StagedMacUpdate): void {
  rmSync(staged.workDir, { recursive: true, force: true })
}

async function sha512OfFile(path: string): Promise<string> {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
  return hash.digest('base64')
}

async function downloadToFile(url: string, path: string, onProgress: (percent: number) => void): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}) for ${url}`)
  }
  const total = Number(response.headers.get('content-length') ?? 0)
  let received = 0
  const body = Readable.fromWeb(response.body as unknown as WebReadableStream)
  body.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (total > 0) {
      onProgress(Math.min(99, Math.round((received / total) * 100)))
    }
  })
  // pipeline destroys both streams and rejects on a write error (for example a full disk).
  await pipeline(body, createWriteStream(path))
}

/**
 * Downloads the DMG for `version` into a new folder under `stagingRoot`, verifies it, and stages
 * the unpacked app. Throws on any failure after removing that folder. Calls `onProgress` with
 * 0-99 while downloading.
 */
interface StageRequest {
  readonly version: string
  readonly files: readonly MacUpdateFile[]
  readonly arch: string
  readonly stagingRoot: string
  readonly onProgress: (percent: number) => void
}

export async function downloadAndStageMacUpdate(request: StageRequest): Promise<StagedMacUpdate> {
  const { version, files, arch, stagingRoot, onProgress } = request
  const file = pickMacDmg(files, arch)
  if (!file) {
    throw new Error(`No macOS ${macArchSuffix(arch)} DMG listed for version ${version}`)
  }
  const fileName = file.url.split('/').pop() ?? file.url
  mkdirSync(stagingRoot, { recursive: true })
  const workDir = mkdtempSync(join(stagingRoot, 'dm-update-'))
  try {
    const dmgPath = join(workDir, fileName)
    await downloadToFile(releaseAssetUrl(version, fileName), dmgPath, onProgress)

    const actual = await sha512OfFile(dmgPath)
    if (actual !== file.sha512) {
      throw new Error(`Checksum mismatch for ${fileName}; update discarded`)
    }

    const mountPoint = join(workDir, 'mount')
    mkdirSync(mountPoint)
    await execFileAsync('hdiutil', ['attach', dmgPath, '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mountPoint])
    let appPath: string
    try {
      const stagedDir = join(workDir, 'staged')
      mkdirSync(stagedDir)
      appPath = join(stagedDir, APP_BUNDLE_NAME)
      await execFileAsync('ditto', [join(mountPoint, APP_BUNDLE_NAME), appPath])
    } finally {
      await execFileAsync('hdiutil', ['detach', mountPoint, '-quiet']).catch(async (error: unknown) => {
        logger.error('Failed to detach update DMG, forcing:', error)
        await execFileAsync('hdiutil', ['detach', mountPoint, '-force', '-quiet']).catch((forceError: unknown) => {
          logger.error('Forced detach of update DMG failed:', forceError)
        })
      })
    }
    rmSync(dmgPath, { force: true })
    return { appPath, workDir }
  } catch (error: unknown) {
    rmSync(workDir, { recursive: true, force: true })
    throw error
  }
}
