#!/usr/bin/env bash
# Build and flash the glove firmware.
#   ./flash.sh v4 [glove-id] [port]   Grove LCD v4: readable text, green-only backlight (default id 1)
#   ./flash.sh v2 [glove-id] [port]   Grove LCD v2: backlight colors, unreadable text   (default id 2)
#   ./flash.sh v4 1 compile           build only
# The port is auto-detected when omitted. Needs arduino-cli and the "Grove - LCD RGB Backlight" library.
set -euo pipefail
variant="${1:-}"
case "$variant" in
  v4) lcd=4; default_id=1 ;;
  v2) lcd=2; default_id=2 ;;
  *) echo "usage: $0 v4|v2 [glove-id] [port|compile]" >&2; exit 2 ;;
esac
id="${2:-$default_id}"
port="${3:-}"
fqbn="arduino:renesas_uno:unor4wifi"
dir="$(cd "$(dirname "$0")" && pwd)/enchanted_glove"
flags="-DGLOVE_ID=$id -DLCD_VARIANT=$lcd"
echo "Building glove $id with LCD v$lcd"
build="${TMPDIR:-/tmp}/glove-build-$variant"
arduino-cli compile --fqbn "$fqbn" --build-property "build.extra_flags=$flags" --build-path "$build" "$dir"
if [ "$port" = "compile" ]; then exit 0; fi
if [ -z "$port" ]; then
  port="$(arduino-cli board list | awk '/unor4wifi/ {print $1; exit}')"
fi
[ -n "$port" ] || { echo "No Uno R4 WiFi found. Plug it in or pass the port." >&2; exit 1; }
echo "Flashing $port"
arduino-cli upload -p "$port" --fqbn "$fqbn" --input-dir "$build" "$dir"
