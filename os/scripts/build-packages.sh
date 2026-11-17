#!/bin/bash
# Build AUR deps and the mailab packages into a local pacman repo.
#   build-packages.sh <repo dir> <work dir>
# Runs as an unprivileged user with passwordless sudo (makepkg -s).
set -euo pipefail

os=$(cd "$(dirname "$0")/.." && pwd)
repo=$1
work=$2
failed=()

list() {
	grep -v -e '^#' -e '^$' "$@" || true
}

mkdir -p "$repo" "$work"

aur=$(list "$os/packages/aur.txt")
if [ "${WITH_OPTIONAL:-0}" = 1 ]; then
	aur="$aur $(list "$os/packages/aur-optional.txt")"
fi

for pkg in $aur; do
	dir="$work/$pkg"
	rm -rf "$dir"
	if ! git clone --depth 1 "https://aur.archlinux.org/$pkg.git" "$dir"; then
		failed+=("$pkg")
		continue
	fi
	# one failure shouldn't stop the batch (same as the shack playbook)
	if (cd "$dir" && makepkg -s -c --noconfirm --needed --skippgpcheck); then
		cp "$dir"/*.pkg.tar.zst "$repo/"
		# later AUR packages may depend on this one
		sudo pacman -U --noconfirm --needed "$dir"/*.pkg.tar.zst
	else
		failed+=("$pkg")
	fi
done

# mailab: -d since its AUR deps (uhubctl, minipro) live in this repo, not a sync db
rm -rf "$work/mailab"
cp -r "$os/pkg/mailab" "$work/mailab"
(cd "$work/mailab" && MAILAB_SRC=/src MAILAB_REF="${MAILAB_REF:-HEAD}" makepkg -d -c --noconfirm)
cp "$work/mailab"/*.pkg.tar.zst "$repo/"

# keep only the newest build of each package
rm -f "$repo"/mailab.db* "$repo"/mailab.files*
(cd "$repo" && ls -t ./*.pkg.tar.zst | while read -r file; do
	name=$(bsdtar -xOf "$file" .PKGINFO | sed -n 's/^pkgname = //p')
	if [ -e ".seen-$name" ]; then
		rm -f "$file"
	else
		touch ".seen-$name"
	fi
done; rm -f .seen-*)
repo-add "$repo/mailab.db.tar.zst" "$repo"/*.pkg.tar.zst

if [ ${#failed[@]} -gt 0 ]; then
	echo "FAILED AUR packages: ${failed[*]}" >&2
	# the ISO needs every package in aur.txt
	for pkg in "${failed[@]}"; do
		if list "$os/packages/aur.txt" | grep -qx "$pkg"; then
			exit 1
		fi
	done
fi
