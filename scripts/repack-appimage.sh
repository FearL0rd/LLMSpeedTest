#!/usr/bin/env bash
# The catalog runs the AppImage as a user other than the one who packed it.
# linuxdeploy leaves AppRun.wrapped mode 0770, so that user gets
# "Permission denied" and the process exits before a window exists.
# Repack with modes other users can read and execute.
set -euo pipefail

# Last octal digit must be 5 (r-x) or 7 (rwx): others can read and execute.
check_other_exec() {
  local mode last
  mode=$(stat -c '%a' "$1")
  last=${mode: -1}
  case $last in
    5|7) ;;
    *)
      echo "$1 mode $mode is not readable and executable for others" >&2
      exit 1
      ;;
  esac
}

cd "$(dirname "$0")/.."
umask 022

appimage=$(find src-tauri/target/release/bundle/appimage -name '*.AppImage' -print -quit)
if [ -z "$appimage" ]; then
  echo "no AppImage under src-tauri/target/release/bundle/appimage" >&2
  exit 1
fi
appimage=$(readlink -f "$appimage")

work=$(mktemp -d)
verify=$(mktemp -d)
trap 'rm -rf "$work" "$verify"' EXIT

chmod a+x "$appimage"
( cd "$work" && "$appimage" --appimage-extract )

root="$work/squashfs-root"
chmod -R a+rX "$root"
chmod a+x "$root/AppRun"
if [ ! -f "$root/AppRun.wrapped" ]; then
  echo "AppRun.wrapped missing from the extracted AppImage" >&2
  exit 1
fi
chmod a+x "$root/AppRun.wrapped"
check_other_exec "$root/AppRun"
check_other_exec "$root/AppRun.wrapped"

tool="$work/appimagetool"
curl -fsSL -o "$tool" https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
chmod a+x "$tool"

# GitHub stores release assets with spaces turned into dots. That is the
# name tauri-action already uploaded; write the same name so this replaces it.
base=$(basename "$appimage")
dotted=${base// /.}
mkdir -p appimage-fixed
out="$(pwd)/appimage-fixed/$dotted"
ARCH=x86_64 "$tool" --appimage-extract-and-run "$root" "$out"
chmod a+x "$out"

( cd "$verify" && "$out" --appimage-extract )
check_other_exec "$verify/squashfs-root/AppRun"
check_other_exec "$verify/squashfs-root/AppRun.wrapped"
echo "repacked $out"
