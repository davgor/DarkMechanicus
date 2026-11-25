#!/usr/bin/env bash
# Force-installs the latest DarkMechanicus macOS release from GitHub into /Applications
# and clears the Gatekeeper quarantine flag so the app opens without the "damaged" /
# "unidentified developer" block. Intended for the unsigned, un-notarized builds only.
#
# Usage: scripts/install-latest-mac.sh [--open]
#   --open  launch the app after installing
#
# Requires: macOS, the GitHub CLI (gh) logged in with read access to davgor/DarkMechanicus.

set -euo pipefail

REPO="davgor/DarkMechanicus"
APP_NAME="DarkMechanicus"
DEST_DIR="/Applications"
OPEN_AFTER=0

for arg in "$@"; do
  case "$arg" in
    --open) OPEN_AFTER=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script is for macOS only." >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is required: brew install gh && gh auth login" >&2
  exit 1
fi

case "$(uname -m)" in
  arm64) ARCH="arm64" ;;
  x86_64) ARCH="x64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

TAG="$(gh release view --repo "$REPO" --json tagName --jq .tagName)"
VERSION="${TAG#v}"
DMG_NAME="${APP_NAME}-${VERSION}-${ARCH}.dmg"
echo "Latest release: ${TAG} (${ARCH})"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dm-install.XXXXXX")"
MOUNT_POINT="${WORK_DIR}/mnt"
mkdir -p "$MOUNT_POINT"

cleanup() {
  if mount | grep -q " on ${MOUNT_POINT} "; then
    hdiutil detach "$MOUNT_POINT" -quiet || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

gh release download "$TAG" --repo "$REPO" \
  --pattern "$DMG_NAME" --pattern "latest-mac.yml" --dir "$WORK_DIR"

# Check the DMG against the sha512 that electron-builder published in latest-mac.yml.
EXPECTED_SHA="$(grep -A2 "url: ${DMG_NAME}$" "${WORK_DIR}/latest-mac.yml" | sed -n 's/.*sha512: //p' | head -n1)"
if [[ -z "$EXPECTED_SHA" ]]; then
  echo "No sha512 for ${DMG_NAME} in latest-mac.yml; refusing to install." >&2
  exit 1
fi
ACTUAL_SHA="$(openssl dgst -sha512 -binary "${WORK_DIR}/${DMG_NAME}" | base64 | tr -d '\n')"
if [[ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
  echo "Checksum mismatch for ${DMG_NAME}; refusing to install." >&2
  echo "  expected: ${EXPECTED_SHA}" >&2
  echo "  actual:   ${ACTUAL_SHA}" >&2
  exit 1
fi
echo "Checksum OK."

hdiutil attach "${WORK_DIR}/${DMG_NAME}" -nobrowse -readonly -noautoopen -mountpoint "$MOUNT_POINT" -quiet
SOURCE_APP="${MOUNT_POINT}/${APP_NAME}.app"
if [[ ! -d "$SOURCE_APP" ]]; then
  echo "${APP_NAME}.app not found inside ${DMG_NAME}." >&2
  exit 1
fi

# Quit the running copy so its files can be replaced.
osascript -e "tell application \"${APP_NAME}\" to quit" >/dev/null 2>&1 || true
sleep 1

rm -rf "${DEST_DIR}/${APP_NAME}.app"
ditto "$SOURCE_APP" "${DEST_DIR}/${APP_NAME}.app"
hdiutil detach "$MOUNT_POINT" -quiet || true

# Mark as safe to open: drop the download quarantine flag set by the browser/curl.
xattr -dr com.apple.quarantine "${DEST_DIR}/${APP_NAME}.app" 2>/dev/null || true

INSTALLED="$(defaults read "${DEST_DIR}/${APP_NAME}.app/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo unknown)"
echo "Installed ${APP_NAME} ${INSTALLED} to ${DEST_DIR}/${APP_NAME}.app"

if [[ "$OPEN_AFTER" -eq 1 ]]; then
  open "${DEST_DIR}/${APP_NAME}.app"
fi
