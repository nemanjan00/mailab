# Testing

Feature-by-feature test status and the testing TODO. Legend:

- **[x]** fake/unit tests exist and run in CI (count in parens)
- **live** verified on real hardware — details in [HW.md](HW.md)
- **UI** exercised in a real browser (headless Chrome/CDP or by hand)
- **TODO** what still needs testing

CI runs 109 suites / 721 tests on every push (husky). A green suite proves
protocol logic, validation and safety gating against fakes — never the
physical device. How to run the suite and the fake-injection seams:
`npx jest [path]`, `options._open` / `dev._onData` seams, `MAILAB_*_FAKE=1`
python bridges, socat PTY pairs, `options.exe` stubs. The repeatable
real-hardware verification procedure is the checklist at the bottom.

## ✅ Verified on real hardware (the short list)

Everything below was driven against the physical instrument and the result
confirmed on the device itself (display, measurement, or RF). Details per
instrument; quirks live here because future-you will need them.

### Rigol MHO98 scope (bench, 10.69.1.89) — `mho900` + `rigol`
- Full settings model synced from the unit: ch1-4 (scale/offset/probe/
  coupling/impedance/on), timebase, trigger, acquire, AWG1+AWG2; set
  round-trips read back over the wire.
- AWG loopback: 1 MHz / 1 Vpp set on G1 → **1.000 MHz / 1.05 Vpp measured
  on CH1** (1:1 probe corrected mid-session).
- Watch: trace + screen image pushed to the UI on every triggered
  acquisition, surviving restarts (`watchOnStart`).
- UI verified by pixel probes: wheel zoom both axes around the cursor;
  ctrl-wheel stepped the real timebase (1e-4 → 5e-5 s/div, 1-2-5 ladder);
  shift-wheel stepped real V/div (0.5 → 0.2); trigger flags dragged to the
  0 V gridline commit ~0.0005 V; V/div window (±4 divs) follows the scope.
- Live video pane: H.264 screen + touch injection (tap visibly selected a
  measurement row).

### Rigol DM858 DMM (lab, 10.69.2.52) — `dm858` + `rigol`
- 4-layer settings model live: function switches via the pane read back from
  the unit (DCI/DCV/freq/diode/cap), NPLC/range/auto set + confirm,
  per-function sync — including the quirk found from live timeouts:
  freq/period NULL lives at SENSe:<f>:NULL, NOT under the VOLTage subnode.
- Monitor readings with units over the serialized chain; screenshots over
  BOTH transports.
- **The key finding**: a raw TCP SCPI session (5025) locks the front panel
  ("remote mode"); the WebSocket channel (9004) speaks identical SCPI
  WITHOUT locking. The driver now runs entirely over 9004 — panel stays
  live; 34 readings / 20 s stable; single-seat + idle-timeout + self-heal
  mapped.
- Live video pane with touch injection (tap visibly hit the AUTO key).

### Othernet Morfeus (bench, USB) — `morfeus`
- Transport = plain /dev/hidraw: discovered `10c4:eac9 "EFM8UB1 Bootloader"`
  IS the app mode (LCD alive), not a stuck bootloader.
- Freq set 433.9 MHz → **LCD confirmed** (was 1234567890); readback exact
  incl. MAX2871's 433900001 Hz rounding; mode mixer↔generator both ways on
  command; mixer current swept 0→7 live; bias on/off.
- Frequency override = **undocumented param 0x87**, found by scanning
  0x80–0x90, confirmed on the LCD ("Yep, you set freq override to on").
- Reply framing: echoes cmd+param; stale-reply retry added from live
  observations; LCD page-jumps to the last-touched param (info reads freq
  last so it stays on page 1).

### ISDT MP305B PSU (lab host, USB-HID) — `mp305`
- Bridge (pinned pymp305 0.6.3) installs + starts on the lab host;
  full telemetry: v/i/p/set_v/set_i/on/mode/temp channels, identity,
  limits enforced. TODO next: output-on under load, PD, charge, programs.

### nRF52840 ESB bridge (lab host, Feather) — `esb`
- The mdp-p906 bridge firmware runs on a real Feather: binary-mode entry,
  config query (ch/addr/ack), all driver commands answered per protocol.

### SCPI-over-WebSocket service — `scpiws`
- Live against the DM858's 9004: greeting, hex frames, binary-safe
  screenshots, serialized queries, reconnect-after-drop.

### Also verified
- `rigol` pane/driver on BOTH instruments (above); `vnc` against QEMU's RFB server with None AND VNC-password auth (screenshot through the des auth path);
  sysmon/capture/usb on this PC; flashrom/minipro against dummy targets;
  mp305/morfeus/chipwhisperer bridges against in-file simulations.

## Instruments (drivers) — full matrix

| Driver | Fake tests | Live | TODO |
|---|---|---|---|
| sim | x (core) | x | — |
| serial / uart | x (3) | this PC's adapters | — |
| process / python bridges | x (lab core) | x (mp305, morfeus, chipwhisperer e2e w/ fakes) | — |
| scpi (generic) | x (2) | via dm858/mho900 presets | — |
| scpiws (SCPI over WS 9004) | x (5) | ✅ **see top** | — |
| dm858 (DM858E DMM) | x (6) | ✅ **see top** | x (UI) | on-screen per-function range/NULL sweep (ohm2w/ohm4w/temp/diode/cont), NPLC per function, calculate on hardware |
| mho900 (MHO98 scope) | x (17) | ✅ **see top** | x (UI) | XY/ROLL timebase, ch3/4 capture, AWG2 output, mask testing |
| mp305 (ISDT PSU) | x (4 + e2e) | ✅ **see top** (telemetry) | panes created | output-on under load, CV/CC, PD profiles/select/output, charge config + a real charge, program write/run/stop, energy reset, remote hold, BLE |
| mdp (MDP-P906) | x (10) | fake bridge | full UI pane, radio reconnection |
| morfeus (RF siggen) | x (2 + e2e) | ✅ **see top** | x (settings pane) | sweep on hardware, LCD backlight 0x85, 5-6 GHz band |
| esb (nRF52840) | x (11) | ✅ **see top** (bridge firmware) | — | RX/ACK on-air with a second node |
| rigol (Web Control screen+input) | x (7) | ✅ **see top** (both instruments) | — | swipe gestures, back/home keys per device |
| kc9531b (power meter) | x | fake | everything on hardware |
| kc901 (DeepAce analyzer) | x (6) | no device | everything on hardware |
| tinysa / litevna / nanovna | x (4 + litevna) | no device | sweeps, markers, calibration on hardware |
| hackrf / soapy / rtl_power | x (6) | rtl sticks partially | TX gating live, bladeRF, more SDRs |
| rfcat | x (12) | no device | TX/RX, specan, RSSI on hardware |
| civ (Icom) | fake | no device | everything on hardware |
| openocd | x (10) | x (flashing targets on the bench) | more targets |
| bmp / jlink | x (6 each) | no device | everything on hardware |
| jtagulator | x (4) | no device | IDCODE scan, UART discovery on hardware |
| buspirate | x (6) | no device | BBIO/I2C/SPI modes, ADC, PWM on hardware |
| glasgow | x (5) | no device | applet runs on hardware |
| catsniffer | x (3) | no device | flash (cc2538-bsl), sniffle bridge, pcap path on hardware |
| thunderscope | x (3) | no device | waveform capture on hardware |
| chipwhisperer | x (2 + e2e) | no device | capture on a Husky, glitching |
| infray (P2 Pro thermal) | x (3) | no device | vendor controls via UVC on hardware |
| proxmark3/5 | x | partially — a Proxmark3 (iceman FW) was attached on the bench: client version/device info drivable; card operations not run (no card) | lf/hf card ops, clone, sniff |
| picoglitcher | x | no device | glitch campaigns |
| cynthion | x (9) | no device | facedancer emulation, gateware flash |
| nanokvm | x (16) | no device | live KVM session, ATX, ISO mount |
| vnc | x (7) | x (QEMU's real RFB server: None auth AND VNC password auth — the des path — screenshot verified through both) | — |
| sigrok | x (1) | no device | SLogic capture on hardware |
| camera / browser / capture | x | x (this PC + headless Chrome) | — |
| harogic | fake | no device | everything on hardware |
| replay | x | recordings only | — |
| sysmon | x (7) | x (this PC) | — |
| flashrom | x (8, dummy) | no device | real chip r/w |
| minipro | x (6, emulated) | no device | real chip r/w |
| shell | x (9) | x (local shells) | — |
| flowgraph | x (6 + ofdm/dsp suites) | x (beacon-to-iq demo) | long-run stability of live flowgraphs |

## Services

| Service | Fake tests | Live | TODO |
|---|---|---|---|
| scpi / scpiws / deepace | x | scpiws live | deepace on a KC901 |
| rfb (VNC client) | x (9) | QEMU | VNC-auth server |
| fccid / datasheets / http / pdf / media | x | x (real fetches) | — |
| pyenv (managed venv) | x (9) | x (first-use installs) | — |
| usb / udev | x (3) | x (this PC) | — |

## UI (panes)

No unit tests for browser code by design; pure helpers in src/utils are
tested. Each pane needs a manual/CDP pass per change:

| Pane | Status | TODO |
|---|---|---|
| chart / value / trace / waterfall | exercised daily on the bench dashboard | wheel-zoom + trigger-drag regression pass per release |
| settings (schema editor) | x (dm858, mho900, morfeus live) | per-driver schema validation |
| rigol (instrument screen) | x (both instruments live) | — |
| image (auto-refresh) | x | — |
| log / devices / activity / channels | exercised daily | — |
| hex / blob / kaitai / board / graph / netgraph | fake fixtures | — |
| flowgraph / audio / capture / chat / vision / kvm / vnc | partially | CDP pass each |
| auth modal / tabs / header | x (nav, logout, copy) | — |

## Core systems

| System | Fake tests | TODO |
|---|---|---|
| safety policy + approvals | x (13) | — |
| txpolicy / rfbands / bypass | x (12 / 5) | — |
| auth (tokens, ro/rw) | x (9) | — |
| MCP tools / sessions | x (2) | live MCP client matrix (pi, claude) |
| lab state / channels / profiles / recordings / batch / sweep / trends / journal / math / classify / blobs(+edit) / board / netgraph / kaitai / vision | x | — |
| web (REST + WS push) | x (30) | — |

## Today's no-hardware session (2026-11-19)

Full-suite stability: `npx jest` **3× consecutive, 109 suites / 721 tests
green every run** — zero flakes. Known cosmetic: the jest force-exit
warning ("worker failed to exit gracefully") comes from suites holding
kernel PTY/socket handles and unref'd reconnect timers (socat pairs in
esb/buspirate/nanovna tests); no failures observed across the 3 runs.

Live on a scratch server (`PORT=3962 DATA_DIR=/tmp/mailab-mho900`, no
hardware at all — synthetic sources only):

- **sigrok demo device**: `capture` → trace `demo_demo`; `capture_blob` →
  `demo_logic` 4096 bytes @100 kHz. (`decode` is BLOCKED by a distro bug:
  this sigrok-cli 0.7.2 crashes with a g_variant assertion on ANY `-P`
  option; the driver appends guidance to that error.)
- **camera via lavfi** (`infray`, `input: "testsrc=size=320x240:rate=5"`)
  streamed frames; **vision ran real OpenCV** on them (gray + Otsu
  threshold, threshold=126, white_fraction 0.51, 1.4 ms, annotated
  output image).
- **flowgraph**: the `video_decode` example graph (signal → python PAL
  synth → video_decode) ran live — decoded frames to image `fg1_vid` +
  channel `fg1_vid_frames`.
- **replay**: recorded `sys_*` for 2 s, played back 1476 records at 50×
  through the API.
- **shell**: pty session ran (`echo hi-$((1+2))` expanded in the pty).
- **QEMU VNC**: fresh QEMU on :5977 (None auth) — `vnc` device connected
  (`QEMU 640x480`), `screenshot` → `vncq_screen` PNG.
- **usb tree**: `/api/usb` lists controllers + buses.
- **DSP suites** (python, all green): test_ofdm, test_modem (BLE),
  test_jitter, test_sync, test_decode (usb sigrok stack), test_eight_ten,
  test_audio_dsp.
- **UI sweep (CDP)**: all **35 pane types** rendered one-by-one on the
  populated server — one screenshot each, **zero uncaught
  exceptions/console errors**.

Trap for future testing: the `infray` lavfi seam takes the SOURCE string
(`input: "testsrc=…"`), not `input:"lavfi"` + `device:…` — a bad config
surfaces as ffmpeg "Filter not found". And on a server started with
`MAILAB_MANAGE_PYTHON=0` the vision venv never gets created (cv2 missing);
let the server manage python (default) for vision tests.

### Live-test session 2 — REST + MCP + UI end-to-end

Scratch lab (`PORT=3962 DATA_DIR=/tmp/mailab-live`): sigrok demo, shell,
sysmon, lavfi camera, replay loop, flowgraph `video_decode`, QEMU VNC.

- **Device layer, via REST and a raw Streamable-HTTP MCP session**:
  sigrok capture → trace + `capture_blob` → logic blob; shell pty; sysmon
  snapshot; camera frame; VNC screenshot; replay loop; flowgraph graph
  query. MCP note: tool names use **underscores** (`device_command`, not
  `device.command`); ~100 tools listed; blob ops via MCP too.
- **Analysis services**: vision `run` (gray+Otsu, annotated image) and a
  live **vision watch** on the camera stream; blob peek/diff (1 changed
  byte at 64)/checksum/slice/poke+undo/search; kaitai parse; board
  create; trends (patterns → min/max/mean); batch loop, sweep table and
  hill-climb optimize — all through the MCP tools.
- **Auth & safety** (second server with `MAILAB_TOKENS`): ro token gets
  reads but 403 on writes and "viewer is read-only" on MCP gating; rw
  `cyn.emulate` parked in **pending approval** until a human-role token
  approved it via `POST /api/approvals/:id`, then proceeded; `tx kill`
  same pattern.
- **UI**: 35/35 pane types on the populated lab, screenshots + an
  all-panes-mounted error pass with **0 exceptions**. Interactive:
  **VNC input** — `key F12` on the QEMU guest changed the framebuffer
  (12388→12400 bytes); **terminal typing** — trusted `keyDown` events
  (with `text`) through the xterm helper textarea landed in the shell
  PTY scrollback. CDP traps: unique `--user-data-dir` per headless
  chrome; `rawKeyDown`+`char` does NOT reach xterm, `keyDown`+`text`
  does.
- **Network services**: `/api/fccid/<id>` live (fccid.io matches with
  applicants/dates); `/api/datasheets/search?q=LM317` manufacturer URL
  probes verified TI + onsemi PDFs.
- **Fixes from this session**: vision watches never started outside
  tests (`vision.start()` now armed lazily on first watch; commit
  d466ebe).

Session traps worth keeping: vision watches need a **continuously
streaming** image source (`infray stream {on: true, name: "frame"}`) —
a snapshot-only camera leaves watches at 0 frames. Terminal panes pin to
a **running** shell session — `session_start {cmd: "bash"}` first, and
read scrollback via `?session=<name>`. QEMU for VNC tests must run
**without `-S`** (frozen at reset: static screen, input invisible).

## Tomorrow's hardware session — ordered checklist

Devices expected on the bench/lab, in run order, each with what to prove
and the quirks to watch. Scratch server per device; flip HW.md/SPEC rows
as each passes.

1. **MHO98 scope (10.69.1.89:5555)** — `mho900`: XY + ROLL timebase set +
   readback; CH2/3/4 on + watch push; AWG2 independent output; mask
   testing. Quirks: one TCP SCPI session, NO interleaved queries (the
   driver serializes); unknown headers TIME OUT (10 s) instead of erroring.
2. **DM858 DMM (10.69.2.52)** — `dm858`: function sweep DCI/ACI/ohm2w/
   ohm4w/cap/diode/cont/temp with the settings pane per mode; NPLC per
   function. Quirks: use the **9004 WebSocket** transport (5025 locks the
   front panel); freq/period NULL lives at SENSe:<f>:NULL not under
   VOLTage; SENSe nodes exist only for the ACTIVE function.
3. **MP305B PSU (lab host, USB-HID)** — `mp305`: output on **under load**
   (CV/CC transition), PD profile edit + select + output, a real battery
   charge, program write/run/stop, energy reset. Quirks: pymp305 0.6.3
   bridge installs into the managed venv on first use; limits enforced
   client-side — check a limit rejection live.
4. **Morfeus (bench, USB hidraw)** — `morfeus`: sweep over RF (watch on a
   receiver), LCD backlight (param 0x85), 5–6 GHz band. Quirks: the
   10c4:eac9 "EFM8UB1 Bootloader" id IS app mode; freq override =
   undocumented param 0x87; replies echo cmd+param (retry on stale).
5. **Feather nRF52840 ESB (lab host, /dev/ttyACM0)** — `esb`: firmware
   confirmed; next is two-node on-air: second node ACK/reply path, listen
   window counts, stats. Quirks: BBIO entry by 0x00 spam until "BBIO1";
   keep writes short (line protocol).
6. **Proxmark3 (bench, iceman FW)** — `proxmark3`: lf/hf card ops with a
   real card, clone, sniff. Quirks: PM3_CLIENT env or ~/pm5-og build; LF
   antenna tune before HF ops.
7. **KC901K / KC908V analyzer** — `kc901` (DeepAce framing): sweeps →
   spectrum traces, config echo. Quirks: framing 0xFE/0xFF + sum
   checksum; command table is best-effort — verify against the unit's
   reply before trusting writes.
8. **NanoVNA / tinySA** — `nanovna`/`tinysa`: sweeps, markers, save/load
   calibration. Quirks: NanoVNA shell protocol is `command` + `ch>`
   prompt; capture needs `capture` then raw bytes (driver handles);
   tinySA ultra variants have extra commands.
9. **Bus Pirate (if BPIO2 present)** — `buspirate`: I2C/SPI/UART sub-mode
   entry banners, ADC/freq channels, bulk echo, PWM. Quirks: binary
   entry needs the terminal menu in HiZ; "BBIO1" is 5 bytes; bulk max
   128 bytes/transfer.
10. **InfiRay P2 Pro** — `infray`: real UVC frames + vendor radiometric
    controls via v4l2. Quirks: check `/dev/video*` enumeration on the lab
    host first; **start `stream {on: true}` before expecting anything from
    vision watches**; server needs the managed python venv for vision
    (don't use MAILAB_MANAGE_PYTHON=0).
11. **Sigrok SLogic / Glasgow / CatSniffer / ThunderScope / ChipWhisperer
    Husky** if they appear: each driver is fake-tested; run its `SPEC.md`
    row. Quirks: sigrok-cli decode crash (see above) — capture path only
    until sigrok-cli is fixed; Glasgow/CatSniffer/ThunderScope/Husky are
    entirely untested on hardware.

## Testing TODO (in priority order)

- [ ] **mp305 feature sweep on the lab unit**: charge config + charging on/off, PD profile edit + PDO select + PD output, program write/run/stop, energy reset, remote hold — commands exist, none hardware-run
- [ ] **rigol**: swipe a slider on the scope's real touch UI; back/home keys; MHO98 input while its own control.html is open (seat arbitration)
- [ ] **dm858**: function sweep (DCI/ACI/ohm2w/ohm4w/cap/diode/cont/temp) — sync model per function incl. NULL nodes; UI screenshot per mode
- [ ] **mho900**: XY + ROLL timebase modes, CH2/3/4 capture in watch, AWG2 (independent second source), mask testing
- [ ] **morfeus**: sweep on hardware (watch the RF), LCD backlight (0x85) confirm
- [ ] **esb**: two-node on-air test (Feather ↔ another ESB node), ACK/reply path
- [ ] **Every 🟡/[HW] row in SPEC.md**: run the hardware checklist below, flip to ✅
- [ ] **Browser panes**: CDP regression pass (console errors, one screenshot per pane type) before each release
- [ ] **MCP live matrix**: connect pi + claude-desktop to a token-enabled instance, exercise read/write gating
- [ ] **mp305 BLE transport**: never run anywhere — needs a BLE-capable host

## Real-hardware verification checklist

What "live-verified" means in HW.md/SPEC.md. Run against a scratch server
(`PORT=3962 DATA_DIR=/tmp/mailab-test MAILAB_MANAGE_PYTHON=0 node src/index.js`):

- [ ] Enumerate the device (lsusb / IP scan); note surprises (Morfeus' app
      mode looks like an EFM8 bootloader; the DM858's 5025 locks the panel
      but 9004 doesn't)
- [ ] Add the driver with stable identity (`match` or host); state `running`
- [ ] `idn`/`info` matches the label
- [ ] Telemetry lands in channels with units
- [ ] Control round-trip: set → readback → **confirmed on the instrument's
      own display** (readbacks have lied; the LCD hasn't)
- [ ] Safety: gated actions create approval requests; ro tokens can't approve
- [ ] UI: panes render, hard-refresh, clean browser console
- [ ] Edges: replug mid-session, power-cycle, command flood, two clients on
      a single-seat channel
- [ ] Document: flip the HW.md/SPEC rows, note quirks for future-you

## Live-test session 3 (2026-11-19, lab host hardware)

Real devices on the lab host's mailab (10.69.1.91:3000, tmux "mailab"):
- **HackRF One** (`hackrf` driver, USB 1d50:6089): `hackrf_sweep` 88–108 MHz
  live → `hackrf_spectrum` trace + `hackrf_peak_freq`/`hackrf_peak_db`
  channels (107.5 MHz, −44.9 dB).
- **tinySA Ultra** (`tinysa` driver, /dev/serial/by-id/usb-tinysa.org_tinySA4):
  `sweep 100–300 MHz` → 201 pts, peak +2.3 dBm; note the continuous loop is
  on by default and re-sweeps the configured range, overwriting one-shot
  sweep traces.
- Panes added for both: spectrum trace + peak value each.
- Also live earlier this session on the same host: DM858 (settings model +
  readings), nRF52840 ESB bridge (config query), MP305 PSU, lavfi camera.

Docs: SPEC rows tinySA/HackRF marked ✅ live-verified; README env table
reworded (mdp-host/icom-ci-v are npm-first; MDP_HOST_PATH/CIV_PATH override).

## Live-test session 4 (2026-11-19, lab host HackRF One + tinySA Ultra)

HackRF (hackrf driver, libhackrf 2026.01.3, PortaPack in HackRF USB mode):
- hackrf_sweep RX: 88–108 MHz @ 100 kHz bins — stable stitched 204-pt
  rows (pass-wrap = repeated band; hackrf_sweep rotates pass starts),
  waterfall rows, live status, binWidthKhz aliases (20k–5M clamp)
- TX IQ: CF32 tone at 2450 MHz via hackrf_transfer -R — full approval gate
  (pending → human approve → TX → 6 s auto-stop cap)
- RX IQ: record {freqHz: 2437M, seconds: 2, rate: 2M} → 3.8M cs8 samples,
  blob hackrf_rx_test
- sweep/TX/RX radio arbitration: each grabs the radio from the others and
  hands it back (wantSweep relaunch); SIGKILL escalation on -R (ignores
  SIGTERM) — bugs found live, fixed e479251 + follow-ups
Soapy bridge (soapy driver → python/soapy_bridge.py, HackRF via libHackRFSupport):
- tune/capture/demod(FM) all live at 107.5 MHz: 2048-pt FFT stream,
  2M-sample cf32 capture, 3 s FM demod → WAV + audio/audio_spectrum traces
- fixed live: tune-on-active-stream wedged HackRF flow (readStream -4),
  killing the tick thread silently — now stream lock + deactivate/activate
  around retune + tick survives errors
tinySA Ultra: NF measured RBW-dependent (850k: −49.8 floor; 10k: −63.2 —
tracks 10log(RBW)); rbw command + RBW-scaled timeouts (3170d62).
