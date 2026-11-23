#!/bin/sh
# Test the storage commands against a disposable disk image, never a physical disk.
set -eu
fixture=$(mktemp -d "${TMPDIR:-/tmp}/kladje-exfat.XXXXXXXX")
mountpoint="$fixture/mount"
mkdir "$mountpoint"
attached=false
cleanup() {
  if [ "$attached" = true ]; then hdiutil detach "$mountpoint" || return 1; fi
  rm -rf "$fixture"
}
trap cleanup EXIT
hdiutil create -size 64m -fs ExFAT -volname KLADJEQA "$fixture/exfat.dmg"
hdiutil attach -nobrowse -mountpoint "$mountpoint" "$fixture/exfat.dmg"
attached=true
diskutil info -plist "$mountpoint" | plutil -extract FilesystemType raw - | grep -ix exfat
KLADJE_EXFAT_FIXTURE="$mountpoint" cargo test --manifest-path src-tauri/Cargo.toml --locked --test portable_storage -- --ignored
