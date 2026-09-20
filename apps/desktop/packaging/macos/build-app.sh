#!/usr/bin/env bash
# Builds "msn desktop.app" from a release build. macOS only (needs codesign/lipo).
#   packaging/macos/build-app.sh              # native architecture
#   UNIVERSAL=1 packaging/macos/build-app.sh  # arm64 + x86_64 via lipo
# The bundle is ad-hoc signed, NOT notarized: Gatekeeper will ask you to approve it on first
# launch (right-click > Open). Real distribution needs a Developer ID identity + notarization.
set -euo pipefail

cd "$(dirname "$0")/../.."
[ "$(uname -s)" = "Darwin" ] || { echo "build-app.sh must run on macOS" >&2; exit 1; }

VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)"
APP="target/macos/msn desktop.app"
BIN=msn-desktop

if [ "${UNIVERSAL:-0}" = "1" ]; then
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
  cargo build --release --locked --target aarch64-apple-darwin
  cargo build --release --locked --target x86_64-apple-darwin
  mkdir -p target/macos
  lipo -create -output "target/macos/$BIN" \
    "target/aarch64-apple-darwin/release/$BIN" "target/x86_64-apple-darwin/release/$BIN"
  BUILT="target/macos/$BIN"
else
  cargo build --release --locked
  BUILT="target/release/$BIN"
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BUILT" "$APP/Contents/MacOS/$BIN"
sed "s/@VERSION@/$VERSION/g" packaging/macos/Info.plist.in > "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist"
codesign --force --sign - --timestamp=none "$APP"
codesign --verify --verbose "$APP"
echo "Built $APP (ad-hoc signed, not notarized)"
