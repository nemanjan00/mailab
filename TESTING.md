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

## Instruments (drivers)

| Driver | Fake tests | Live | TODO |
|---|---|---|---|
| sim | x (core) | x | — |
| serial / uart | x (3) | this PC's adapters | — |
| process / python bridges | x (lab core) | x (mp305, morfeus, chipwhisperer e2e w/ fakes) | — |
| scpi (generic) | x (2) | via dm858/mho900 presets | — |
| scpiws (SCPI over WS 9004) | x (5) | x (DM858 — no panel lock) | — |
| dm858 (DM858E DMM) | x (6) | x (FULL: 4-layer settings model live — function switches via pane read back from the unit (DCI/DCV/freq/diode/cap), NPLC/range/auto set + confirm, per-function sync incl. the SENSe:<f>:NULL vs VOLTage-subnode quirk fixed from live timeouts, monitor readings w/ unit over the chain, screenshots over BOTH 5025 (blocks the panel) and 9004 (panel stays unlocked — the key finding), 34 readings/20 s stable over 9004, settings pane editor, unit stamping, single-session + remote-lockout behavior mapped) | x (UI) | TODO: on-screen confirm of every function's range/NULL (ohm2w/ohm4w/temp/diode/cont), NPLC per function, calculate (limits/stats) on hardware |
| mho900 (MHO98 scope) | x (17) | x (FULL: settings sync of ch1-4/timebase/trigger/acquire/AWG1+2, set round-trips read back from the unit, AWG loopback 1 MHz/1 Vpp set -> 1.000 MHz/1.05 Vpp measured, watch trace+screen push, ctrl/shift-wheel drove real t/div + V/div, trigger flags dragged w/ pixel probes, V/div window follow, screenshots, live video pane) | x (UI) | TODO: XY/ROLL timebase, ch3/4 capture, AWG2 output on-air, mask testing |
| mp305 (ISDT PSU) | x (4 + e2e) | x (lab unit: telemetry, DC control) | charge config/run, PD profiles/select, programs, BLE — never on hardware |
| mdp (MDP-P906) | x (10) | fake bridge | full UI pane, radio reconnection |
| morfeus (RF siggen) | x (2 + e2e) | x (freq/mode/current/bias/override + settings pane) | sweep on hardware, LCD backlight (0x85) |
| esb (nRF52840) | x (11) | x (bridge firmware on Feather) | RX/ACK on-air with a second node |
| rigol (Web Control screen+input) | x (7) | x (DM858 + MHO98 video & touch) | swipe gestures on hardware, keys (back/home) meaning per device |
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
| proxmark3/5 | x | partially (client driving) | card operations |
| picoglitcher | x | no device | glitch campaigns |
| cynthion | x (9) | no device | facedancer emulation, gateware flash |
| nanokvm | x (16) | no device | live KVM session, ATX, ISO mount |
| vnc | x (7) | x (QEMU VNC target) | auth variants (VNC password) on hardware |
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
