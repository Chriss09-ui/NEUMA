#!/bin/sh
set -eu
project_helper_root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
case "$(uname -m)" in
  x86_64) project_helper_arch=x64 ;;
  aarch64) project_helper_arch=arm64 ;;
  *) echo 'Unsupported Linux architecture' >&2; exit 1 ;;
esac
project_helper_output="$project_helper_root/bin/linux-$project_helper_arch"
mkdir -p "$project_helper_output"
# Build-only development headers; end users use Ubuntu Desktop's system GLib/GIO.
cc -O2 -Wall -Wextra -Werror "$project_helper_root/linux-portal.c" -o "$project_helper_output/neuma-projects" $(pkg-config --cflags --libs gio-2.0)
