#!/usr/bin/env bash
# Builds the Rust core for the kit: WdFFI.xcframework (iOS device, iOS simulator, macOS for `swift test`) and the
# UniFFI Swift bindings, both under WorkerDeckKit/Native (gitignored). Usage: build-core.sh [--debug] [--sim]
# --sim skips the device slice (simulator + macOS only): enough for UI tests and `swift test`, not for the phone.
# --debug links a simulator app that dies at launch in dyld; keep it for `swift test` only.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
OUT="$HERE/../WorkerDeckKit/Native"
TARGET_DIR="$REPO/target"
PROFILE=release
TARGETS=(aarch64-apple-ios aarch64-apple-ios-sim aarch64-apple-darwin)
for arg in "$@"; do
  case "$arg" in
    --debug) PROFILE=host ;;
    --sim) TARGETS=(aarch64-apple-ios-sim aarch64-apple-darwin) ;;
  esac
done

cd "$REPO"
cargo build -p wd-native-ffi --profile host --features cli
for target in "${TARGETS[@]}"; do
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
for target in "${TARGETS[@]}"; do
  args+=(-library "$TARGET_DIR/$target/$PROFILE/libwdffi.a" -headers "$OUT/headers")
done
xcodebuild -create-xcframework "${args[@]}" -output "$OUT/WdFFI.xcframework" >/dev/null
echo "built $OUT/WdFFI.xcframework ($PROFILE) and $OUT/Bindings"
