#!/bin/bash

# TV PPV -> Web handoff runner
# Runs the TV Appium PPV flow first, then continues checkout in Playwright
# using the DAZN handoff URL written to mobile_entry_url.txt.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_PACKAGE="${APP_PACKAGE:-com.dazn.beta}"
TV_TARGET="${TV_TARGET:-androidtv}"
SOURCE_RAW="${SOURCE:-schedule}"
PLAYWRIGHT_PROJECT="${PLAYWRIGHT_PROJECT:-chromium}"
WEB_SPEC="${WEB_SPEC:-tests/existing_user/existinguser.ppv.spec.ts}"
TV_PPV_CONFIG="${PPV_CONFIG:-}"
WEB_PPV_CONFIG="${WEB_PPV_CONFIG:-$TV_PPV_CONFIG}"
WEB_USER_STATE="${WEB_USER_STATE:-${USER_STATE:-active_standard_monthly}}"
FAILED_STEP="startup"

generate_failure_report() {
  local exit_code=$?
  if [ "$exit_code" -eq 0 ]; then
    return
  fi

  echo ""
  echo "📊 Generating TV/Web fallback report after failure in: $FAILED_STEP"
  (
    cd "$ROOT_DIR"
    TV_HANDOFF_FAILURE_STEP="$FAILED_STEP" \
    TV_HANDOFF_EXIT_CODE="$exit_code" \
    PPV_CONFIG="${WEB_PPV_CONFIG:-$TV_PPV_CONFIG}" \
    TS_NODE_TRANSPILE_ONLY=true \
    TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","moduleResolution":"node","resolveJsonModule":true,"esModuleInterop":true,"ignoreDeprecations":"5.0"}' \
    node -r ts-node/register/transpile-only scripts/generateTvHandoffFailureReport.ts
  ) || echo "⚠️ Failed to generate fallback TV/Web report."

  exit "$exit_code"
}

trap generate_failure_report EXIT

SOURCE_NORMALIZED="$(printf '%s' "$SOURCE_RAW" | tr '[:upper:]' '[:lower:]' | tr '_' '-')"
case "$SOURCE_NORMALIZED" in
  schdule)
    SOURCE_NORMALIZED="schedule"
    ;;
esac

if [ "$SOURCE_NORMALIZED" != "schedule" ]; then
  echo "❌ TV PPV E2E currently supports SOURCE=schedule only. Received SOURCE=$SOURCE_RAW"
  echo "   home-page-banner is not implemented for the TV PPV handoff runner yet."
  exit 1
fi

if [ -n "$TV_PPV_CONFIG" ] && [ ! -f "$ROOT_DIR/config/events/$TV_PPV_CONFIG" ]; then
  case "$TV_PPV_CONFIG" in
    aj_joshua_prenga.json)
      TV_PPV_CONFIG="ppv_t_joshua_prenga.json"
      ;;
  esac
fi

if [ -n "$WEB_PPV_CONFIG" ] && [ ! -f "$ROOT_DIR/config/events/$WEB_PPV_CONFIG" ]; then
  case "$WEB_PPV_CONFIG" in
    aj_joshua_prenga.json)
      WEB_PPV_CONFIG="ppv_t_joshua_prenga.json"
      ;;
  esac
fi

export APP_PACKAGE
export TV_TARGET
export SOURCE="$SOURCE_NORMALIZED"
export USER_STATE="$WEB_USER_STATE"
export LOGIN_FIRST="${LOGIN_FIRST:-true}"
export HEADLESS="${HEADLESS:-false}"
export TV_HANDOFF_MODE="${TV_HANDOFF_MODE:-true}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"

if [ -z "${DEVICE_SERIAL:-}" ]; then
  if [ "$TV_TARGET" = "firetv" ]; then
    export DEVICE_SERIAL="${FIRETV_SERIAL:-172.26.81.184:5555}"
  elif [ "$TV_TARGET" = "androidtv" ]; then
    export DEVICE_SERIAL="${ANDROIDTV_SERIAL:-172.26.89.94:5555}"
  fi
fi

echo "╔════════════════════════════════════════════════════╗"
echo "║  TV PPV -> Web End-to-End Handoff                 ║"
echo "╚════════════════════════════════════════════════════╝"
echo ""
echo "TV_TARGET          : $TV_TARGET"
echo "APP_PACKAGE        : $APP_PACKAGE"
echo "DAZN_ENV           : ${DAZN_ENV:-not-set}"
echo "DAZN_REGION        : ${DAZN_REGION:-not-set}"
echo "PLAN               : ${PLAN:-not-set}"
echo "TV_PPV_CONFIG      : ${TV_PPV_CONFIG:-default}"
echo "WEB_PPV_CONFIG     : ${WEB_PPV_CONFIG:-default}"
echo "SOURCE             : $SOURCE"
echo "PLAYWRIGHT_PROJECT : $PLAYWRIGHT_PROJECT"
echo "WEB_SPEC           : $WEB_SPEC"
echo "USER_STATE         : $USER_STATE"
echo "LOGIN_FIRST        : $LOGIN_FIRST"
echo "TV_HANDOFF_MODE    : $TV_HANDOFF_MODE"
echo ""

if [ -n "${DEVICE_SERIAL:-}" ]; then
  FAILED_STEP="ADB device authorization"
  echo "🔌 Checking ADB connection and authorization..."
  bash "$ROOT_DIR/scripts/connect-adb-device.sh" "$DEVICE_SERIAL"
  echo ""
fi

FAILED_STEP="reset Android app"
echo "🧹 Step 1: Clearing and force-stopping DAZN app..."
npm --prefix "$ROOT_DIR/appium" run reset:android-app

echo ""
FAILED_STEP="TV PPV Appium flow"
echo "📺 Step 2: Running TV PPV Appium flow..."
(
  cd "$ROOT_DIR/appium"
  if [ -n "$TV_PPV_CONFIG" ]; then
    PPV_CONFIG="$TV_PPV_CONFIG" npx wdio run config/wdio.android.conf.ts --spec ./tests/android/tv.ppv.spec.ts
  else
    npx wdio run config/wdio.android.conf.ts --spec ./tests/android/tv.ppv.spec.ts
  fi
)

echo ""
FAILED_STEP="existing web continuation"
echo "🌐 Step 3: Continuing checkout from TV handoff URL in the existing web script..."
(
  cd "$ROOT_DIR"
  if [ -n "$WEB_PPV_CONFIG" ]; then
    PPV_CONFIG="$WEB_PPV_CONFIG" npx playwright test "$WEB_SPEC" --project="$PLAYWRIGHT_PROJECT"
  else
    npx playwright test "$WEB_SPEC" --project="$PLAYWRIGHT_PROJECT"
  fi
)

echo ""
echo "✅ TV PPV -> Web end-to-end handoff completed."