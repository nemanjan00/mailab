# mailab OS

A CachyOS image that turns a whole PC into a mailab host: every dependency
installed, the lab server running as a service, and the web UI as the
desktop (fullscreen Chromium kiosk, no DE). AIs connect over MCP from the
network.

## Build

```sh
git commit ...          # the app is `git archive HEAD`; uncommitted work is left out
os/build.sh             # -> os/out/mailab-YYYY.MM.DD-x86_64.iso, os/out/repo/
```

Everything runs in a `cachyos/cachyos` container (needs Docker with
`--privileged` for mkarchiso). Options: `--ref <git ref>`, `--packages-only`
(just the pacman repo), `--with-optional` (also glasgow and J-Link from the
AUR, see `packages/aur-optional.txt`).

What it does:

1. AUR packages in `packages/aur.txt` (the SLogic libsigrok fork, its
   libsigrokdecode, minipro, uhubctl) are built into a local `[mailab]` repo.
2. `pkg/mailab/PKGBUILD` builds two packages into the same repo:
   - **mailab**: the app with production `node_modules` and the built UI in
     `/opt/mailab`, `mailab.service` (user `mailab`, `DATA_DIR=/var/lib/mailab`),
     first-boot token generation, `mailab-token`, udev rules for USB gear.
     Its `depends=` is the runtime dependency list (node, python + numpy /
     scipy / opencv, liquid-dsp, SoapySDR + HackRF / bladeRF / RTL-SDR,
     sigrok, flashrom, openocd, proxmark3, ffmpeg, poppler, imagemagick, ...).
   - **mailab-kiosk**: greetd → cage → Chromium fullscreen on the lab, logged
     in with the kiosk token; mic and camera allowed for the capture pane.
3. `scripts/make-profile.sh` derives the ISO profile from archiso's releng:
   CachyOS repos (generic x86_64, runs on any CPU), `linux-cachyos`, the
   packages above, and boots into the kiosk.

## Use the ISO

Boot it (UEFI or BIOS). tty1 is the lab UI; **Ctrl+Alt+F2** is a root
console (login `root`, no password) with:

- `mailab-install`: install to a disk. Interactive by default; unattended:
  `mailab-install --disk /dev/nvme0n1 --yes --password ... --timezone Europe/Belgrade`.
  Wipes the disk (GPT, 1 GiB ESP, ext4), pacstraps from the CachyOS / Arch
  mirrors (network needed) plus the ISO's `[mailab]` repo, systemd-boot.
  UEFI only. `--help` lists `--user`, `--ssh-key`, `--listen local`,
  `--no-kiosk`.
- `mailab-token`: the MCP command for the AI token and a login link for the
  human one.

The live session works as a lab too (data lives in RAM; the overlay gets
half of it so the python venv fits).

## Turn an existing CachyOS install into one

```sh
os/provision.sh                      # AUR deps via paru/yay, builds mailab here
os/provision.sh --repo os/out/repo   # or install what build.sh made
os/provision.sh --kiosk              # also replace the desktop with the kiosk (asks first)
```

## On the installed system

- `mailab.service` listens on `0.0.0.0:3000` (`--listen local`: loopback).
  On first boot `mailab-setup` writes `/etc/mailab/mailab.env` with two
  tokens: `kiosk` (human: approves risky AI commands from the screen) and
  `claude` (rw). Delete the file and reboot to rotate them.
- `sudo mailab-token` prints
  `claude mcp add --transport http mailab http://<ip>:3000/mcp --header "Authorization: Bearer ..."`.
- Your own settings (`MAILAB_RF_REGION`, `MOUSER_API_KEY`, `MDP_HOST_PATH`,
  ...) go in `/etc/mailab/local.env`; kiosk URL / Chromium flags in
  `/etc/mailab/kiosk.conf`.
- `<hostname>.local` resolves over mDNS (avahi).
- The `mailab` user is in `uucp`, `video`, `audio` and `plugdev`; the udev
  rules give `plugdev` every USB device, hidraw and hub port power. Fine for a
  dedicated instrument box, too broad for a shared desktop.
- Not included: vendor SDKs (Harogic), the mdp-p906 / ci-v checkouts
  (clone them and point `MDP_HOST_PATH` / `CIV_PATH` at them in `local.env`).
  Python driver packages install into `/var/lib/mailab/python` on first use,
  which needs network.
