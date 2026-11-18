# Hardware TODO

Status of every instrument mailab knows about. Verified on real lab hardware: the **Rigol MHO98** scope (bench, 10.69.1.89 — SCPI, deep settings integration, Web Control video + touch), the **Rigol DM858** DMM (lab, 10.69.2.52 — SCPI over its WebSocket channel so the panel never locks, deep settings integration, Web Control video + touch), the **ISDT MP305B** PSU (lab host, USB-HID — telemetry + DC control), and the **Othernet Morfeus** (USB HID — full control incl. the undocumented freq override). The **Proxmark5** only lightly (driving the client, no card operations). Everything else is tested with fakes, emulators, dummy programmers or this PC's own system, which says nothing about the instrument. Drivers marked *protocol from docs* were written from documentation or memory; expect fixes on first contact.
tested with fakes, emulators, dummy programmers or this PC's own system
(sysmon, USB tree, headless-Chrome media, QEMU VNC), which says nothing about
the instrument. Drivers marked *protocol from docs* were written from
documentation or memory; expect fixes on first contact.

Legend: ✅ done · 🧪 implemented, untested on hardware · 📝 planned · ⚠️ known gap

| Instrument | Driver | Transport | Based on | State |
|---|---|---|---|---|
| Simulated signals | `sim` | – | – | ✅ |
| Anything printing lines | `serial` | USB serial (tty) | – | 🧪 |
| Any JSON-lines helper | `process` | stdio | `python/mailab_bridge.py` | ✅ (fake helper) |
| Miniware MDP-P906 PSU | `mdp` | nRF52840 radio bridge | `~/mdp-p906/host` | 🧪 |
| ISDT MP305A/B PSU | `mp305` | USB-HID / BLE | `pymp305` 0.6.3 | ✅ verified on the lab unit (telemetry, DC control); BLE never run |
| Rigol DM858/DM858E DMM | `dm858` | SCPI over the Web Control WS channel (9004; never 5025 — that locks the panel) / usbtmc | programming guide | ✅ deep integration live (settings model, monitor, screenshots) |
| Rigol MHO900 scope | `mho900` | SCPI over LAN / usbtmc | DHO-family SCPI | ✅ on the bench scope |
| Sipeed SLogic / DSLogic | `sigrok` | sigrok-cli | `nemanjan00/libsigrok` (slogic-dev) | 🧪 (demo ✅) |
| DeepAce KC9531B RF power meter | `kc9531b` | USB serial | `kc9531b` (npm) | 🧪 |
| Icom radios (IC-705…) | `civ` | CI-V over USB serial | `~/ci-v` | 🧪 |
| tinySA Ultra | `tinysa` | USB serial shell | LIVE 2026-11-19 (sweep 100–300 MHz, 201 pts, by-id tty) | ✅ live |
| LiteVNA 64 | `litevna` | NanoVNA-V2 binary protocol | V2 protocol docs | 🧪 *protocol from docs* |
| HackRF One | `hackrf` | `hackrf_sweep` | – | 🧪 |
| bladeRF / HackRF / RTL-SDR | `soapy` | SoapySDR + liquid-dsp | `python/soapy_bridge.py` | 🧪 (DSP ✅ on synthetic IQ) |
| Proxmark3 / Proxmark5 | `proxmark3` | Iceman client (`~/pm5-og` build) | `node-proxmark3` ≥ 0.0.13 | 🧪 PM5 lightly: the driver drives the client (`hw version`, `hw status` over MCP); no card / RF operations yet |
| USB-UART adapters (Tigard port A, CP210x, CH340, FTDI, CDC-ACM) | `uart` | tty by stable identity | – | 🧪 (socat pty ✅) |
| USB hubs (port power) | USB tree + `usb_power` | uhubctl | proxyslave inventory logic | 🧪 tree ✅ on this PC; no ppps hub / uhubctl here |
| Web browser mic + camera | `browser` | getUserMedia over the UI WebSocket | – | ✅ headless Chrome fake media; 📝 real phone over https |
| VNC desktops (emulators, VMs, KVMs) | `vnc` | RFB 3.3–3.8 | in-house client + noVNC | ✅ QEMU VNC with password; 📝 Win 3.1 DPGM session |
| System monitor | `sysmon` | /proc, hwmon, nvidia-smi, amdgpu sysfs | – | ✅ CPU/mem/hwmon/NVIDIA; AMD GPU fixtures only |
| RTL-SDR wideband sweeps | `rtl_power` | rtl_power / soapy_power | – | 🧪 (no dongle) |
| SPI flash programmers | `flashrom` | flashrom CLI | – | ✅ flashrom dummy programmer (emulated W25Q128) |
| XGecu T48/TL866 | `minipro` | minipro CLI | – | 🧪 info/search/presence run; programmer is on `lab` |
| YARD Stick One / CC1111 | `rfcat` | rflib 2.0.1 | – | 🧪 fake dongle end to end; TX region-locked + approval |
| Cynthion (USB analyzer / Facedancer) | `cynthion` | analyzer gateware (vendor requests + bulk), facedancer | Packetry's protocol | 🧪 fake board + synthetic enumerations |
| PicoGlitcher | `picoglitcher` | findus | `findus` (pip) | 🧪 |
| Bus Pirate 5/6 | – | BPIO2 | buspirate skill | 📝 |
| Harogic HTRA (SAE/SAM/SAN) | `harogic` | USB, vendor libhtraapi | `htra_api.h` (SDK 0.55.x) | 🧪 |
| ChipWhisperer / Husky | – | – | `findus.HuskyGlitcher`, `~/cw-scope` | 📝 |

## Per-instrument checklist

### mdp (MDP-P906)
- [x] `id` is required (the all-zero ID is unverified [INF]; an explicit `00000000` is allowed with a warning)
- [x] `output` accepts only true/false/"on"/"off"; `set_voltage` limited to 0–30 V [INF rating] or lower `maxVolts`
- [x] `set_current` disabled unless `allowSetCurrent: true`, until the unit is confirmed
- [ ] Bring up with a paired module: `{"port": "/dev/ttyACM0", "id": "<radio_id.txt>"}` (pair first with the mdp CLI)
- [ ] Poll returns several V/I samples per frame; work out their spacing and push them individually instead of averaging (TODO in `src/devices/mdp`)
- [ ] Confirm the `set_current` unit (open question in mdp-p906 `STATE.md`)
- [ ] Multiple modules: one device per module address

### mp305
- [x] pymp305 0.6.3 (installed/upgraded into the mailab venv on device start)
- [ ] udev rule for the HID device
- [ ] First run on a real unit: DC set/output, CV/CC + OCP/`reapply`, modes, USB-PD `pd_set`/`pd_output`, program write/run (only the simulated unit in `python/mp305_fake.py` has been driven so far)
- [ ] BLE (`transport: "ble"`): never run; the bridge wraps MP305BLE on its own asyncio thread and does `reapply` itself (MP305BLE.set_output has no reapply)

### dm858
- [ ] LAN: confirm raw-socket port (5555?) or use usbtmc (`/dev/usbtmcN`)
- [ ] `READ?` blocking time vs poll period; consider `INIT` + `FETCh?`
- [ ] Track front-panel function changes (unit is only refreshed on `configure`)

### mho900
- [ ] SCPI over LAN: unit at 10.69.1.89 (RIGOL Web Control on :80) accepts TCP 5555 but doesn't answer `*IDN?` (2026-11-16). Check that LAN SCPI is enabled and no other client holds it
- [x] 55555 is **ADB** (stock, root, no auth; ~/rigol/mho900/MOD.md), not SCPI. The driver must never use it
- [ ] Port 111 (portmapper) is open: add a VXI-11 transport as an alternative to the raw socket
- [ ] Verify `:WAV:FORM BYTE` scaling against the 12-bit ADC; try `WORD`
- [ ] `:DISPlay:DATA? PNG` screenshot format
- [ ] RAW-mode deep memory captures (chunked `:WAV:STAR/STOP`)
- [ ] Logic channels (MSO) into the same trace

### sigrok (SLogic)
- [ ] Build/install the `slogic-dev` libsigrok fork system-wide, check `sigrok-cli --scan`
- [ ] Capture at high rates: stream `-O binary` instead of CSV for multi-Msample captures
- [ ] `mode: "stream"` for sigrok DMMs: verify the `-O analog` line format
- [ ] Decoder annotations as a timeline pane (currently log lines only)

### kc9531b
- [ ] Confirm the `setFrequency` unit (Hz vs MHz) for the correction table
- [ ] Mean/peak/RMS mode selection

### civ
- [ ] Give the ci-v package.json a `name`/`version` so it installs from GitHub (now loaded from `CIV_PATH`)
- [ ] Decode the scope waveform frames (`27 00`) into a `spectrum` trace + waterfall
- [ ] Scale the SWR meter to a real SWR value
- [ ] Safety: confirm before `ptt`

### tinysa
- [ ] Verify `scan … 3` output and prompt handling on the Ultra
- [ ] Use `scanraw` (binary) for speed
- [ ] RBW / attenuation / LNA settings

### litevna
- [ ] Verify register map, FIFO record layout and the sync burst on the LiteVNA 64
- [ ] SOL(T) calibration, stored per frequency plan
- [ ] Smith chart pane

### hackrf / soapy
- [ ] hackrf_sweep: check that the "new sweep" detection works for multi-band ranges
- [ ] soapy: check gain and rate ranges per device (bladeRF 2.0, HackRF)
- [ ] Audio playback in the web UI for `demod` WAVs
- [ ] Calibrated dBm (currently dBFS)

### proxmark3
- [ ] Set `PM3_CLIENT` / the client path; check that node-proxmark3 auto-connects to the port
- [ ] Expose a few typed commands (`hf search`, `lf search`, `hw tune` → trace)

### picoglitcher
- [ ] `pip install findus`, flash the PicoGlitcher firmware
- [ ] Target-specific classification (the current `campaign` is a generic template)
- [ ] Persist campaigns (findus has its own SQLite DB; import it as a dataset)
- [ ] Safety: confirm the target and voltage before glitching

## Multiple instances

Every driver can run several times: one device per unit, each with its own
id (the channel prefix; leave it empty for `<driver>`, `<driver>2`, ...).

| Driver | How to pick the unit |
|---|---|
| serial, kc9531b, tinysa, litevna | `path` (the port registry refuses a port that's already in use) |
| civ | same `path` for radios on one CI-V bus, a different `radioAddress` each |
| mdp | same `port` for modules on one radio bridge, a different `address` each |
| scpi, dm858, mho900 | `host` / `path` |
| sigrok | `conn` (USB `bus.address`, e.g. `1.12`) |
| hackrf | `serial` |
| soapy | `args`, e.g. `driver=bladerf,serial=...` |
| mp305 | `serial` or `path` (`list` command shows them) |
| proxmark3 | `port` |
| picoglitcher | `port` |

- [ ] Verify two MDP modules on one bridge (link re-targeting per request)
- [ ] Verify two radios on one CI-V bus
- [ ] Use `/dev/serial/by-id/...` paths so instances survive replugging

### harogic
- [x] ctypes struct layouts match `htra_api.h` (sizeof/offsetof checked with gcc)
- [ ] Run on `lab` with the analyzer attached: `{"lib": "~/sastudio/SAStudio4_x86_64_4.4.55.50/lib/libhtraapi.so"}`; needs `/etc/htrausb.conf` + udev (see the SAStudio setup notes); SAStudio must not hold the device
- [ ] IQ streaming mode (IQS_*) as a flowgraph source block

## Cross-cutting
- [ ] udev rules / stable device paths (`/dev/serial/by-id/...`) in the docs
- [ ] Device auto-detection (USB VID:PID → suggested driver)
- [x] Strict argument parsing for anything that switches hardware (`src/utils/args`, `parse_switch` in python bridges): no `Boolean("false") === true`
- [x] mdp: voltage/current limits in the driver
- [ ] Same limits for mp305 (`maxVolts`/`maxAmps`) and a TX allow-list for civ `ptt`
- [ ] Lab-wide safety policy (per-device limits, "AI may transmit/power" switches) instead of per-driver options
