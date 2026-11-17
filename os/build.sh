#!/bin/bash
# Build the mailab CachyOS ISO in a cachyos/cachyos container.
#   os/build.sh [--with-optional] [--ref <git ref>] [--packages-only]
# Output: os/out/repo (local pacman repo) and os/out/mailab-*.iso.
# The app comes from `git archive <ref>` (default HEAD): commit first.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
src=$(cd "$here/.." && pwd)
ref=HEAD
optional=0
packages_only=0

while [ $# -gt 0 ]; do
	case "$1" in
		--with-optional) optional=1 ;;
		--ref) ref=$2; shift ;;
		--packages-only) packages_only=1 ;;
		-h | --help) sed -n '2,5p' "$0"; exit 0 ;;
		*) echo "unknown option: $1" >&2; exit 1 ;;
	esac
	shift
done

mkdir -p "$here/out"

# --privileged: mkarchiso / pacstrap mount proc, sys and dev in the image
exec docker run --rm --privileged \
	-v "$src:/src:ro" \
	-v "$here/out:/out" \
	-v mailab-iso-cache:/var/cache/pacman/pkg \
	-e MAILAB_REF="$ref" \
	-e WITH_OPTIONAL="$optional" \
	-e PACKAGES_ONLY="$packages_only" \
	-e HOST_UID="$(id -u)" \
	-e HOST_GID="$(id -g)" \
	cachyos/cachyos:latest \
	bash /src/os/scripts/build-in-container.sh
