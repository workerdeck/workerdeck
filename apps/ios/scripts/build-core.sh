#!/usr/bin/env bash
# Builds the Rust core for the kit: WdFFI.xcframework (iOS device, iOS simulator, macOS for `swift test`) and the
# UniFFI Swift bindings, both under WorkerDeckKit/Native (gitignored). Usage: build-core.sh [--debug]
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
OUT="$HERE/../WorkerDeckKit/Native"
TARGET_DIR="$REPO/target"
PROFILE=release
[ "${1:-}" = "--debug" ] && PROFILE=host

cd "$REPO"
cargo build -p wd-native-ffi --profile host --features cli
for target in aarch64-apple-ios aarch64-apple-ios-sim aarch64-apple-darwin; do
  IPHONEOS_DEPLOYMENT_TARGET=18.0 MACOSX_DEPLOYMENT_TARGET=14.0 \
    cargo build -p wd-native-ffi --profile "$PROFILE" --target "$target" --lib
done

rm -rf "$OUT"
mkdir -p "$OUT/headers" "$OUT/Bindings"
"$TARGET_DIR/host/uniffi-bindgen" generate --library "$TARGET_DIR/host/libwdffi.dylib" --language swift \
  --out-dir "$OUT/gen"
mv "$OUT/gen/"*FFI.h "$OUT/headers/"
mv "$OUT/gen/"*FFI.modulemap "$OUT/headers/module.modulemap"
mv "$OUT/gen/"*.swift "$OUT/Bindings/"
rm -rf "$OUT/gen"

args=()
for target in aarch64-apple-ios aarch64-apple-ios-sim aarch64-apple-darwin; do
  args+=(-library "$TARGET_DIR/$target/$PROFILE/libwdffi.a" -headers "$OUT/headers")
done
xcodebuild -create-xcframework "${args[@]}" -output "$OUT/WdFFI.xcframework" >/dev/null
echo "built $OUT/WdFFI.xcframework ($PROFILE) and $OUT/Bindings"
