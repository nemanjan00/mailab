# Testing mailab

How the suite works, what each layer is tested with, and the checklist for
verifying a driver on real hardware.

## Running

```sh
yarn test          # full suite (husky also runs it on every push)
npx jest src/devices/dm858    # one area
npx jest -t "siggen"          # by test name
```

Current: **109 suites / 721 tests**, all green on master. Pushes are blocked
until the suite passes (lint-staged runs eslint, then jest).

## What the tests prove — and what they don't

CI has **no instruments attached**. Every test runs against a fake, an
emulator, or this PC's own system, so a green suite proves the driver's
protocol logic, argument validation, error handling and safety gating — it
says nothing about the physical device. What each style covers:

| Style | Where | What it proves | Examples |
|---|---|---|---|
| Fake transport | `src/services/*`, driver `_open`/`_onData` seams | wire protocol encode/decode, serialized sessions, reconnect | `scpiws` (fake WS meter), `deepace` (framing + checksum), mho900 siggen (fake SCPI client) |
| socat PTY pair | serial drivers' `__tests__` | line/binary protocols over a real tty, reconnect, exclusivity | esb (11), buspirate (6), nanovna (4), rigol input (7) |
| Fake python bridge | `MAILAB_*_FAKE=1` swaps the hardware object | the bridge drives its API correctly; strict setpoints | mp305 (4 + e2e), chipwhisperer (2 + e2e), morfeus (2 + e2e) |
| Real tool, dummy target | tool-based drivers | CLI surface, output parsing | flashrom (dummy programmer, 8), minipro (emulated chip) |
| Live, this PC | sysmon, capture, usb tree, headless-Chrome media | the thing under test is the PC itself | sysmon (7), capture (16) |
| UI logic (node) | public/ has no unit tests | panes are verified manually or via CDP scripts; only pure helpers in `src/utils` are unit-tested | qrp views, plots |

The authoritative list of what has been **verified on real lab hardware**
(MHO98 scope, DM858 DMM, MP305B PSU, Othernet Morfeus, nRF52840 ESB bridge,
Proxmark5 lightly) with what exactly was checked is [HW.md](HW.md). SPEC.md
rows carry ✅ live-verified vs 🟡 implemented/[HW] pending.

## Per-area inventory

Approximate static counts (jest's own count is the authoritative one):

- **Drivers (36 suites)**: bmp 6, buspirate 6, camera 1, catsniffer 3,
  chipwhisperer 2, cynthion 9, dm858 6, esb 11, flashrom 8, flowgraph 6,
  glasgow 5, infray 3, jlink 6, jtagulator 4, kc901 6, mdp 10, mho900 17,
  minipro 6, morfeus 2, mp305 4, nanokvm 16, nanovna 4, openocd 10, rfcat 12,
  rigol 7, rtl_power 6, shell 9, sigrok 1, sysmon 7, thunderscope 3, uart 3,
  vnc 7
- **Services (10 suites)**: datasheets 6, deepace 6, fccid 14, http 8,
  media 6, pdf 2, pyenv 9, rfb 9, scpi 2, scpiws 5, usb 3
- **Core (30 suites)**: auth 9, batch 4, blobs 15, board 7, channels 3,
  classify 3, journal 9, kaitai 4, lab 7, math 9, mcp 2, netgraph 4, panes 5,
  profiles 6, recordings 4, safety 13, sweep 7, trends 4, txpolicy 12, vision
  16, web 30 (incl. kvm 6, vnc 8)
- **Pure utils (27 suites)**: affine, args, block-docs (catalog freshness),
  bypass, bytes, bytesearch, checksum, cryptojs, des, hidkeys, html, keypad,
  keysym, lineparse, mutex, netguard, offsetexpr, patch, pcm, placeholders,
  png, table 23, timebase 13, units 7

## Test seams

| Seam | Use |
|---|---|
| `options._open` | replace `scpi.open` with a scripted client (mho900, dm858) |
| `dev._onData` | feed bytes like the port would (nanovna) |
| `MAILAB_MORFEUS_FAKE=1`, `MAILAB_CHIPWHISPERER_FAKE=1`, `MAILAB_MP305_FAKE=1` | swap the hardware object inside python bridges |
| socat PTY pairs | serial protocols without hardware |
| `options.exe` | point CLI drivers at a stub binary (jlink, glasgow, morfeus-tool) |
| `CHROME_TEST_*`, headless Chrome via CDP | UI verification screenshots (see below) |

## Verifying a driver on real hardware

When a device is reachable, run this checklist (what "live-verified" means in
HW.md/SPEC.md). Do it against a **scratch server** so the main lab's state is
untouched:

```sh
PORT=3962 DATA_DIR=/tmp/mailab-test MAILAB_MANAGE_PYTHON=0 node src/index.js
```

- [ ] **Enumerate**: `lsusb` / `ip` scan; identify VID:PID or IP:port. Note
      surprises (e.g. Morfeus enumerates as `10c4:eac9 EFM8UB1 Bootloader`
      even in app mode — that IS its app mode; a DM858 on 5025 locks the
      front panel, its WS channel 9004 does not).
- [ ] **Add**: POST /api/devices `{id, driver, options}` — state `running`,
      no detail error. Device console pane shows the handshake.
- [ ] **Identity**: `idn` / `info` — model, serial, firmware; sanity vs. label.
- [ ] **Telemetry**: readings land in channels with units; plausible values.
- [ ] **Control round-trip**: change a setting via `set`/commands, read it
      back, and confirm **on the instrument's own display** that it changed
      (SCPI readbacks have lied before; the LCD hasn't).
- [ ] **Safety behavior**: gated actions (TX, output on, flash writes) create
      an approval request; read-only tokens can't approve.
- [ ] **UI**: open the dashboard, add the panes (settings / console / value /
      screen), click through; hard-refresh; check the browser console is
      clean (headless Chrome + CDP screenshots work well for this).
- [ ] **Edge behavior**: replug mid-session (reconnect), power the device
      off/on, flood with commands (serialization), two clients fighting a
      single-seat channel.
- [ ] **Document**: mark the row ✅ in HW.md and SPEC.md with what exactly was
      verified; note quirks future-you will need (SCPI dialects, handshakes,
      lockouts, single-seat ports).

## Known-not-covered

- Browser panes (public/) have no unit tests — pure helpers only; UI is
  verified via headless Chrome CDP scripts manually.
- BLE transports (mp305 `transport: "ble"`) never run anywhere.
- Anything marked 🟡/[HW] in SPEC.md is fake-tested only until the checklist
  above is run against the real unit.
