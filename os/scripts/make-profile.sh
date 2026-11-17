#!/bin/bash
# Turn archiso's releng profile into the mailab live/installer ISO profile.
#   make-profile.sh <profile dir> <local repo dir>
# releng + CachyOS repos + linux-cachyos + mailab, booting into the kiosk.
set -euo pipefail

os=$(cd "$(dirname "$0")/.." && pwd)
profile=$1
repo=$(cd "$2" && pwd)

list() {
	grep -v -e '^#' -e '^$' "$@" || true
}

rm -rf "$profile"
cp -r /usr/share/archiso/configs/releng "$profile"
cd "$profile"

# kernel: linux -> linux-cachyos (package and boot entries; its own preset
# picks up releng's mkinitcpio.conf.d/archiso.conf)
sed -i 's/^linux$/linux-cachyos/' packages.x86_64
list "$os/packages/iso.txt" >> packages.x86_64
sed -i -E 's/(vmlinuz|initramfs)-linux([^-a-z]|$)/\1-linux-cachyos\2/g' \
	efiboot/loader/entries/*.conf syslinux/*.cfg grub/*.cfg
# room in the live overlay for mailab's python venv and captures
sed -i 's/archisobasedir=%INSTALL_DIR%/& cow_spacesize=50%/' \
	efiboot/loader/entries/*.conf syslinux/*.cfg grub/*.cfg
sed -i 's/Arch Linux install medium/mailab (CachyOS) live/' \
	efiboot/loader/entries/*.conf syslinux/*.cfg grub/*.cfg

# repos: CachyOS (generic x86_64, runs on any CPU) and the local mailab repo
pacman_conf() {
	local server=$1
	cat << END
[options]
HoldPkg = pacman glibc
Architecture = auto
ParallelDownloads = 5
SigLevel = Required DatabaseOptional
LocalFileSigLevel = Optional

[mailab]
SigLevel = Optional TrustAll
Server = $server

[cachyos]
Include = /etc/pacman.d/cachyos-mirrorlist

[core]
Include = /etc/pacman.d/mirrorlist

[extra]
Include = /etc/pacman.d/mirrorlist
END
}
pacman_conf "file://$repo" > pacman.conf
mkdir -p airootfs/etc airootfs/opt
pacman_conf "file:///opt/mailab-repo" > airootfs/etc/pacman.conf
# the installer pacstraps mailab and the AUR builds from here
cp -r "$repo" airootfs/opt/mailab-repo

# mailab's own files (installer, motd)
cp -r "$os/iso/airootfs/." airootfs/
mkdir -p airootfs/usr/share/mailab-os
list "$os/packages/target.txt" > airootfs/usr/share/mailab-os/target.txt

# boot to the kiosk: greetd owns tty1 (no root autologin there), the root
# console with the installer is on tty2
rm -rf airootfs/etc/systemd/system/getty@tty1.service.d
ln -sf /usr/lib/systemd/system/graphical.target airootfs/etc/systemd/system/default.target
ln -sf /usr/lib/systemd/system/greetd.service airootfs/etc/systemd/system/display-manager.service
ln -sf /usr/lib/systemd/system/mailab.service airootfs/etc/systemd/system/multi-user.target.wants/mailab.service
ln -sf /usr/lib/systemd/system/avahi-daemon.service airootfs/etc/systemd/system/multi-user.target.wants/avahi-daemon.service

cat >> profiledef.sh << 'END'

# mailab
iso_name="mailab"
iso_label="MAILAB_$(date --date="@${SOURCE_DATE_EPOCH:-$(date +%s)}" +%Y%m)"
iso_publisher="mailab <https://github.com/nemanjan00/mailab>"
iso_application="mailab CachyOS live / installer"
file_permissions+=(
  ["/usr/local/bin/mailab-install"]="0:0:755"
)
END
