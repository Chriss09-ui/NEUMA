#!/bin/sh
set -eu
TASK_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
case "$(uname -m)" in
  x86_64) TASK_ARCH=x64 ;;
  aarch64|arm64) TASK_ARCH=arm64 ;;
  *) echo 'Only x64 and ARM64 are supported.' >&2; exit 1 ;;
esac
TASK_OUTPUT="$TASK_ROOT/native/isolation/bin/linux-$TASK_ARCH"
mkdir -p "$TASK_OUTPUT"
"${CC:-cc}" -O2 -Wall -Wextra -Werror -std=c11 -static "$TASK_ROOT/native/isolation/linux.c" -o "$TASK_OUTPUT/neuma-isolation"
chmod 755 "$TASK_OUTPUT/neuma-isolation"
