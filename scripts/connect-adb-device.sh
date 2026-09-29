#!/usr/bin/env bash

set -euo pipefail

device_serial="${1:-${DEVICE_SERIAL:-}}"
if [ -z "$device_serial" ]; then
  echo "ERROR: DEVICE_SERIAL is not set. Pass the serial as the first argument or set DEVICE_SERIAL."
  exit 1
fi

adb_path="${ADB_PATH:-${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb}"
if [ ! -x "$adb_path" ]; then
  adb_path="$(command -v adb || true)"
fi

if [ -z "$adb_path" ] || [ ! -x "$adb_path" ]; then
  echo "ERROR: adb not found. Set ANDROID_HOME, ANDROID_SDK_ROOT, or ADB_PATH."
  exit 1
fi

auth_timeout_seconds="${ADB_AUTH_TIMEOUT_SECONDS:-120}"
poll_seconds="${ADB_AUTH_POLL_SECONDS:-3}"
deadline=$((SECONDS + auth_timeout_seconds))
authorization_prompt_printed=false

echo "Starting ADB server..."
"$adb_path" start-server

echo "Connecting to $device_serial..."
"$adb_path" connect "$device_serial" || true

while [ "$SECONDS" -lt "$deadline" ]; do
  devices_output="$("$adb_path" devices || true)"
  device_state="$(printf '%s\n' "$devices_output" | awk -v serial="$device_serial" '$1 == serial { print $2; exit }')"

  if [ "$device_state" = "device" ]; then
    echo "ADB device authorized: $device_serial"
    "$adb_path" -s "$device_serial" get-state | grep -qx device
    echo "🔔 Waking Android TV and disabling sleep/screensaver before launch..."
    "$adb_path" -s "$device_serial" shell 'svc power stayon true; settings put global stay_on_while_plugged_in 3; settings put system screen_off_timeout 2147483647; input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard 2>/dev/null || true' || true
    "$adb_path" devices
    exit 0
  fi

  if [ "$device_state" = "unauthorized" ] || printf '%s\n' "$devices_output" | grep -q "${device_serial}[[:space:]]*unauthorized"; then
    if [ "$authorization_prompt_printed" = false ]; then
      echo "ADB device is unauthorized: $device_serial"
      echo "On the TV popup, tick 'Always allow from this computer', then click 'Allow'."
      echo "Waiting up to ${auth_timeout_seconds}s for authorization..."
      authorization_prompt_printed=true
    fi
  else
    echo "Waiting for ADB device $device_serial to become available. Current state: ${device_state:-not listed}"
    "$adb_path" connect "$device_serial" || true
  fi

  sleep "$poll_seconds"
done

echo "ERROR: ADB device $device_serial was not authorized within ${auth_timeout_seconds}s."
echo "Please reconnect the TV, tick 'Always allow from this computer', click 'Allow', then rerun."
"$adb_path" devices || true
exit 1