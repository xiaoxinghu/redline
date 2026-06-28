#!/usr/bin/env bash
#
# icongen.sh — generate Chrome extension icons from a single source image.
#
# Usage:
#   ./icongen.sh <image> [output-dir]
#
# Examples:
#   ./icongen.sh icon.png
#   ./icongen.sh icon.png icons
#
# Produces icon-16.png, icon-32.png, icon-48.png and icon-128.png — the sizes
# referenced by manifest.json. Uses macOS' built-in `sips`, so no extra tools
# are required.

set -euo pipefail

# Icon sizes required by the Chrome extension manifest.
SIZES=(16 32 48 128)

die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

# --- argument parsing -------------------------------------------------------

if [[ $# -lt 1 || $# -gt 2 ]]; then
  printf 'Usage: %s <image> [output-dir]\n' "$0" >&2
  exit 64
fi

SRC=$1
OUT_DIR=${2:-icons}

[[ -f "$SRC" ]] || die "source image not found: $SRC"
command -v sips >/dev/null 2>&1 || die "'sips' not found (this script targets macOS)"

# --- sanity check the source ------------------------------------------------

# Make sure sips can actually read the file and grab its pixel dimensions.
read -r WIDTH HEIGHT < <(
  sips -g pixelWidth -g pixelHeight "$SRC" 2>/dev/null \
    | awk '/pixelWidth/ {w=$2} /pixelHeight/ {h=$2} END {print w, h}'
) || die "could not read image: $SRC"

[[ -n "${WIDTH:-}" && -n "${HEIGHT:-}" ]] || die "unsupported image file: $SRC"

if [[ "$WIDTH" -ne "$HEIGHT" ]]; then
  printf 'warning: source is %sx%s (not square); icons may look distorted.\n' \
    "$WIDTH" "$HEIGHT" >&2
fi

largest=${SIZES[${#SIZES[@]}-1]}
if [[ "$WIDTH" -lt "$largest" || "$HEIGHT" -lt "$largest" ]]; then
  printf 'warning: source (%sx%s) is smaller than the largest icon (%sx%s); upscaling.\n' \
    "$WIDTH" "$HEIGHT" "$largest" "$largest" >&2
fi

# --- generate ---------------------------------------------------------------

mkdir -p "$OUT_DIR"

printf 'Generating icons from %s (%sx%s) -> %s/\n' "$SRC" "$WIDTH" "$HEIGHT" "$OUT_DIR"

for size in "${SIZES[@]}"; do
  out="$OUT_DIR/icon-${size}.png"
  sips -s format png -z "$size" "$size" "$SRC" --out "$out" >/dev/null
  printf '  ✓ %s (%sx%s)\n' "$out" "$size" "$size"
done

printf 'Done.\n'
