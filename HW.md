# Hardware TODO

Status of every instrument mailab knows about. **Nothing here has been run
against real hardware yet**, except the sigrok `demo` driver and the
`process` driver with a fake helper. Drivers marked *protocol from docs* were
written from documentation or memory; expect fixes on first contact.

Legend: ✅ done · 🧪 implemented, untested on hardware · 📝 planned · ⚠️ known gap

| Instrument | Driver | Transport | Based on | State |
|---|---|---|---|---|
| Simulated signals | `sim` | – | – | ✅ |
| Anything printing lines | `serial` | USB serial (tty) | – | 🧪 |
| Any JSON-lines helper | `process` | stdio | `python/mailab_bridge.py` | ✅ (fake helper) |
| Miniware MDP-P906 PSU | `mdp` | nRF52840 radio bridge | `~/mdp-p906/host` | 🧪 |
| ISDT MP305A/B PSU | `mp305` | USB-HID | `pymp305` | 🧪 |
| Rigol DM858/DM858E DMM | `dm858` | SCPI over LAN / usbtmc | programming guide | 🧪 |
| Rigol MHO900 scope | `mho900` | SCPI over LAN / usbtmc | DHO-family SCPI | 🧪 *protocol from docs* |
| Sipeed SLogic / DSLogic | `sigrok` | sigrok-cli | `nemanjan00/libsigrok` (slogic-dev) | 🧪 (demo ✅) |
| DeepAce KC9531B RF power meter | `kc9531b` | USB serial | `kc9531b` (npm) | 🧪 |
| Icom radios (IC-705…) | `civ` | CI-V over USB serial | `~/ci-v` | 🧪 |
| tinySA Ultra | `tinysa` | USB serial shell | tinySA shell docs | 🧪 *protocol from docs* |
| LiteVNA 64 | `litevna` | NanoVNA-V2 binary protocol | V2 protocol docs | 🧪 *protocol from docs* |
| HackRF One | `hackrf` | `hackrf_sweep` | – | 🧪 |
| bladeRF / HackRF / RTL-SDR | `soapy` | SoapySDR + liquid-dsp | `python/soapy_bridge.py` | 🧪 (DSP ✅ on synthetic IQ) |
| Proxmark3 | `proxmark3` | RRG client | `node-proxmark3` | 🧪 |
| PicoGlitcher | `picoglitcher` | findus | `findus` (pip) | 🧪 |
| Bus Pirate 5/6 | – | BPIO2 | buspirate skill | 📝 |
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
- [ ] `pip install pymp305`, udev rule for the HID device
- [ ] Check `read_state()` field names match `python/mp305_bridge.py` (voltage/current/power/temperature)
- [ ] BLE variant (`MP305BLE`) as an option

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

## Cross-cutting
- [ ] udev rules / stable device paths (`/dev/serial/by-id/...`) in the docs
- [ ] Device auto-detection (USB VID:PID → suggested driver)
- [x] Strict argument parsing for anything that switches hardware (`src/utils/args`, `parse_switch` in python bridges): no `Boolean("false") === true`
- [x] mdp: voltage/current limits in the driver
- [ ] Same limits for mp305 (`maxVolts`/`maxAmps`) and a TX allow-list for civ `ptt`
- [ ] Lab-wide safety policy (per-device limits, "AI may transmit/power" switches) instead of per-driver options
