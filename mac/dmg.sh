#!/bin/sh
set -eu

# Package Vesper.app into a compressed, drag-to-Applications disk image.

ROOT=$(cd "$(dirname "$0")/.." && pwd)
VERSION=$(cat "$ROOT/VERSION")
NAME="Vesper-${VERSION}"
DIST="$ROOT/dist"
STAGE="$ROOT/.build/dmg"
TMP="$ROOT/.build/${NAME}-rw.dmg"
OUT="$DIST/${NAME}.dmg"

mkdir -p "$DIST"

sh "$ROOT/mac/build.sh"

rm -rf "$STAGE"
mkdir -p "$STAGE/.background"
cp -R "$ROOT/Vesper.app" "$STAGE/Vesper.app"
ln -s /Applications "$STAGE/Applications"

if command -v qlmanage >/dev/null 2>&1; then
  qlmanage -t -s 660 -o "$STAGE/.background" "$ROOT/mac/dmg-background.svg" >/dev/null 2>&1 || true
  if [ -f "$STAGE/.background/dmg-background.svg.png" ]; then
    mv "$STAGE/.background/dmg-background.svg.png" "$STAGE/.background/background.png"
  fi
fi

rm -f "$TMP"
hdiutil create -quiet -ov -volname "Vesper ${VERSION}" -fs HFS+ -srcfolder "$STAGE" -format UDRW "$TMP"

MOUNT="$ROOT/.build/mnt"
rm -rf "$MOUNT"
mkdir -p "$MOUNT"
if ! hdiutil attach -readwrite -noverify -noautoopen -mountpoint "$MOUNT" "$TMP" >/dev/null; then
  echo "Could not mount the staging image." >&2
  exit 1
fi

osascript >/dev/null 2>&1 <<APPLESCRIPT || true
tell application "Finder"
  tell disk "Vesper ${VERSION}"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {120, 120, 780, 540}
    set viewOptions to the icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to 104
    try
      set background picture of viewOptions to file ".background:background.png"
    end try
    set position of item "Vesper.app" of container window to {170, 200}
    set position of item "Applications" of container window to {490, 200}
    update without registering applications
    delay 1
    close
  end tell
end tell
APPLESCRIPT

sync
hdiutil detach "$MOUNT" -quiet || true

rm -f "$OUT"
hdiutil convert "$TMP" -quiet -format UDZO -imagekey zlib-level=9 -o "$OUT"
rm -f "$TMP"

(cd "$DIST" && shasum -a 256 "${NAME}.dmg" > SHA256SUMS)

echo "Built $OUT"
