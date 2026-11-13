#!/bin/sh
set -eu

# Build Vesper.app as a self-contained, universal (arm64 + x86_64) bundle.
# The Node runtime is embedded, so the app has no external runtime dependency.

ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP="$ROOT/Vesper.app"
BUILD="$ROOT/.build"
NODE_VERSION="${NODE_VERSION:-v24.22.3}"
VERSION=$(cat "$ROOT/VERSION" 2>/dev/null || echo "0.0.0")
NODE_BASE="https://nodejs.org/dist/${NODE_VERSION}"

mkdir -p "$BUILD"

# ---------------------------------------------------------------- node runtime

fetch_node() {
  ARCH=$1
  DIR="$BUILD/node-${NODE_VERSION}-${ARCH}"
  if [ -x "$DIR/bin/node" ]; then return; fi
  TARBALL="$BUILD/node-${NODE_VERSION}-${ARCH}.tar.gz"
  NAME="node-${NODE_VERSION}-darwin-${ARCH}.tar.gz"
  if [ ! -f "$TARBALL" ]; then
    echo "Downloading Node ${NODE_VERSION} (${ARCH})…"
    curl -fL --retry 3 --silent --show-error "$NODE_BASE/$NAME" -o "$TARBALL"
  fi

  EXPECTED=$(curl -fsL "$NODE_BASE/SHASUMS256.txt" | awk -v n="$NAME" '$2 == n { print $1 }')
  ACTUAL=$(shasum -a 256 "$TARBALL" | awk '{ print $1 }')
  if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
    rm -f "$TARBALL"
    echo "Node checksum mismatch for ${ARCH}" >&2
    exit 1
  fi

  rm -rf "$DIR"
  mkdir -p "$DIR"
  tar -xzf "$TARBALL" -C "$DIR" --strip-components 1
}

fetch_node arm64
fetch_node x64

mkdir -p "$BUILD/runtime"
lipo -create "$BUILD/node-${NODE_VERSION}-arm64/bin/node" "$BUILD/node-${NODE_VERSION}-x64/bin/node" \
  -output "$BUILD/runtime/node"
chmod 755 "$BUILD/runtime/node"
"$BUILD/runtime/node" --version >/dev/null

# ---------------------------------------------------------------------- bundle

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app" "$APP/Contents/Resources"

echo "Compiling Vesper ${VERSION} (universal)…"
swiftc -O -swift-version 5 -target arm64-apple-macos13.0 \
  "$ROOT/mac/Vesper.swift" -o "$BUILD/Vesper-arm64"
swiftc -O -swift-version 5 -target x86_64-apple-macos13.0 \
  "$ROOT/mac/Vesper.swift" -o "$BUILD/Vesper-x64"
lipo -create "$BUILD/Vesper-arm64" "$BUILD/Vesper-x64" -output "$APP/Contents/MacOS/Vesper"

cp "$ROOT/mac/Info.plist" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$APP/Contents/Info.plist"
BUILD_NUMBER=$(printf '%s' "$VERSION" | tr -d '.')
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" "$APP/Contents/Info.plist"
printf '%s\n' "$VERSION" > "$APP/Contents/Resources/VERSION"

cp "$ROOT/server.mjs" "$APP/Contents/Resources/app/server.mjs"
cp -R "$ROOT/lib" "$APP/Contents/Resources/app/lib"
cp -R "$ROOT/public" "$APP/Contents/Resources/app/public"
cp "$ROOT/package.json" "$APP/Contents/Resources/app/package.json"
printf '%s\n' "$VERSION" > "$APP/Contents/Resources/app/VERSION"
cp "$BUILD/runtime/node" "$APP/Contents/Resources/node"

# ------------------------------------------------------------------------ icon

if [ ! -f "$BUILD/AppIcon.icns" ]; then
  if command -v qlmanage >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
    TMP=$(mktemp -d)
    qlmanage -t -s 1024 -o "$TMP" "$ROOT/mac/icon.svg" >/dev/null 2>&1 || true
    PNG="$TMP/icon.svg.png"
    if [ -f "$PNG" ]; then
      ICONSET="$TMP/Vesper.iconset"
      mkdir -p "$ICONSET"
      for size in 16 32 128 256 512; do
        double=$((size * 2))
        sips -z "$size" "$size" "$PNG" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
        sips -z "$double" "$double" "$PNG" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
      done
      iconutil -c icns "$ICONSET" -o "$BUILD/AppIcon.icns"
    fi
    rm -rf "$TMP"
  fi
fi
[ -f "$BUILD/AppIcon.icns" ] && cp "$BUILD/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"

# ----------------------------------------------------------------------- sign

codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true

echo "Built $APP"
