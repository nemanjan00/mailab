#!/bin/bash
# Runs as root in cachyos/cachyos (see os/build.sh): packages, then the ISO.
set -euo pipefail

os=/src/os
out=/out
work=/build

cleanup() {
	chown -R "${HOST_UID:-0}:${HOST_GID:-0}" "$out" 2> /dev/null || true
}
trap cleanup EXIT

pacman -Syu --noconfirm --needed archiso base-devel git nodejs yarn sudo

# makepkg refuses root; the builder gets passwordless pacman for makepkg -s
id builder > /dev/null 2>&1 || useradd -m builder
echo 'builder ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/builder
# /src belongs to the host user (container-only git setting)
sudo -u builder git config --global --add safe.directory '*'

mkdir -p "$out/repo" "$work"
chown builder: "$out/repo" "$work"
sudo -u builder env MAILAB_REF="$MAILAB_REF" WITH_OPTIONAL="$WITH_OPTIONAL" \
	bash "$os/scripts/build-packages.sh" "$out/repo" "$work/pkg"

if [ "$PACKAGES_ONLY" = 1 ]; then
	exit 0
fi

bash "$os/scripts/make-profile.sh" "$work/profile" "$out/repo"
rm -rf "$work/iso"
mkarchiso -v -r -w "$work/iso" -o "$out" "$work/profile"
