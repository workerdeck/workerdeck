#!/usr/bin/env bash
#
# Build the iOS app and push it to a paired iPhone — the loop an agent runs so you
# can follow along on the real device instead of a simulator screenshot.
#
#   apps/ios/scripts/deploy.sh              # generate, build, install, launch
#   apps/ios/scripts/deploy.sh --no-launch  # install only (works on a locked phone)
#   apps/ios/scripts/deploy.sh --hot        # ...and bundle InjectionNext, for hot reload
#   apps/ios/scripts/deploy.sh --release    # optimized build — what a shipped app costs
#   apps/ios/scripts/deploy.sh --device "Tobias's iPhone"
#
# Three facts shape this script (learned the hard way, see apps/ios/README.md):
#
#   1. Building with `-destination 'id=<udid>'` needs the phone *unlocked* — Xcode
#      wants to talk to it to "recover from previously reported preparation
#      errors". `generic/platform=iOS` builds for device without touching it, so
#      that is what we use.
#   2. Installing to a locked phone works. *Launching* does not: it fails with
#      FBSOpenApplicationErrorDomain error 7. That is reported here as a plain
#      "unlock your phone" line, not as a wall of CoreDevice output.
#   3. Device signing needs an explicit team; `project.yml` deliberately pins
#      none, so it is passed on the command line. See `--team` below.
#
set -euo pipefail

IOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$IOS_DIR/WorkerDeckApp.xcodeproj"
SCHEME="WorkerDeckApp"
BUNDLE_ID="bi.atomic.workerdeck.ios"
DERIVED="$IOS_DIR/DerivedData"
# Debug by default: the loop this script exists for is edit-build-look, and
# `--hot` needs it. `--release` is for measuring, and the difference is not
# cosmetic — the transcript fold alone is ~5.6x slower unoptimized (measured
# 2026-08-19 over a captured replay), so a performance number taken from a Debug
# build is a number about the build, not about the app.
configuration="Debug"
# Team and default device live outside git: a Team ID is not a secret but it is
# not this repo's business either, and the device is per-machine.
ENV_FILE="$IOS_DIR/.deploy.env"

device=""
team="${IOS_DEVELOPMENT_TEAM:-}"
launch=1
generate=1
hot=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) device="$2"; shift 2 ;;
    --team) team="$2"; shift 2 ;;
    --no-launch) launch=0; shift ;;
    --no-generate) generate=0; shift ;;
    --hot) hot=1; shift ;;
    --release) configuration="Release"; shift ;;
    -h|--help) sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# shellcheck disable=SC1090
[[ -f "$ENV_FILE" ]] && source "$ENV_FILE"
APP="$DERIVED/Build/Products/$configuration-iphoneos/WorkerDeckApp.app"
if [[ "$configuration" == "Release" && $hot -eq 1 ]]; then
  echo "--hot needs a Debug build (InjectionNext swaps code the optimizer inlined away)" >&2
  exit 2
fi

device="${device:-${IOS_DEVICE:-}}"
team="${team:-${IOS_DEVELOPMENT_TEAM:-}}"

step() { printf '\033[1;34m▸\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$1" >&2; exit 1; }

if [[ -z "$team" ]]; then
  fail "No development team. Pass --team <ID>, export IOS_DEVELOPMENT_TEAM, or write it to
  $ENV_FILE (gitignored):

    IOS_DEVELOPMENT_TEAM=XXXXXXXXXX
    IOS_DEVICE=\"Your iPhone\"

  Candidates from your keychain:
$(security find-certificate -a -c "Apple Development" -p 2>/dev/null \
    | openssl x509 -noout -subject 2>/dev/null | sed 's/^/    /' || true)"
fi

# --- device ------------------------------------------------------------------
# Resolved before the build so a missing phone fails in two seconds rather than
# after a full compile.
command -v jq >/dev/null || fail "jq is required (brew install jq)."
devices_json="$(mktemp -t workerdeck-devices)"
trap 'rm -f "$devices_json"' EXIT
xcrun devicectl list devices --json-output "$devices_json" >/dev/null 2>&1 \
  || fail "devicectl could not list devices. Is Xcode installed?"

if [[ -n "$device" ]]; then
  udid="$(jq -r --arg d "$device" '
    .result.devices[] | select(.deviceProperties.name == $d or .identifier == $d)
    | .identifier' "$devices_json" | head -1)"
  [[ -n "$udid" ]] || fail "No paired device named or identified by '$device'."
else
  matches="$(jq -r '
    .result.devices[]
    | select(.connectionProperties.tunnelState != "unavailable")
    | select(.deviceProperties.developerModeStatus == "enabled")
    | "\(.identifier)\t\(.deviceProperties.name)"' "$devices_json")"
  [[ -n "$matches" ]] || fail "No available paired device. Plug in or join the phone to this Wi-Fi, and check Settings → Privacy & Security → Developer Mode."
  if [[ "$(wc -l <<<"$matches")" -gt 1 ]]; then
    fail "More than one device is available — pass --device or set IOS_DEVICE:
$(sed 's/^/    /' <<<"$matches")"
  fi
  udid="$(cut -f1 <<<"$matches")"
fi
device_name="$(jq -r --arg u "$udid" '
  .result.devices[] | select(.identifier == $u) | .deviceProperties.name' "$devices_json")"

# --- generate ----------------------------------------------------------------
if [[ $generate -eq 1 ]]; then
  if [[ ! -d "$PROJECT" || "$IOS_DIR/project.yml" -nt "$PROJECT/project.pbxproj" ]]; then
    step "xcodegen generate"
    command -v xcodegen >/dev/null || fail "xcodegen is required (brew install xcodegen)."
    (cd "$IOS_DIR" && xcodegen generate --quiet)
  fi
fi

# --- build -------------------------------------------------------------------
if [[ $hot -eq 1 ]]; then
  [[ -d /Applications/InjectionNext.app ]] \
    || fail "--hot needs InjectionNext.app in /Applications (see apps/ios/README.md)."
  step "Building with the injection bundle (hot reload)"
else
  step "Building for device (generic destination — your phone can stay locked)"
fi
build_log="$(mktemp -t workerdeck-build)"
trap 'rm -f "$devices_json" "$build_log"' EXIT
if ! xcodebuild \
  -project "$PROJECT" -scheme "$SCHEME" -configuration "$configuration" \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$DERIVED" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$team" \
  WORKERDECK_HOT_RELOAD="$([[ $hot -eq 1 ]] && echo YES || echo NO)" \
  build >"$build_log" 2>&1
then
  # xcodebuild's failure summary is the last thing worth reading; the rest is noise.
  grep -E "error:|Provisioning|requires a provisioning profile|failed" "$build_log" | tail -20 \
    || tail -30 "$build_log"
  fail "Build failed. Full log: $build_log (not deleted)"
fi
[[ -d "$APP" ]] || fail "Build succeeded but $APP is missing."

# --- install -----------------------------------------------------------------
step "Installing to $device_name"
xcrun devicectl device install app --device "$udid" "$APP" >/dev/null \
  || fail "Install failed. Try again with the phone unlocked."

if [[ $launch -eq 0 ]]; then
  printf '\033[1;32m✓\033[0m Installed on %s (not launched).\n' "$device_name"
  exit 0
fi

# --- launch ------------------------------------------------------------------
# The one step a locked phone refuses. Reported as English rather than as
# FBSOpenApplicationErrorDomain error 7.
step "Launching"
launch_log="$(mktemp -t workerdeck-launch)"
trap 'rm -f "$devices_json" "$build_log" "$launch_log"' EXIT
if xcrun devicectl device process launch \
  --device "$udid" --terminate-existing "$BUNDLE_ID" >"$launch_log" 2>&1
then
  printf '\033[1;32m✓\033[0m Running on %s.\n' "$device_name"
else
  if grep -q "Locked\|error 7" "$launch_log"; then
    printf '\033[1;33m!\033[0m Installed on %s, but it will not launch while the phone is locked.\n' "$device_name"
    printf '  Unlock it and open WorkerDeck, or re-run this script.\n'
    exit 3
  fi
  cat "$launch_log" >&2
  fail "Launch failed."
fi
