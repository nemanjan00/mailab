#!/bin/bash
# Turn an existing CachyOS / Arch install into a mailab host: install the
# packages and enable the service. Run as your user (uses sudo).
#
#   os/provision.sh                  AUR deps via paru/yay, build mailab here
#   os/provision.sh --repo os/out/repo   install what os/build.sh built
#   os/provision.sh --kiosk          also replace the desktop with the kiosk
#
# The app is `git archive HEAD` of this checkout (commit first), installed to
# /opt/mailab and run as the mailab user with DATA_DIR=/var/lib/mailab.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=
kiosk=0

while [ $# -gt 0 ]; do
	case "$1" in
		--repo) repo=$(cd "$2" && pwd); shift ;;
		--kiosk) kiosk=1 ;;
		-h | --help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) echo "unknown option: $1" >&2; exit 1 ;;
	esac
	shift
done

[ "$(id -u)" != 0 ] || { echo "run as your user, not root (makepkg)" >&2; exit 1; }

list() {
	grep -v -e '^#' -e '^$' "$@" || true
}

wanted=(mailab)
if [ "$kiosk" = 1 ]; then
	wanted+=(mailab-kiosk)
fi

if [ -n "$repo" ]; then
	files=()
	for name in $(list "$here/packages/aur.txt") "${wanted[@]}"; do
		for file in "$repo/$name"-[0-9]*.pkg.tar.zst; do
			[ -e "$file" ] && files+=("$file")
		done
	done
	# interactive on purpose: the libsigrok fork replaces stock libsigrok
	sudo pacman -U --needed "${files[@]}"
else
	helper=$(command -v paru || command -v yay || true)
	[ -n "$helper" ] || { echo "need paru or yay for AUR packages (or --repo)" >&2; exit 1; }
	# shellcheck disable=SC2046
	"$helper" -S --needed $(list "$here/packages/aur.txt")

	build=$(mktemp -d)
	trap 'rm -rf "$build"' EXIT
	cp -r "$here/pkg/mailab/." "$build/"
	(cd "$build" && MAILAB_SRC="$(cd "$here/.." && pwd)" makepkg -d -c --noconfirm)
	files=()
	for name in "${wanted[@]}"; do
		files+=("$build/$name"-[0-9]*.pkg.tar.zst)
	done
	sudo pacman -U --needed "${files[@]}"
fi

sudo systemctl enable --now mailab

if [ "$kiosk" = 1 ]; then
	current=$(readlink /etc/systemd/system/display-manager.service 2> /dev/null || true)
	if [ -n "$current" ] && [ "$(basename "$current")" != greetd.service ]; then
		read -rp "Replace $(basename "$current") with the mailab kiosk at next boot? [y/N] " answer
		[ "$answer" = y ] || { echo "kiosk installed but not enabled"; exit 0; }
	fi
	sudo systemctl enable --force greetd
	sudo systemctl set-default graphical.target
	echo "kiosk enabled; reboot to start it"
fi

echo "connect an AI: sudo mailab-token"
