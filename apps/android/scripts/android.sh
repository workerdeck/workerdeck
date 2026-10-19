#!/usr/bin/env bash
# The Android toolchain without Android Studio: an emulator, adb and Gradle on the command line.
#   android.sh emu [--headless]   create the WorkerDeck AVD if missing, boot it, wait until ready
#   android.sh stop               shut the emulator down
#   android.sh dev [--headless]   private test gateway on :8790 + emulator + debug app, launched
#   android.sh dev stop           stop the private test gateway and the emulator
#   android.sh profile            (rig up) regenerate the baseline profile into app/src/release/generated
#   android.sh bench              (rig up) startup + transcript scroll macrobenchmarks, with and without it
#   android.sh gradle <task...>   ./gradlew with a JDK that Gradle 8.14 runs on
#   android.sh adb <args...>      the SDK's adb
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
SDK=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}
AVD=${WD_AVD:-WorkerDeck_API36}
IMAGE=${WD_AVD_IMAGE:-system-images;android-36;google_apis_playstore;arm64-v8a}
ADB="$SDK/platform-tools/adb"
REPO=$(cd "$HERE/../.." && pwd)
DEV_DIR=${WD_ANDROID_DEV_DIR:-/tmp/wd-android}
DEV_PORT=8790
DEV_KEY=androiddevkey

java_home() {
  if [ -n "${JAVA_HOME:-}" ] && "$JAVA_HOME/bin/java" -version 2>&1 | grep -qE 'version "(17|21)'; then
    echo "$JAVA_HOME"
  elif [ -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ]; then
    echo "/Applications/Android Studio.app/Contents/jbr/Contents/Home"
  elif /usr/libexec/java_home -v 21 >/dev/null 2>&1; then
    /usr/libexec/java_home -v 21
  else
    /usr/libexec/java_home -v 17
  fi
}

ensure_avd() {
  if "$SDK/emulator/emulator" -list-avds | grep -qx "$AVD"; then
    return
  fi
  local image_dir="$SDK/system-images/$(tr ';' '/' <<< "${IMAGE#system-images;}")"
  if [ ! -d "$image_dir" ]; then
    echo "installing $IMAGE"
    JAVA_HOME=$(java_home) "$SDK/cmdline-tools/latest/bin/sdkmanager" --install "$IMAGE"
  fi
  echo "creating AVD $AVD"
  echo no | JAVA_HOME=$(java_home) "$SDK/cmdline-tools/latest/bin/avdmanager" create avd -n "$AVD" -k "$IMAGE" -d pixel_8
}

booted() {
  [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]
}

start_emu() {
  ensure_avd
  if booted; then
    echo "an emulator is already running"
    return
  fi
  local flags=(-avd "$AVD" -no-boot-anim -no-snapshot-save -netdelay none -netspeed full)
  [ "${1:-}" = "--headless" ] && flags+=(-no-window -no-audio)
  # setsid: the shell that ran us kills its process group on exit, and nohup only covers SIGHUP.
  perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' "$SDK/emulator/emulator" "${flags[@]}" </dev/null >"${TMPDIR:-/tmp}/wd-emulator.log" 2>&1 &
  "$ADB" wait-for-device
  until booted; do sleep 1; done
  echo "emulator $AVD is up (log: ${TMPDIR:-/tmp}/wd-emulator.log)"
}

gateway_up() {
  curl -sf -o /dev/null -H "x-workerdeck-key: $DEV_KEY" "http://127.0.0.1:$DEV_PORT/v1/sessions"
}

start_gateway() {
  if gateway_up; then
    echo "private gateway already up on :$DEV_PORT"
    return
  fi
  rm -rf "$DEV_DIR/state"
  mkdir -p "$DEV_DIR/state"
  [ -e "$HOME/.workerdeck/profiles.json" ] && cp "$HOME/.workerdeck/profiles.json" "$DEV_DIR/state/"
  echo 'export default { shell: { enabled: true } }' >"$DEV_DIR/config.mjs"
  pushd "$REPO" >/dev/null
  perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' node --conditions=@workerdeck/source \
    --import @swc-node/register/esm-register packages/cli/src/cli.ts -c "$DEV_DIR/config.mjs" --port "$DEV_PORT" \
    --host 127.0.0.1 --state-dir "$DEV_DIR/state" --auth-key "$DEV_KEY" </dev/null >"$DEV_DIR/gateway.log" 2>&1 &
  echo $! >"$DEV_DIR/gateway.pid"
  popd >/dev/null
  for _ in $(seq 60); do
    gateway_up && { echo "private gateway up on :$DEV_PORT (log: $DEV_DIR/gateway.log)"; return; }
    sleep 1
  done
  echo "private gateway did not come up; see $DEV_DIR/gateway.log" >&2
  exit 1
}

case "${1:-}" in
  emu)
    start_emu "${2:-}"
    ;;
  dev)
    if [ "${2:-}" = "stop" ]; then
      [ -f "$DEV_DIR/gateway.pid" ] && kill "$(cat "$DEV_DIR/gateway.pid")" 2>/dev/null || true
      rm -f "$DEV_DIR/gateway.pid"
      "$ADB" emu kill 2>/dev/null || true
      exit 0
    fi
    start_gateway
    start_emu "${2:-}"
    (cd "$HERE" && JAVA_HOME=$(java_home) ./gradlew -q :app:installDebug)
    "$ADB" shell am start -n bi.atomic.workerdeck/.app.MainActivity >/dev/null
    echo "app launched; pair with the pre-filled http://10.0.2.2:$DEV_PORT (stop: pnpm android dev stop)"
    ;;
  stop)
    "$ADB" emu kill
    ;;
  profile)
    "$ADB" reverse tcp:$DEV_PORT tcp:$DEV_PORT >/dev/null
    (cd "$HERE" && JAVA_HOME=$(java_home) ./gradlew :app:generateBaselineProfile)
    ;;
  bench)
    "$ADB" reverse tcp:$DEV_PORT tcp:$DEV_PORT >/dev/null
    # Macrobenchmark refuses emulators; their numbers only compare with and without the profile, a phone measures.
    (cd "$HERE" && JAVA_HOME=$(java_home) ./gradlew :baselineprofile:connectedBenchmarkReleaseAndroidTest \
      -Pandroid.testInstrumentationRunnerArguments.androidx.benchmark.suppressErrors=EMULATOR)
    echo "results: $HERE/baselineprofile/build/outputs/connected_android_test_additional_output/"
    ;;
  gradle)
    shift
    cd "$HERE"
    JAVA_HOME=$(java_home) ./gradlew "$@"
    ;;
  adb)
    shift
    exec "$ADB" "$@"
    ;;
  *)
    sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
