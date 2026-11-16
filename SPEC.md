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
| GUI SDK for readable panes | 🟡 | `public/sdk/`: `pane()` (reactive config, auto-dispose), `table`, `feed`, `iconButton`, `empty`, `toolbar`, `field`, `widget` (uPlot/canvas composed in, disposed with the scope). Panes on it: devices, channels, activity, chat. Next: log, value, json, kaitai, flowgraph, image, audio; then chart/trace via `widget` |
| Frontend bundled with esbuild | ✅ | `public/` sources → `public/build/` (app.js + app.css); npm imports for qrp/uPlot/GridStack/KaTeX/marked instead of vendor script tags |
| Frontend on qrp (github.com/nemanjan00/qrp) | 🟡 | app store is qrp `state()` (lab state, activity/chat feeds, live values at 4 Hz in `batch`); 4 panes migrated via the SDK; imperative panes still work against the same store |
| Dracula theme | ✅ | default; cycles dracula → lab dark → light |
| Hardware safety in drivers (reviewer feedback) | 🟡 | strict on/off parsing everywhere, mdp: required ID, 30 V/10 A limits, `set_current` gated. Still open: mp305 limits, TX allow-lists, a lab-wide safety policy |
| HTTP MCP for collaboration | ✅ | Streamable HTTP MCP with sessions (stateless fallback); `MAILAB_TOKENS` name:token:rw/ro on UI/REST/WS/MCP; read-only = read tools + chat; activity shows `alice/claude-code`; remote via `HOST=0.0.0.0` |
| Collab chat (web UI + MCP) with MCP push notifications | ✅ | chat pane (markdown/KaTeX) + `chat_send`/`chat_read`, persisted; push: stdio channel bridge `bin/channel.js` (`notifications/claude/channel`, verified end to end: push in, reply out); HTTP sessions get `notifications/message`. Claude Code channels are stdio-only research preview |
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
| Kaitai view | ✅ | lab blobs (devices/AI/upload) + server-side Kaitai (compiler in debug mode): field tree with byte ranges + hex dump with highlight; MCP `blob_write`/`blob_read`/`kaitai_parse` |
| Log classification (reference: diversity-classifier) | ⬜ | github.com/nemanjan00/diversity-classifier as reference: device logs / serial consoles / glitch-target replies → templates; the AI sees only unmatched clusters + aggregates/alarms; also replaces the generic glitch reply classes |
| Shared terminals (shell-session-mcp) | ⬜ | github.com/nemanjan00/shell-session-mcp: PTY sessions (bash, gdb, openocd, serial consoles) as a `shell` device + terminal pane (xterm.js), driven by both the user and the AI; output pushes like its `notifications/message` events |
| protokai (.proto → .ksy) in the Kaitai view | ⬜ | github.com/nemanjan00/protokai: kaitai pane/`kaitai_parse` accept `proto` → protokai → .ksy (needs multi-file .ksy imports in the Kaitai loader) → parse protobuf blobs with field names |
| Readings table for spectrum markers | ✅ | trace pane `markers` (peak / fixed x / Δ to another marker), `peaks: N` auto peaks, shift-click adds, × removes |
| findus map preview | ✅ | trace pane `view: "map"` on scatter datasets: delay × length grid, colour = success rate, opacity = attempts, best cell in the legend |
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
| WebSocket streams | ⬜ | `ws-client`/`ws-server` modes for net_source/net_sink (IQ and data), for web SDRs and browser tools. (If "websocket" meant MCP-over-WebSocket, this row changes) |
| Spectrum analyzer features: FFT with RBW, multiple traces, averaging | ✅ | `spectrum` sink: `rbw` → FFT size via window ENBW (actual RBW logged), windows hann/blackmanharris/flattop/rect, traces live/max/min/avg (exponential power average), `points` + peak/sample detector; verified: tone at 0 dBFS reads −0.14 dBFS |
| TCP/UDP IQ streaming in/out | ✅ | flowgraph `net_source` / `net_sink`: raw cf32/cs16/cu8 over TCP server/client or UDP, non-blocking; loopback verified (TCP cs16, UDP cu8) |
| Scope: triggered display + max/min hold + averaging | ✅ | flowgraph `scope` sink: trigger rising/falling/none, level, auto/normal, pretrigger; traces live/max/min/avg; complex input → real/imag/mag |
| Scope measurements: Vpp, Vmax, Vmin, RMS, mean, frequency, period, duty | ✅ | per capture (frequency via mid-level crossings with hysteresis); selected ones → channels `<dev>_<id>_<m>`; strip under the trace plot. Verified: 10 kHz/30 % square, 1234 Hz sine |
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
| DeepAce KC901K / KC908V | ⬜ | handheld RF analyzers, same vendor as the KC9531B (try its framing: 0xFE header + sum checksum); sweeps → spectrum trace |
| ThunderScope | ⬜ | open-source 4-ch 1 GS/s PCIe/Thunderbolt scope; TS.NET SCPI + waveform data socket (as used by ngscopeclient) → traces, scope measurements, triggers |
| NanoKVM(+) | ⬜ | IP-KVM as an instrument: HDMI screen (MJPEG stream → image pane, snapshot to the AI), USB keyboard/mouse (type text, keys), ATX power/reset; via its HTTP/WebSocket API |
| USB hub power control (uhubctl) | ⬜ | port on/off/cycle so the AI can power-cycle a hung device (with confirmation; don't cut the hub the bridge/AI host depends on) |
| GPU / system monitor (nvtop-like) | ⬜ | GPU/CPU load, memory, temperatures as channels (nvidia-smi / amdgpu sysfs / hwmon) |
| ChipWhisperer Husky | ⬜ | `chipwhisperer` python API: power/EM trace capture → traces, clock/voltage glitch (also `findus.HuskyGlitcher`); scatter/map views like the PicoGlitcher. Reference (not direct integration): github.com/nemanjan00/cw-scope |

## 5. Project

| Requirement | Status |
|---|---|
| `git init`, commit as you go, remote `git@github.com:nemanjan00/mailab.git` | ✅ |
| husky pre-commit (lint-staged + jest) | ✅ |
| HW.md with the hardware TODO | ✅ |
| Docker build | ✅ | `node:24-trixie-slim` + sigrok, liquid-dsp 1.7, SoapySDR (hackrf/bladerf/rtlsdr), ffmpeg, uhubctl, pymp305, findus; smoke-tested (flowgraph EVM via MCP, camera). Run with `--privileged --network host -v /dev:/dev`. Not included: the SLogic libsigrok fork, Harogic SDK, PM3 client |
| implement-js conventions (CommonJS, tabs, promise chains, `src/services`, `bin/`, forever/nodemon) | ✅ |

## 6. Order of work from here

Done so far (in order): core, 21 drivers, flowgraph DSP, batch, multi-instance, Dracula, camera, markers/readings,
Docker, Harogic, net IQ, spectrum analyzer traces, triggered scope + measurements.

Next:
3. Markdown live values (`{{channel}}`, `{{= expr}}`)
4. MHO900 siggen; Soapy TX block with an allow-TX + power gate
5. Drivers: nRF52840 modem, Bus Pirate, minipro, Glasgow, ChipWhisperer Husky, uhubctl, system monitor (nvtop-like), InfiRay P2 Pro, rtl_power
6. Digital analysis: FSK/GFSK, baud estimation, bit/packet output
7. Harogic IQ streaming source; MHO900 VXI-11 transport
8. Optional WebGPU renderers; native hot loops (then VOLK)
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
61. spec update
62. websocket
63. kc901k kc908v
64. http mcp for collab
65. mcp chat for collab, with web ui and mcp push notifications
66. https://github.com/nemanjan00/protokai
67. https://github.com/nemanjan00/shell-session-mcp
68. https://github.com/nemanjan00/cw-scope as reference, not direct integration
69. also reference https://github.com/nemanjan00/diversity-classifier
70. you are vanilla js? mayne nemanjan00/qrp
71. esbundle
72. it is friendly to composable js elements (qrp)
73. nanokvm+ as hw
74. thunderscope
75. gui sdk, for more readable individual components?
