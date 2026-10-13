#!/usr/bin/env bash
# The Android toolchain without Android Studio: an emulator, adb and Gradle on the command line.
#   android.sh emu [--headless]   create the WorkerDeck AVD if missing, boot it, wait until ready
#   android.sh stop               shut the emulator down
#   android.sh gradle <task...>   ./gradlew with a JDK that Gradle 8.14 runs on
#   android.sh adb <args...>      the SDK's adb
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
SDK=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}
AVD=${WD_AVD:-WorkerDeck_API36}
IMAGE=${WD_AVD_IMAGE:-system-images;android-36;google_apis_playstore;arm64-v8a}
ADB="$SDK/platform-tools/adb"

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

case "${1:-}" in
  emu)
    ensure_avd
    if booted; then
      echo "an emulator is already running"
      exit 0
    fi
    flags=(-avd "$AVD" -no-boot-anim -no-snapshot-save -netdelay none -netspeed full)
    [ "${2:-}" = "--headless" ] && flags+=(-no-window -no-audio)
    nohup "$SDK/emulator/emulator" "${flags[@]}" >"${TMPDIR:-/tmp}/wd-emulator.log" 2>&1 &
    "$ADB" wait-for-device
    until booted; do sleep 1; done
    echo "emulator $AVD is up (log: ${TMPDIR:-/tmp}/wd-emulator.log)"
    ;;
  stop)
    "$ADB" emu kill
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
    sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
