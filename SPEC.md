# mailab spec

**mailab** = *my lab* + *mAI lab*: the AI owns the lab. It's an MCP server for a
hardware lab, plus a web UI where you preview the data, arrange panes, and
watch and steer what the AI does.

This file collects everything asked for so far and where each item stands.
[HW.md](HW.md) has the per-instrument hardware TODO.

Status: ✅ done · 🟡 partial · ⬜ not started

## 1. Core

| Requirement | Status | Notes |
|---|---|---|
| MCP server for the hardware lab, the AI operates the bench | ✅ | Streamable HTTP at `/mcp`, 25+ tools, every call shown in the activity pane |
| Web UI for data preview, live | ✅ | WebSocket push, uPlot charts |
| Configurable panes, shared between the user and the AI | ✅ | GridStack grid; `pane_*` tools; layout persisted in `data/lab.json` |
| Math | ✅ | mathjs over channels/traces, derived channels, math pane with KaTeX |
| Charts, live preview | ✅ | chart, trace, waterfall, value panes |
| Multiple instances of every device | ✅ | auto ids, port registry, shared CI-V bus and MDP radio bridge, unit selection (serial/path/port/conn) |
| Multi-call scripts ("script" = multi-MCP-call) for better timing | ✅ | `batch` tool: steps with `at`/`delayMs`/`repeat`/`intervalMs`, `$name.path` result references, loops, ~1 ms accuracy |
| Dracula theme | ✅ | default; cycles dracula → lab dark → light |
| Hardware safety in drivers (reviewer feedback) | 🟡 | strict on/off parsing everywhere, mdp: required ID, 30 V/10 A limits, `set_current` gated. Still open: mp305 limits, TX allow-lists, a lab-wide safety policy |
| Run on the lab host `nemanjan00@10.69.1.91` (`lab`) | ⬜ | Feather nRF52840, EVGA XR1 capture, sigrok, minipro and hackrf live there. Options: run mailab there, or add remote device agents. **Needs a decision** |

## 2. Panes / views

| Pane | Status | Notes |
|---|---|---|
| chart (live channels) | ✅ | |
| value (big readout) | ✅ | |
| trace: line/step/scatter | ✅ | spectrum, VNA, scope and logic captures, glitch scatter |
| constellation diagram | ✅ | trace mode `constellation` (flowgraph sink) |
| eye diagram | ✅ | trace mode `eye`; needs a matched-filter step in the demo graph to look open |
| waterfall | ✅ | |
| markdown panes (+ KaTeX) | 🟡 | done: rendering, editing, AI `note` tool. Planned: live values inside notes (`{{channel}}`, `{{= expr}}`) |
| JSON view | ✅ | collapsible tree, keeps open state, any lab value |
| Kaitai view | ⬜ | parse binary blobs with a `.ksy` → tree (reuses the JSON tree) |
| Readings table for spectrum markers | ✅ | trace pane `markers` (peak / fixed x / Δ to another marker), `peaks: N` auto peaks, shift-click adds, × removes |
| findus map preview | ⬜ | binned delay × length heatmap of glitch results (success rate per cell), like findus' own web view |
| audio output | ✅ | audio pane plays lab audio streams (WebAudio); flowgraph `audio` sink |
| webcam / Linux video input: live stream + snapshot | ✅ | V4L2 (ffmpeg) device: stream into an image/video pane, `snapshot` returns the image to the AI. Also the EVGA XR1 HDMI capture on `lab` |
| flowgraph editor | ✅ | live rates/errors, add/connect/edit/remove blocks |
| log console, activity, devices, channels, image, math | ✅ | |

## 3. DSP: liquid-dsp, GNU Radio-like

| Requirement | Status | Notes |
|---|---|---|
| liquid-dsp | ✅ | ctypes bindings (`python/liquid_dsp.py`): resampler, NCO, FIR, AGC, FM/AM/SSB demod, RRC interp, symbol sync, modem + EVM |
| Composable components, GNU Radio-like | ✅ | `flowgraph` device: blocks + links, persisted, editable live by the user and the AI |
| Scriptable blocks | ✅ | `python` block: `work(x, rate)` with numpy/dsp |
| Demod, FFT, digital analysis | 🟡 | done: FM/AM/SSB, spectrum, symbol sync, carrier recovery, PSK/QAM demod + EVM. Planned: FSK/GFSK, baud estimation, bit/packet output, BLE/ESB decoding |
| HackRF / bladeRF modulation (TX) | ⬜ | Soapy sink block, gated behind an explicit allow-TX + power limit |
| SDR receive in the flowgraph | ✅ | `soapy` source block; untested on hardware |
| Spectrum analyzer features: FFT with RBW, multiple traces, averaging | ✅ | `spectrum` sink: `rbw` → FFT size via window ENBW (actual RBW logged), windows hann/blackmanharris/flattop/rect, traces live/max/min/avg (exponential power average), `points` + peak/sample detector; verified: tone at 0 dBFS reads −0.14 dBFS |
| TCP/UDP IQ streaming in/out | ✅ | flowgraph `net_source` / `net_sink`: raw cf32/cs16/cu8 over TCP server/client or UDP, non-blocking; loopback verified (TCP cs16, UDP cu8) |
| Scope: triggered display + max/min hold + averaging | ⬜ | flowgraph `scope` sink: trigger edge/level/auto/normal/pre-trigger, traces live/max/min/avg (same as spectrum) |
| Scope measurements: Vpp, Vmax, Vmin, RMS, mean, frequency, period, duty | ⬜ | computed per capture, channels `<dev>_<id>_<meas>` + measurement table in the trace pane |
| libvolk | ⬜ | Not yet: the hot spots are per-symbol Python loops (carrier recovery, modem demod), and VOLK through ctypes wouldn't help. Move those loops into liquid/numpy/a small C helper first, then use VOLK kernels there |
| Optional WebGPU rendering | ⬜ | progressive enhancement for density/persistence views (RTSA-style), big constellations and fast waterfalls; Canvas2D stays the fallback |

## 4. Instruments

Per-instrument details and verification status are in [HW.md](HW.md).

| Instrument | Status | Notes |
|---|---|---|
| Miniware MDP-P906 (mdp-p906) | 🟡 | driver done, not run on hardware |
| sigrok, own libsigrok fork (Sipeed SLogic) | 🟡 | capture/decode/stream; demo driver verified |
| ISDT MP305 (pymp305) | 🟡 | python bridge |
| Rigol DM858E | 🟡 | SCPI preset |
| Rigol MHO900 | 🟡 | SCPI capture/measure/screenshot. Unit at http://10.69.1.89/: LAN SCPI doesn't answer yet; 55555 is ADB |
| MHO900 signal generator | ⬜ | `:SOURce` commands in the mho900 preset |
| DeepAce KC9531B | 🟡 | |
| Icom CI-V (ci-v) | 🟡 | cloned to `~/ci-v`, packaged as **icom-ci-v** (npm refused `ci-v` as too similar to `civ`). npm shows the staged `0.0.0-stage`, waiting for publish approval on npmjs.com |
| tinySA Ultra | 🟡 | protocol from docs |
| LiteVNA 64 | 🟡 | protocol from docs |
| HackRF / bladeRF | 🟡 | hackrf_sweep, soapy bridge, flowgraph source |
| Proxmark3 (node-proxmark3) | 🟡 | |
| PicoGlitcher (findus) | 🟡 | |
| nRF52840 modem | ⬜ | the mdp-p906 bridge firmware as a generic 2.4 GHz ESB radio (listen/send) |
| InfiRay P2 Pro thermal camera | ⬜ | UVC; false-colour image + min/max/centre temperature channels |
| Bus Pirate | ⬜ | BPIO2, using the buspirate skill |
| XGecu programmers (minipro) | ⬜ | `minipro` CLI: identify, read/write/verify chips; dumps as blobs for the Kaitai view |
| Glasgow | ⬜ | `glasgow` CLI applets |
| RTL-SDR | 🟡 | via `soapy` driver / flowgraph `soapy` source with `driver=rtlsdr` (SoapyRTLSDR in the Docker image). Planned: `rtl_power` wideband sweep driver, `rtl_tcp` interop through the net IQ blocks |
| Harogic HTRA spectrum analyzer | 🟡 | `harogic` driver: sweep → `spectrum` trace via vendor `libhtraapi` (ctypes, struct layouts checked against `htra_api.h` with the C compiler). Library from SAStudio4 on `lab` (desktop shortcut → `~/sastudio/SAStudio4_x86_64_4.4.55.50`). Device not on `lab`'s USB at the time; not run yet. Next: IQ streaming (IQS) as a flowgraph source |
| USB hub power control (uhubctl) | ⬜ | port on/off/cycle so the AI can power-cycle a hung device (with confirmation; don't cut the hub the bridge/AI host depends on) |
| GPU / system monitor (nvtop-like) | ⬜ | GPU/CPU load, memory, temperatures as channels (nvidia-smi / amdgpu sysfs / hwmon) |
| ChipWhisperer Husky | ⬜ | `chipwhisperer` python API: power/EM trace capture → traces, clock/voltage glitch (also `findus.HuskyGlitcher`); scatter/map views like the PicoGlitcher |

## 5. Project

| Requirement | Status |
|---|---|
| `git init`, commit as you go, remote `git@github.com:nemanjan00/mailab.git` | ✅ |
| husky pre-commit (lint-staged + jest) | ✅ |
| HW.md with the hardware TODO | ✅ |
| Docker build | ✅ | `node:24-trixie-slim` + sigrok, liquid-dsp 1.7, SoapySDR (hackrf/bladerf/rtlsdr), ffmpeg, uhubctl, pymp305, findus; smoke-tested (flowgraph EVM via MCP, camera). Run with `--privileged --network host -v /dev:/dev`. Not included: the SLogic libsigrok fork, Harogic SDK, PM3 client |
| implement-js conventions (CommonJS, tabs, promise chains, `src/services`, `bin/`, forever/nodemon) | ✅ |

## 6. Order of work from here

1. ~~Webcam / V4L2 stream + snapshot~~ ✅ (XR1 capture: use `camera` on `lab`; P2 Pro thermal still open)
2. ~~Spectrum markers + readings table~~ ✅
3. Kaitai view (+ blobs: minipro dumps, captures)
4. findus map preview (heatmap)
5. Markdown live values
6. MHO900 siggen; Soapy TX block with safety gate
7. nRF52840 modem, Bus Pirate, minipro, Glasgow, ChipWhisperer Husky, uhubctl, system monitor drivers; Harogic IQ streaming
8. Digital analysis: FSK/GFSK, baud estimation, packet decoding
9. Deployment on `lab`: waiting on your decision

## Appendix: requests in order (this session)

1. "project idea, mcp server for hw lab, with webui for data preview, panes configurable ui, ai. math, live preview, charts... mailab (mai - my and mAI for AI) AI owns lab"
2. git init
3. https://github.com/nemanjan00/mdp-p906
4. https://github.com/nemanjan00/libsigrok
5. https://github.com/nemanjan00/pymp305
6. husky, mho900, md858e ("husky" most likely meant the ChipWhisperer Husky, see 46; husky git hooks were added too)
7. https://github.com/nemanjan00/kc9531b
8. tinysa ultra
9. litevna64
10. https://github.com/nemanjan00/ci-v
11. https://github.com/nemanjan00/node-proxmark3
12. https://fault-injection-library.readthedocs.io/en/latest/getting_started/ findus, picoglitcher
13. hackrf, bladerf
14. make HW.md with hw todo
15. https://github.com/nemanjan00/mailab / git@github.com:nemanjan00/mailab.git
16. liquiddsp
17. commit as you go
18. multiinstance for all devices
19. dracula theme
20. clone civ, publish on npm
21. constellation diagram
22. composable components, gnuradio like
23. scriptable blocks
24. scriptable mcp calls, for better timing
25. webcam, linux video input
26. when I say script, I mean multimcpcall
27. reviewer feedback on the mdp driver: output-off coercion, default all-zero ID, setpoint limits, unconfirmed current unit, noisy activity pane (+ `~/mdp-p906/` as the source of truth)
28. markdown panes
29. readings table, for spectrum markers
30. json view
31. kaitai view
32. liquidsp, like demod, fft, digital analysis...
33. constellation, eye diagram..
34. audio output
35. webcam video stream, capture snap photo
36. mho900 siggen, hackrf/bladerf modulation
37. nrf52840 modem
38. http://10.69.1.89/ (Rigol web control)
39. findus map preview
40. infiray p2 pro
41. nemanjan00@10.69.1.91
42. buspirate
43. xgecu (minipro)
44. glasgow
45. take a break, write down spec.md, everything I said in this session and then keep going
46. chipwhisperer husky
47. harogic lib, you can grab .h on lab pc nemanjan00@10.69.1.91 (not installed there; taken from PentHertz `Install_HTRA_SDK.zip`, kept out of the repo)
48. libvolk?
49. optional webgpu?
50. harogic sastudio shortcut is on desktop on lab pc
51. uhubctl, hub power control
52. nvtop
53. update spec as I go
54. tcp/udp stream iq in/out
55. docker build
56. fft, multi trace, rbw, averaging...
57. rtl sdr
58. max hold, min hold, everaging, including for scope
59. scope trigger preview... Vpp and similar measurements
60. frequency too
