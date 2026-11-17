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
| Tablet interface: numeric entry popover | ✅ | SDK `numberField`: tap → keypad popover (digits, `.`, `±`, ⌫, C, set) + unit buttons from the field's unit (V → mV/V/kV, Hz → Hz…GHz, s → ns…s, A → µA/mA/A, dBm only dBm; W, Ω, F, H); bottom sheet under 520 px; desktop typing with suffixes (`2.4G`, `100m`, `4.7u`, `3meg`), base units out. Used by custom-pane `number` controls. Verified in the browser (set + typed values reach the device). No device dialog takes numbers yet |
| Dracula theme | ✅ | default; cycles dracula → lab dark → light |
| Auth hardening (reviewer feedback, rounds 2–3) | ✅ | `?token=` only as a login link (→ HttpOnly SameSite=Strict cookie + redirect), never accepted on API/MCP/WS; token table is a `Map` (inherited keys like `constructor`/`__proto__` were accepted as tokens: fixed); writes need role `rw` exactly (REST + MCP); non-loopback `HOST` without tokens refuses to start (`MAILAB_ALLOW_OPEN=1` overrides; Docker README uses tokens); open mode accepts only loopback/`MAILAB_ALLOWED_HOSTS` Host headers and same-origin requests, which blocks DNS rebinding (REST, MCP, WS). Verified against a live server |
| Math sandbox (reviewer feedback, round 4) | ✅ | inside expressions `import`, `createUnit`, `evaluate`, `parse`, `compile`, `simplify`, `derivative`, `resolve`, `reviver` are disabled (a read-only user could redefine units for everyone); matrix constructors/growth (`zeros`, `ones`, `identity`, `random*`, `range`, `resize`, `reshape`, `concat`, `kron`, outer `multiply`, broadcasting `add`/`subtract`/`.*`/`./`/`.^`) are capped at 1M elements (memory exhaustion would stop PSU polling). Tests |
| Process hygiene | ✅ | device poll loops re-check `stopped` before rescheduling (a poll in flight during stop() rescheduled itself); locks use a timer-free promise mutex (`src/utils/mutex`) instead of queue-promised, whose wrapper left a 1 ms setTimeout loop running forever after a call (CPU burn; upstream bug to report); debounced saves and the WS push loop are unref'd. Jest exits cleanly |
| Hardware safety in drivers (reviewer feedback) | 🟡 | strict on/off parsing everywhere, mdp: required ID, 30 V/10 A limits, `set_current` gated. Still open: TX allow-lists for SDR TX (rfcat done), a lab-wide safety policy |
| HTTP MCP for collaboration | ✅ | Streamable HTTP MCP with sessions (stateless fallback); `MAILAB_TOKENS` name:token:rw/ro on UI/REST/WS/MCP; read-only = read tools + chat; activity shows `alice/claude-code`; remote via `HOST=0.0.0.0` |
| Collab chat (web UI + MCP) with MCP push notifications | ✅ | chat pane (markdown/KaTeX) + `chat_send`/`chat_read`, persisted; push: stdio channel bridge `bin/channel.js` (`notifications/claude/channel`, verified end to end: push in, reply out); HTTP sessions get `notifications/message`. Claude Code channels are stdio-only research preview |
| Server-enforced safety rules | ✅ | `src/safety`: `when` (mathjs over latest channel values, `<ch>_age` = seconds since last sample) held for `for_ms` → action `{device, command, args}`, cooldown; checked on every input sample + a 250 ms tick; firings → activity + chat; `locked` rules only removable by a person (REST), not by the AI (MCP `rule_remove` refused). MCP `rule_add`/`rule_remove`/`safety_overview`, REST `/api/safety`. Tests + verified live: a rule pulled back an approved AI change |
| Safety hardening (reviewer feedback, round 5) | ✅ | AI `rule_add` whose action matches the approval policy waits for a person (rules can't smuggle `output on`); rule ids are random (a boot counter could hand a new rule a restored locked rule's id) and locked rules can't be replaced; rules that fail to evaluate alarm in chat; new token role `human` (people): only humans approve, change the policy or remove locked rules; `rw` = AIs. Open mode = one local human (documented limit: a shell-capable agent on the same machine without tokens). Regression tests for each |
| Approve-in-UI for risky commands | ✅ | policy (default: outputs on, voltage > 5 V, PTT, glitch/campaign, pairing; editable only via REST/UI, not by the AI) → AI `device_command` waits; Approve/Deny card in the chat pane; approve runs it, deny/timeout (120 s) refuses. Tests + clicked through in the browser |
| Generic sweep & optimize | ✅ | `src/sweep`: `sweep` (1-2 params, linear/log/list, settle, mean/latest reads, stopWhen, after-command → table value + trace) and `optimize` (golden-section / hill-climb, iteration/tolerance limits → value + scatter trace); device commands go through `safety.gate` (one approval for the whole plan; denial runs nothing). Verified on sim over MCP. Not done: a heatmap pane for 2-D grids |
| One timebase across instruments | ✅ | done: `sync_mark` flowgraph block stamps sync pulses as {index, t, rate} marks; `timebase_align` MCP tool + `src/utils/timebase` math (offsetSeconds/alignIndex/driftPpm) align instruments on one sample grid; stated tolerance one flowgraph tick (common-mode cancels in the offset); jest (math, MCP tool) + python/test_sync.py; physical multi-instrument verification pending |
| Record & replay as a device | ✅ | `src/recordings`: `recording_start` / `recording_stop` / `recordings` (channel globs + traces/values/events/logs → `DATA_DIR/recordings/*.ndjson`, maxSeconds/maxBytes); REST list/start/stop/download, delete for humans; `replay` driver (original names or prefix, speed, loop, pause/seek). Verified record → replay over MCP. Not done: a recordings pane |
| Experiment journal with evidence tags | ✅ | done: `src/journal` — notes get [HW] automatically when they link to real data (channel/trace/value/blob/image/run), [INF] when nothing backs them (mdp-p906 convention, enforced); batch runs recorded as runs (device options + setpoints + created data) in DATA_DIR/journal.json; MCP tools journal_list / journal_note / journal_export (markdown); 9 jest tests incl. persistence across restarts |
| Binary diff for blobs | ✅ | `blob_diff` + blob pane `compare`: merged changed ranges, side-by-side hex with highlights. Next: map changed ranges to Kaitai fields |
| mailab-managed Python venv | ✅ | `src/services/pyenv`: venv in `DATA_DIR/python` (system site packages for apt SoapySDR/liquid), created on first use; Python drivers declare `requires` (flowgraph/soapy/harogic: numpy; mp305: pymp305, hidapi; picoglitcher: findus, pyserial), installed on device start if not importable, progress in the device log; serialized pip; opt-out `MAILAB_MANAGE_PYTHON=0` / `PYTHON`. Verified: venv creation, system numpy reuse, pymp305+hidapi install. Helpers that crash now show `error` + their last stderr line |
| Test automation for python | ✅ | `python/test_modem.py` is pytest-style (4 tests) and runs from jest (`src/devices/flowgraph/__tests__/modem.test.js`), so the pre-commit hook covers the BER regression; skipped when numpy/liquid-dsp are missing |
| Serializable lab state: save / load | ✅ | `lab.exportState()` / `importState()` (versioned `{mailab: 1}`: devices + options, derived, panes, safety rules + policy, classifier templates, trend patterns; not data/chat); profiles in `DATA_DIR/profiles` (`src/profiles`, safe names); REST list/save/download, load/upload/delete human-only; MCP `lab_profiles`, `lab_save` (a new name saves; overwriting an existing profile is human-only on REST and waits for approval over MCP, showing a diff), `lab_load` (waits for approval with a diff of what changes: it can replace safety rules); `GET /api/profiles/:name/diff`; header "lab" dialog (save as, load, download, delete, upload). Tests + UI verified |
| Python UI SDK: custom panes | ✅ | `custom` pane renders a layout tree (row, col, text with `{{channel}}` live values, value, button, toggle, slider, number, chart, table, image); controls run device commands as the clicking person; `python/mailab_ui.py` builders + `lab.panel()` so bridges publish/update their own control panel; AI uses `pane_add type custom`. Verified: a python bridge's panel operated from the browser (setpoint 12 V + output on reached the device) |
| Run on the lab host `nemanjan00@10.69.1.91` (`lab`) | ✅ | mailab runs there (tmux, port 3000, MAILAB_TOKENS): DM858 deep integration live (10.69.2.52:5025), nRF52840 ESB bridge on /dev/ttyACM0 (firmware verified). See "Lab host" below |

## 2. Panes / views

| Pane | Status | Notes |
|---|---|---|
| chart (live channels) | ✅ | |
| value (big readout) | ✅ | |
| trace: line/step/scatter | ✅ | spectrum, VNA, scope and logic captures, glitch scatter |
| constellation diagram | ✅ | trace mode `constellation` (flowgraph sink) |
| eye diagram | ✅ | trace mode `eye`; needs a matched-filter step in the demo graph to look open |
| waterfall | ✅ | |
| markdown panes (+ KaTeX) | ✅ | rendering, editing, AI `note` tool, live values `{{channel}}` / `{{channel|digits}}` (also inside math), re-rendered at most 5 Hz and only on change |
| JSON view | ✅ | collapsible tree, keeps open state, any lab value |
| Kaitai view | ✅ | lab blobs (devices/AI/upload) + server-side Kaitai (compiler in debug mode): field tree with byte ranges + hex dump with highlight; MCP `blob_write`/`blob_read`/`kaitai_parse` |
| Grafana-like long-term trends | ✅ | `src/trends`: recorded channels (glob patterns; defaults `*_v *_i *_p *_temp *_vin cls_*`) → min/max/mean buckets at 1 s (6 h), 10 s (3 d), 1 min (30 d), 1 h (2 y), appended to `DATA_DIR/trends`, reloaded at boot; queries use the finest tier covering the range, merged to the point budget; late samples merge. Trend pane (5 min … 30 d, mean line in min/max band); MCP `trend_read` (relative times like -24h) / `trend_record`. Verified with a 24 h CC/CV battery charge, incl. restart |
| Configurable MCP notifications / subscriptions | ✅ | central `lab.notify` (rule, approval, trigger, cluster digests, template matches, raw lines); MCP `subscribe` (types + device/template/regex filters) → `notifications/message` on the session (logging capability; verified end to end with the SDK client); `notifications_read` to poll; channel bridge pushes rule/approval/trigger/cluster (`MAILAB_SUBSCRIBE`). Fixing it showed HTTP chat notifications had been silently dropped (missing logging capability) |
| Log classification (reference: diversity-classifier) | ✅ | `src/classify`: device lines (rx/uart/stdout/…) normalized (<num> <hex> <ip> <uuid>) into clusters; templates (`classifier_add`) count matches → `cls_<name>`, numbers recorded as `cls_<name>_1…` for charting; templates absorb their backlog; new clusters → debounced digest notifications; classifier pane (clusters → template in one click). Verified on live console traffic. Next: glitch reply classes from templates |
| Shared terminals (shell-session-mcp) | ✅ | `shell` device (src/devices/shell): PTY sessions via `script -qfc` (pty:false pipes), session_start/list/kill, write (with tx log), write_raw (base64), session_resize; term events + per-session scrollback; terminal pane has a session dropdown; jest shell.test.js (9) + live bash session verified in headless Chrome |
| protokai (.proto → .ksy) in the Kaitai view | ✅ | github.com/nemanjan00/protokai: kaitai pane/`kaitai_parse` accept `proto` → protokai → .ksy (needs multi-file .ksy imports in the Kaitai loader) → parse protobuf blobs with field names — implemented: pane + kaitai_parse take proto/protoFiles/protoType via python/protokai_bridge.py (protoc + protokai, PROTOKAI_PATH); multi-file .ksy bundle compile with import loader, topo-ordered UMD load; jest 4/4 |
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
| Modem toolkit, all common modulations (✅ BER-tested in `yarn test`/husky via jest + pytest, all at BER ≈ 0: bpsk qpsk psk8 apsk16 qam4/8/16/32/64/128/256 sqam32/128 2fsk msk gfsk gmsk 4fsk ook. Fixed: qam32 via matched filter + Gardner (`symbol_sync method: gardner`; liquid's loop mis-locks on the 8×4 grid), GMSK/GFSK via an integrating discriminator (2e-2 → 0)): analog AM/DSB/SSB/FM/PM; digital OOK/ASK, 2/4-FSK, GFSK, MSK, GMSK, BPSK…PSK, QAM up to 256, APSK, DPSK; BER; sync; clock recovery; bit streams | 🟡 | flowgraph blocks: bit sources (PRBS/pattern/text), modulators, AWGN/CFO channel, FSK/OOK demod, clock recovery (Gardner/M&M on real signals; symbol_sync for linear), slicer → bits, sync-word framing, BER meter (PRBS self-sync), bit-stream sinks (value/blob) |
| OpenCV (vision on lab images / camera streams) | ✅ | `vision_bridge.py` (opencv-python-headless 4.14.0.94, tesseract CLI): pipelines (crop/threshold/blur/canny/contours/template/color/led/seven_seg/ocr/warp/align ORB+homography/aruco scale+pose/measure px+mm/diff); `vision_run` (annotated overlay image), `vision_watch` ROIs on any image stream (camera, browser `<dev>_frame`, VNC `<id>_screen`) → channels `<watch>_<roi>` + `{type: "vision"}` notifications (state changes, above/below, stable, cooldown), fps cap + frame dropping, persisted; `vision` ROI-editor pane; `image_write` / `PUT /api/images/:name`. Verified live on synthetic DMM frames (LED green→red, 7-seg 42→137→Err, notifications pushed over SSE); python tests pass on master with the managed venv. Gaps: real camera/KVM untested; no English tessdata on this host (uses afr; install tesseract-data-eng); 7-seg decimal point is positional |
| Realtime audio DSP + AI denoise | ✅ | flowgraph audio blocks (`python/audio_dsp.py`, `audio_blocks.py`): biquad (RBJ, cascaded) / FIR / hum notch (50/60/auto + harmonics) / auto-tracking tone notch, compressor (knee, lookahead, RMS/peak, sidechain HPF) / limiter / gate-expander / AGC with gain-reduction channels, spectral NR (Wiener/subtraction) / de-click / DC block, `bypass` on every block, live `set_param`, latency per block in stats (verified against measured delay). Neural `denoise`: DeepFilterNet3 on CUDA (RTX 5080: 60 ms, RTF ~0.2; lazy pinned install), RNNoise CPU (30 ms, RTF <0.01), Maxine detection stub. Templates voice_cleanup / sdr_fm_audio / sdr_am_audio / hum_removal / broadcast; spectrum `overlay` = before/after in one trace. Verified live on master (voice_cleanup on a noisy WAV: hum 50 Hz found, DeepFilterNet ready on cuda). Untested: real mic/SDR input, Maxine SDK |
| RfCat (YARD Stick One, CC1111 dongles) | 🟡 | `rfcat` driver (rflib 2.0.1 + pinned deps; installs and imports on py3.14): config (2FSK/GFSK/ASK-OOK/MSK, drate, deviation, chanbw, sync, fixed/variable length, CRC, Manchester, preamble; effective values + registers), rx / listen → table + blob `<id>_packets` + `<id>_packet` events + `<id>_rssi`, tx / replay (index or blob slice), `power` (max), specan → `<id>_spectrum` dBm. tx / replay / power need approval; TX only inside the lab's region bands (`MAILAB_RF_REGION` eu/us/none — a lab setting, not a device option; `txBands` only narrows). Tested end to end with a fake dongle; hardware untested |
| Cynthion (Great Scott Gadgets) + LUNA | 🟡 | `cynthion` driver: analyzer capture the way Packetry drives it (vendor SET_STATE, speed auto/high/full/low, bulk 0x81) → pcap blob (LINKTYPE_USB_2_0, opens in Packetry / Wireshark) + live decoded transfers, control transfers in the log, descriptors ("what did it enumerate as"), packet rate channel; `load` decodes existing pcaps; stdlib decoder (PIDs, CRC5/16, transactions, transfers, descriptors). Facedancer emulation (keyboard, mass storage from a blob, descriptor fuzz), gateware / flash — all approval-gated. Packages per feature (cynthion 0.2.5, facedancer 3.1.3, apollo-fpga 1.1.1; install on py3.14 OK); LUNA toolchain (yosys / nextpnr-ecp5) detected, not installed. Tested with a fake board and synthetic enumerations; not run on hardware |
| Analog video decode | ✅ | Flowgraph `video_decode` block (docs/blocks/video_decode): PAL/NTSC composite → grayscale PNG frames on the lab image stream (rate-limited by `fps`), plus a stats value (frame/height/lines/line_us) and a `_frames` counter channel. Slicing: EMA-smoothed p5/p12 percentile threshold between sync tip and blanking; line period = median of recent hsync gaps (immune to noise blips); windowed scan so large chunks can't drop lines. Synthetic-vector tests (python/test_video.py, PAL gradient pixel check / NTSC ramp / inverted+noise / rate cap) via jest; live example graph screenshot. Real RF capture (e.g. FM-demodulated FPV) pending hardware |
| ngscopeclient decoders & blocks | ✅ | ported as flowgraph pieces: 8b/10b codec+decoder (python/eight_ten.py, comma-locked slicer), tie_jitter / cdr (PI PLL) / eye_mask (keep-out polygon) blocks, USB sigrok stack test (usb_signalling+usb_packet, synthetic FS waveform); UART/SPI/I2C/Manchester already existed; CAN/Ethernet decoders not ported (no vectors) |
| MCP connection help in the UI | ✅ | the header's MCP address opens a modal: `claude mcp add` with this lab's URL, JSON config for other clients, token hint when auth is on, channel-bridge config, copy buttons |
| libsigrokdecode for external inputs | ✅ | flowgraph `decode` block + `decode`/`feed` commands (base64/hex/bits/lab blob; net_source u8/u16/u32/bits; sigrok `capture_blob`): the installed libsigrokdecode decoder scripts run in-process through a `sigrokdecode` stand-in (stacking works, e.g. spi+spiflash), because local sigrok-cli 0.7.2 + libsigrokdecode-git fails on any channel mapping; built-in numpy uart/spi/i2c/manchester with the same annotations. → value table, events, log, data blob, count channel. Regression test. `capture_blob` untested |
| Demod, FFT, digital analysis | ✅ | done: FM/AM/SSB, spectrum, symbol sync, carrier recovery, PSK/QAM demod + EVM, FSK/GFSK (discriminator + clock recovery), baud estimation (`baud_est`), BLE advertising + nRF Enhanced ShockBurst packet decode (`packet_decode`, CRC-checked, scapy-cross-checked) |
| RF chamber / bypass mode | ✅ done | env-only `MAILAB_RF_CHAMBER=1` / `MAILAB_UNSAFE=1` (src/utils/bypass, read from the fixed process env at call time — no device option / API / AI path can set it): lifts the RF TX band allow-list (src/utils/rfbands), per-TX approvals (safety auto-grants + posts 🔓 chat line, notify + activity entry stamped `bypass`) and per-device PSU limits (mdp / mp305 maxVolts/maxAmps). PSU hardware-damage caps stay unless the independent `MAILAB_UNSAFE_PSU=1` opt-out is set too (mp305 bridge gets `--unsafe-psu`). Server-enforced rules still fire. Persistent hazard-stripe banner in the UI + `bypass` in lab state / safety_overview; every activity line is stamped while active. Tests: bypass, safety, mdp, mp305, rfbands |
| 802.11-style OFDM modulation (real Wi-Fi shaping) | ✅ done | flowgraph `ofdm_mod` / `ofdm_demod`: 64-pt IFFT, 48 data + 4 pilot subcarriers, QAM per carrier, cyclic prefix, 802.11a/g STF/LTF preamble; bytes → genuine OFDM IQ (not single-carrier). Drives the beacon demo (demos/beacon-to-iq) so the spectrum is real Wi-Fi-shaped; loopback demod recovers the bytes. Still a DSP/signal block — TX stays behind the SDR TX safety gate |
| HackRF / bladeRF modulation (TX) | ✅ done | flowgraph `soapy_sink` (HackRF / bladeRF / any SoapySDR TX) and a hackrf_transfer TX path: modulated output from any flowgraph chain (mod, analog_mod, uart_tx, files). Safety: one shared RF TX policy for all transmitters (rfcat too): lab region bands (`MAILAB_RF_REGION`) + lab-level extra bands (e.g. amateur with a licence) only a person can configure; every TX start needs approval; gain / power caps; automatic stop after a max duration; TX state visible in the UI with a kill switch |
| SDR receive in the flowgraph | ✅ | `soapy` source block; untested on hardware |
| WebSocket streams | ✅ | done: `ws-client`/`ws-server` modes for net_source/net_sink (RFC 6455 binary messages; IQ cf32/cs16/cu8 and logic u8/u16/u32/bits; ping/pong, close); jest tests with a local ws echo/feed server (src/devices/flowgraph/__tests__/netws.test.js). |
| UART in/out | ✅ | flowgraph `uart_tx` (text/hex → line levels: start/stop, parity, data bits, oversampling, repeat) and `uart_rx` (logic/analog/bits at any oversampling → bytes; parity/framing errors; value + blob + per-line `uart` log entries for classifiers). Verified 8N1/8E1/8O2, noise, fractional oversampling; regression test. Serial consoles: `serial` driver + log pane command box |
| Tables: sort, filter, export | ✅ | every SDK table: click-to-sort (numeric / engineering-notation aware, natural text, blanks last), filter box (terms, "col:text", quoted phrases, match count), CSV (RFC 4180) / JSON export of the visible rows; `objectTable` for JSON rows. Channels, devices, classifier, readings/markers (raw base units), custom `table` element, json pane `view: "table"` (e.g. sweep results), profiles, blob signatures. Logic in `src/utils/table` (jest); verified in the browser |
| USB-UART consoles (ttyUSB / ttyACM, Tigard port A, CP210x, CH340, FTDI, CDC-ACM) | ✅ | `uart` driver: port by stable identity (`match` {vid, pid, serial, product, usbPath, interface, byId}) or fixed `path`; waits while the adapter is absent and reconnects after replugs/re-enumeration; live `set` of baud / format (8N1, 7E1…) / flow / eol / display; `write`, `write_hex`, `query` (until regex); rx lines (ANSI stripped, idle-flushed prompts) → log "rx" (classifier, notifications), hex display; raw `capture_start/stop` → blob. `terminal` pane (scrollback, send with history, hex send, baud/format/eol/display). `uart_ports` tool + `/api/uart/ports` (adapter identity, by-id, which lab device uses it). Tested over a socat pty pair (jest) and live in the browser; not yet on a real Tigard/CP210x |
| Web terminal with colors (xterm.js, Dracula theme) | ✅ | `terminal` pane = xterm.js on the uart device's raw byte stream (lab `term` events over the WebSocket + 256 KB scrollback per device, `GET /api/devices/:id/term`): ANSI colors, cursor movement, TUIs; Dracula ANSI palette; raw mode sends keystrokes as typed (`write_raw`, not logged per key; the target echoes), line mode edits locally and sends on Enter with history; baud / format / eol / hex toggles; the AI still gets clean rx lines in the log. Verified: colored console output rendered in the browser, keystrokes reach the target (socat pty), jest. Line mode not yet exercised in a browser |
| Datasheet DB search + FCC ID search (MCP) | ✅ | `fccid_search` / `fccid_exhibits` / `fccid_fetch` via fccid.io (robots-allowed pages, 1.5 s spacing, cache; confidential exhibits flagged; apps.fcc.gov 403s scripts → its URL given for humans); `datasheet_search` / `datasheet_fetch` / `datasheet_find` (pinout/registers ranking) / `datasheet_page` with a local DB (pdftotext + inverted index, pdftoppm pages): keyless manufacturer probes (TI, onsemi, Diodes, Espressif, RPi), optional Mouser / Nexar / DigiKey / SearXNG via env (untested without keys); `datasheets` pane. ST, ADI, alldatasheet, LCSC refuse automated clients (not circumvented). Verified live (NE555, ESP32-WROOM-32, iPhone 4S FCC exhibits) |
| Outbound fetch SSRF guard | ✅ | the web client (datasheets, FCC ID: URLs from scraped, untrusted pages) only reaches public addresses: checked on the resolved addresses in the socket's DNS lookup (every redirect hop; names that also resolve inside are refused; no DNS-rebinding window), IP literals incl. IPv4-mapped/compatible/NAT64/6to4 (embedded IPv4 checked, any IPv6 spelling expanded)/decimal/octal/hex forms checked before connecting; loopback, RFC 1918, link-local (cloud metadata), CGNAT, ULA, multicast, reserved blocked; local mirrors via `MAILAB_HTTP_ALLOW` (hosts, CIDRs); http(s) only; non-PDF errors no longer echo response bytes. Tests incl. a real loopback server and an allowed host redirecting into the LAN |
| Media decode / encode (ffmpeg, sox) | ✅ | `src/services/media` + MCP `media_probe`, `audio_to_pcm` (→ PCM blob, optional play to the audio pane), `audio_encode` (wav/flac/mp3/ogg/opus), `video_frames` (→ lab images), `video_encode` (images → mp4/webm/gif); inputs = lab blob (upload `PUT /api/blobs/:name`) or a path inside DATA_DIR/media / `MAILAB_MEDIA_DIRS`; ffmpeg protocols file/pipe only (its tty demuxer would render any text file); sox as audio-decode fallback. Flowgraph `audio_file` source (any ffmpeg-readable audio → float samples at a chosen rate, channel select, loop, realtime or fast). The flowgraph `file` IQ source and `wav` sink are now confined to the same dirs (they read/wrote any path before); bridges get the roots from mailab, not from device options. Tested with generated audio/video round trips (jest) |
| Browser as an instrument: mic + webcam (getUserMedia, Web Audio API) | ✅ | `capture` pane → virtual `browser` device: mic via AudioWorklet (ScriptProcessor fallback) → lab audio stream `<dev>_mic` (audio pane plays it, now stereo-aware) + `<dev>_mic_level` / `_peak` dBFS channels; camera frames → `<dev>_frame` (1-10 fps, size cap), snapshot → `<dev>_snapshot`; MCP `snapshot` command asks the capturing browser (timeout); flowgraph `audio_in` block (bounded forwarding queue). Local Web Audio scope/spectrum. rw/human only, server-side caps (rate, size, fps). Verified in headless Chrome with fake media (also on master after merge); not yet on a real phone over https / Firefox / Safari |
| VNC pane + `vnc` device (remote GUIs the AI can drive) | ✅ | in-house RFB client (3.3/3.7/3.8, None + VNC auth via pure-JS DES, Raw + CopyRect, resize, clipboard): `vnc` device commands `screenshot` (→ `<id>_screen`, region), `type` (US layout, explicit shift), `key` (combos and sequences), `click`/`move`/`drag`/`scroll`, `clipboard`, `wait_change` (region, settle), reconnect with backoff; password masked in listings/activity (kept in lab.json for reconnects). noVNC pane through `/ws/vnc/<device>` (server-side auth so the password never reaches the browser; only existing vnc devices — no open proxy; Origin check; message parsing + size limits); pane keyboard/mouse is human-only (an rw AI uses device commands, which approvals can gate). Verified live against QEMU VNC with a password (AI typing/screenshots, noVNC in headless Chrome). Gaps: ZRLE/Tight for the AI side, a real Win 3.1 DPGM session (relative PS/2 mouse → prefer keyboard) |
| Hex editor (blobs) | ✅ | `hex` pane: virtual-scrolled, paged range fetch (fine on 60 MB); jump expressions (`end-0x100`, `sel`, `@addr`), selection / copy-as (hex, C, Python, base64), poke / insert / delete / fill with undo saved to the blob, search & replace (hex with ??, text ascii/utf8/utf16le, regex), data inspector with typed writes, 27 CRC variants + sums + hashes + entropy + histogram, side-by-side diff vs `compare`, bookmarks, entropy / binwalk / kaitai gutter. MCP `blob_peek` / `poke` / `patch` / `search` / `replace` / `checksum` / `slice`; REST range / PATCH / search / replace / checksum / slice / change. User regexes run in a worker thread with a 3 s limit (a catastrophic pattern can't stall the lab). Verified in the browser on 16 and 60 MB blobs. Gaps: undo is per pane and in memory; the diff is offset-by-offset (an insertion marks everything after it) |
| Pane layout: collapse, tabs, maximize | ✅ | dashboard tabs in the top bar (pane counts; click to switch, double-click to rename, + new, × removes the active tab and moves its panes); active tab per browser (localStorage) and as a link (`#tab=rf`); panes carry `tab` + `collapsed` (persisted, in profiles; older panes land on "main"); header ▾/▸ collapses to the title bar keeping the expanded height; ⇢ moves a pane to another (or a new) tab; ⤢ maximizes (Esc restores). New panes go to the active tab (UI) or `tab` (MCP `pane_add` / `pane_update`); `pane_tabs` tool + `/api/tabs` REST. Jest + browser verified. Not done: tabbed stacks inside one grid cell, drag a pane onto a tab |
| SDR level trigger | ✅ | flowgraph `level_trigger` (power squelch): gates the stream above threshold_db with pretrigger/hold, logs + counts bursts, saves each as IQ blob + envelope trace. Verified on gated GFSK bursts |
| Beamforming math | 🟡 | done: `steering(n, d, θ)`, `array_factor(n, d, steer, θ)`, `array_factor_db` (ULA, d in λ, degrees; −100 dB floor) in all math; beam patterns verified in the graph pane (dB vs angle, polar with `equal` aspect). Next: UCA, DoA (delay-and-sum, MUSIC) once multi-channel coherent SDR input exists (bladeRF 2×2, KrakenSDR) |
| PCB tracing → schematic, searchable graph, board view | 🟡 | `board` pane + `src/board`/`src/netgraph`: PDF pages (poppler render + text with positions) and photos as aligned layers (2/3-point align, mirror, rotate, opacity); trace parts/pins/wires/vias/labels/test points with snapping — nets come from the drawing (sides, mid-wire junctions, same-name labels, aliases); connectivity graph (net / pin / neighbours / shortest path avoiding GND), JSON/CSV/KiCad netlist; schematic-style graph view with click-to-highlight between views; refdes guessed from PDF text, auto pin placement, test points ↔ lab channels; MCP `board_*` incl. `board_view` crops for the AI (coordinates mapped back); delete needs approval. Verified on a real ~/rib/docs board PDF (local only). Gaps: dragging items to edit, cross-pane highlight, OCR for scanned PDFs, multi-layer crops, DM858 continuity → nets |
| Graphing calculator / matplotlib-like plots | ✅ | `graph` pane (editable expressions, range, live refresh; edits saved to the pane config) + MCP `plot` → trace (`plot` mode, canvas, matplotlib-style): functions of x, parametric `x(t); y(t)`, data expressions (`db(mag(fft(ch)))`) against index. Data expressions without samples now say so instead of plotting nothing; `ymin`/`ymax` limits and `equal` aspect (polar). Next: log scales, axis labels per series, subplots |
| Spectrum analyzer features: FFT with RBW, multiple traces, averaging | ✅ | `spectrum` sink: `rbw` → FFT size via window ENBW (actual RBW logged), windows hann/blackmanharris/flattop/rect, traces live/max/min/avg (exponential power average), `points` + peak/sample detector; verified: tone at 0 dBFS reads −0.14 dBFS |
| TCP/UDP IQ streaming in/out | ✅ | flowgraph `net_source` / `net_sink`: raw cf32/cs16/cu8 over TCP server/client or UDP, non-blocking; loopback verified (TCP cs16, UDP cu8) |
| Scope: triggered display + max/min hold + averaging | ✅ | flowgraph `scope` sink: trigger rising/falling/none, level, auto/normal, pretrigger; traces live/max/min/avg; complex input → real/imag/mag |
| Scope measurements: Vpp, Vmax, Vmin, RMS, mean, frequency, period, duty | ✅ | per capture (frequency via mid-level crossings with hysteresis); selected ones → channels `<dev>_<id>_<m>`; strip under the trace plot. Verified: 10 kHz/30 % square, 1234 Hz sine |
| libvolk | ✅ (superseded) | done the "small C helper first" step, VOLK itself not needed: modem demod vectorized in numpy (liquid per-sample ctypes loop replaced by nearest-point table search, ~50x: 19.7 ms → 0.40 ms per 20k symbols) and carrier recovery moved to an on-demand compiled C PLL via ctypes (python/native_dsp.py, ~65x: 52.6 ms → 0.81 ms; numpy fallback when no cc). No BER regression (test_modem all green, bench chain BER identical at 3.3e-02). Bench: python/bench_dsp.py |
| Optional WebGPU rendering | ✅ | waterfall + constellation panes use WebGPU when available (r32float ring texture w/ LUT in shader for waterfalls, ping-pong density accumulation w/ decay for constellations); any init failure or missing adapter falls back to Canvas2D. Shared colormap/slicing in src/utils/webgpu. Verified in headless Chrome: feature-detect + Canvas2D fallback (no WebGPU adapter on this host — navigator.gpu false in Chrome 154); hardware verification of the GPU path pending a WebGPU-capable browser |

## 4. Instruments

Per-instrument details and verification status are in [HW.md](HW.md).

| Instrument | Status | Notes |
|---|---|---|
| Miniware MDP-P906 (mdp-p906) | 🟡 | driver done, not run on hardware |
| sigrok, own libsigrok fork (Sipeed SLogic) | 🟡 | capture/decode/stream; demo driver verified |
| ISDT MP305 (pymp305) | 🟡 | pymp305==0.6.3 (published to PyPI this session; venvs with 0.5.3 auto-upgrade via pyenv `upgrade` pins); 0xC2 telemetry (no 2 s stall); DC `set_output` (+OCP / reapply), modes dc/pd/program, USB-PD `pd_profiles` / `pd_set` / `pd_output`, programs list/read/write/run/stop, info, charge_state; BLE transport (bleak installed only for ble; never run); `maxVolts` ≤ 30 / `maxAmps` ≤ 5 on setpoints, program steps and PD voltages; approvals for >5 V on, mode, PD set/output, program write/run; custom pane. Tested against a simulated HID unit (pymp305's own protocol), not on hardware |
| Rigol DM858E | ✅ | deep integration, same 4-layer architecture as the mho900 (src/devices/dm858): synced settings model (function/range/auto/NPLC {0.4|5|20}/null/calculate/trigger/beeper), intent-level set, reading monitor -> channel, screenshot; live-verified on a DM858 (10.69.2.52:5025, on the lab host's mailab) — driver runs over `transport: "ws"` (port 9004) so the front panel never locks (row 166) |
| Rigol MHO900 | ✅ | deep integration (4-layer: UI/logic/state/sync-SCPI in src/devices/mho900/): synced settings model (channels/timebase/trigger/acquire/AWG), intent-level `set` with read-back, `watch` pushes trace+screen on every trigger, capture/measure/snapshot. Verified live on MHO98 (= patched MHO900) at 10.69.1.89:5555; settings pane in the UI; auto-sync every 30 s (autoSyncMs/autoSync options) |
| MHO900 signal generator | ✅ | part of the settings model (`awg` section, `:SOURce<n>:VOLTage:AMPLitude/OFFSet`, `:OUTPut:STATe`); verified live: G1→CH1 loopback 1 MHz/1 Vpp set → 1.000 MHz/1.05 Vpp measured |
| DeepAce KC9531B | 🟡 | |
| Icom CI-V (ci-v) | 🟡 | cloned to `~/ci-v`, packaged as **icom-ci-v** (npm refused `ci-v` as too similar to `civ`). npm shows the staged `0.0.0-stage`, waiting for publish approval on npmjs.com |
| tinySA / tinySA Ultra | 🟡 | `tinysa` driver (USB serial shell): sweep/scan → `spectrum` trace (dBm), configurable start/stop/points/RBW, markers → readings, calibration/level output, device info; hardened from the actual firmware shell (`scanraw`, `data`, `sweep`, `marker`). Ultra vs basic differences handled. Untested on hardware |
| NanoVNA (H / H4, shell protocol) | 🟡 | `nanovna` driver (USB serial `ch> ` shell, distinct from the binary `litevna`): sweep plan, scan -> S11/S21 logmag+phase traces, raw `data 0|1` complex pairs, `cal` state; PTY tests; [HW] untested on hardware |
| Othernet Morfeus RF siggen | ✅ | `morfeus` driver, LIVE-VERIFIED: USB HID (10c4:eac9, /dev/hidraw 16-byte reports — enumerates as "EFM8UB1 Bootloader" in lsusb even in app mode; the app runs, LCD alive). freq 30M-6G, mixer/generator mode, mixer current 0-7, bias-T, frequency override (undocumented param 0x87, LCD-confirmed), LCD backlight (0x85, unverified), sweeps. TX actions policy-gated (generator mode / sweep / max current need a person). Bridge: python/morfeus_bridge.py (no pip deps, fake-mode tests) |
| LiteVNA 64 | 🟡 | protocol from docs |
| HackRF / bladeRF | ✅ | hackrf_sweep + hackrf_transfer TX (txpolicy-gated), soapy bridge (bladeRF/RTL-SDR FFT + peak channels), flowgraph soapy source + soapy_sink (TX policy gated) |
| Proxmark3 / Proxmark5 (node-proxmark3) | ✅ | runs on the lab's PM5 (AT32F437, Iceman firmware from ~/pm5-og): `PM3_CLIENT` defaults to ~/pm5-og/client/proxmark3 when built; `match` {serial} picks the Proxmark by USB serial; start timeout kills a client that never starts. node-proxmark3 0.0.12 on npm lacks json.lua (ignored via .gitignore) → mailab adds a LUA_PATH shim (dkjson); fixed upstream in node-proxmark3 8a33621 (0.0.13, not yet published to npm) |
| PicoGlitcher (findus) | 🟡 | |
| nRF52840 modem | 🟡 | ESB bridge driver (src/devices/esb, commit 4f2a3ff): configure ch/addr, send with auto-ACK + replies, listen windows, stats, UF2 bootloader; fake-bridge PTY tests. Firmware (~/mdp-p906/bridge, PlatformIO) builds with `pio run`; wire protocol untested, no bridge attached [HW] |
| InfiRay P2 Pro thermal camera | 🟡 | `infray` driver via ffmpeg v4l2: single frames + stream -> image feed (works with generic UVC too); [HW] untested with the P2 Pro |
| Bus Pirate | 🟡 | classic binary mode driver (src/devices/buspirate): BBIO1 entry, I2C/SPI/UART/1-Wire/raw sub-modes, power/pullups/AUX/CS, ADC + freq channels, PWM, bulk transfers; PTY-tested; [HW] untested on hardware |
| XGecu programmers (minipro) | 🟡 | `minipro` driver: presence, info, search, read_id, autodetect, read (→ blob + EEPROM blob + fuses value), verify, write, erase, blank/pin check (write/erase need approval). info/search/presence run for real; read_id/autodetect formats unverified on hardware (the programmer is on `lab`) |
| Glasgow | 🟡 | CLI driver (src/devices/glasgow): device list (serial/rev/firmware), applet discovery, `run {applet, args}` with output -> log; fake-CLI tests; [HW] untested with a board |
| RTL-SDR | 🟡 | via `soapy` driver / flowgraph `soapy` source with `driver=rtlsdr`. `rtl_power` driver (rtl_power / soapy_power → `<id>_spectrum` trace + peak channels; range, bin, gain, interval, ppm, crop, offset): parser + fake-tool tested, no dongle attached yet; soapy_power args unrun. Planned: `rtl_tcp` interop |
| Harogic HTRA spectrum analyzer | 🟡 | `harogic` driver: sweep → `spectrum` trace via vendor `libhtraapi` (ctypes, struct layouts checked against `htra_api.h` with the C compiler). Library from SAStudio4 on `lab` (desktop shortcut → `~/sastudio/SAStudio4_x86_64_4.4.55.50`). Device not on `lab`'s USB at the time; not run yet. Next: IQ streaming (IQS) as a flowgraph source |
| DeepAce KC901K / KC908V | 🟡 | generic framed driver (src/services/deepace + src/devices/kc901): 0xFE/0xFF frames with sum16 checksum, request/trace_f32 commands, f32 sweeps -> spectrum trace. Vendor command codes unpublished; wire protocol unverified on hardware [HW]. KC908V needs the vendor FTD3XX backend [HW] |
| ThunderScope | 🟡 | TS.NET dual-TCP driver (src/devices/thunderscope): SCPI control plane (credit mode, seq acks) + binary waveform frames (i8/i16, fs timestamps) -> traces; fake-server tests; [HW] untested on hardware |
| NanoKVM / NanoKVM+ (Sipeed) | ✅ | driver (src/devices/nanokvm): HDMI screen + HID (keyboard/mouse/absolute+relative) + ATX power/reset + virtual media over the KVM's HTTP/WebSocket API; `kvm` pane (MJPEG + input via src/web/kvm); same command surface as `vnc` plus power/stream settings; protocol pinned to sipeed/NanoKVM 2.5.4 sources; jest-tested with a fake KVM [HW] live test pending |
| JTAGulator | 🟡 | serial menu driver (src/devices/jtagulator): transcript `menu` + voltage/JTAG/IDCODE/UART scan wrappers; menu letters best-effort [HW] |
| J-Link | 🟡 | interactive JLinkExe CLI driver (src/devices/jlink): connect/halt/go/reset, mem32/mem8 read → blobs, w4 writes (little-endian packed), loadfile flash, regs, RTT → log; fake-CLI tests; [HW] untested on a probe |
| OpenOCD | ✅ | driver over the telnet port (src/devices/openocd): targets, regs, mem read → blobs, writes, flash erase/program, spawn with free-form adapter args (e.g. Tigard port B) |
| Black Magic Probe | 🟡 | GDB RSP driver (src/devices/bmp + src/services/gdbrsp): monitor (qRcmd) swdp_scan/jtag_scan/attach/reset, halt (interrupt)/resume/step, memory read -> blobs, writes, registers; [HW] untested on the bench |
| flashrom | ✅ | `flashrom` driver: probe, read (→ blob), verify, write, erase (write/erase need approval); verified against flashrom's dummy programmer (emulated W25Q128) in jest and over MCP; no real programmer yet |
| XGecu (minipro) | 🟡 | see above |
| binwalk | ✅ | `blob_analyze` + blob pane: signatures (offset/type/size/description) from binwalk 3 JSON. Next: extraction |
| `file` (libmagic) | ✅ | type + MIME in `blob_analyze` and the blob pane |
| File & bitstream entropy | ✅ | sliding-window Shannon entropy → trace `<blob>_entropy` + plot; high/low regions with a window-aware threshold (small-window bias); bit streams via the bitview/framer blobs |
| Tigard | ✅ | port A UART -> `uart` driver (row 97); port B JTAG/SWD via `openocd` driver (row 150, free-form adapter args); SPI flash via `flashrom` ft2232_spi; voltage select is a physical jumper [HW] |
| CatSniffer V3 (Electronic Cats) | 🟡 | driver (src/devices/catsniffer): firmware flash via cc2538-bsl wrapper, sniff bridges (Sniffle/802.15.4/sub-GHz) with packets -> events + rssi channel + PCAP blob, raw UART console; fake-bridge tests; [HW] flasher cmdline + bridge protocol unverified |
| USB tree view with hub power toggles | ✅ | `usb` pane + `usb_tree` / `GET /api/usb`: inventory ported from proxyslave's logic (`src/inventory/usb`: PCI controllers by class → buses → ports from sysfs names, interfaces with bound drivers, network interfaces + IPv4, hub port count from `-port` entries, usb.ids/pci.ids names, speed); plus /dev nodes (tty, video, hidraw) and which lab device uses each node. Empty ports are shown only on switchable hubs |
| USB hub power control (uhubctl) | ✅ | on/off/cycle toggles on ppps hubs; `usb_power` MCP tool needs a person's approval (default policy); REST only for the human role; inputs validated. uhubctl missing → the pane says so. Not run against a real ppps hub yet |
| udev-like notifications (in-app rules) | ✅ | not system udev: `udev_rule_add` / `udev_rules` / `udev_rule_remove` (+ REST `/api/udev`, form in the usb pane). USB inventory polled every 2 s; add / remove / change (drivers or /dev nodes bound) events matching a rule (globs on vid, pid, product, manufacturer, serial, driver, node, path) raise `{type: "udev"}` lab notifications, pushed to MCP sessions (the creating session is subscribed automatically; `subscribe` types `udev`, filter `rule`) and shown in the UI. Rules are part of lab state/profiles |
| GPU / system monitor (nvtop-like) | ✅ | `sysmon` driver: CPU, memory, swap, hwmon temperatures, NVIDIA (nvidia-smi: load, VRAM, temp, power) and AMD GPUs (sysfs; fixture-tested only). Verified on this PC (RTX 5080) |
| ChipWhisperer Husky | 🟡 | python bridge (python/chipwhisperer_bridge.py + src/devices/chipwhisperer): gain/clock/decimate/IO pins, capture -> trace <id>_wave + float32 blob; simulated-scope tests (MAILAB_CHIPWHISPERER_FAKE=1); chipwhisperer==6.0.1 installs on first use; glitching + [HW] untested on a Husky |

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
Docker, Harogic, net IQ, spectrum analyzer traces, triggered scope + measurements, Kaitai, findus map, collaboration
(tokens, sessions, chat, channel push), auth hardening, esbuild + qrp + GUI SDK, modem toolkit (all QAM sizes, FSK family, BER, framing), graphing calculator.

Next:
1. In progress (agents): SDR TX, NanoVNA/tinySA (torch 2.15.0+cu134 is in the managed venv); OFDM + flowgraph block docs done
2. Finish the qrp/SDK migration of the remaining panes; recordings pane; sweep heatmap
3. MHO900 siggen
4. Drivers: nRF52840 modem, Bus Pirate, Glasgow, ChipWhisperer Husky, InfiRay P2 Pro, JTAGulator, J-Link, BMP, OpenOCD, Tigard (port B), CatSniffer, NanoKVM, ThunderScope, KC901K/KC908V
5. PCB tracing tool (PDF/photo background → traced connectivity → schematic graph + board view; ~/rib/docs sample); datasheet + FCC ID search MCP
6. Shared terminals (shell-session-mcp), protokai, OpenCV, analog video, journal, timebase, ngscopeclient-style decoders, beamforming DoA
7. Harogic IQ source; MHO900 VXI-11; WebSocket streams; WebGPU; native hot loops (then VOLK)
8. Deployment on `lab`: waiting on your decision

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
76. reviewer: auth bypass via inherited object keys (constructor/__proto__/toString), role check should require rw, Docker HOST=0.0.0.0 open by default, no Origin check (DNS rebinding)
77. build different mod, demod tools 2fsk, qam64, ook... ber, constellation, sync, clock recovery, bit stream...
78. support all common modulations
79. libsigrokdecode for external inputs
80. opencv, analog video decode
81. jtagulator, jlink, openocd, blackmagicprove, flashrom, minipro, binwalk, file and bitstream entropy
82. all different qam sizes
83. reviewer: fixes confirmed on a live server; ?token= in URLs leaks into history/proxy logs
84. matplotlib like feature, graphing calc
85. reviewer ideas: server-enforced safety rules, approve-in-UI, generic sweep/optimize, one timebase, record/replay device, evidence-tagged journal, binary diff
86. reviewer: stray `__tests__.tmp` committed; test_modem.py not run by pytest or the pre-commit hook
87. update spec
88. fix it all, update screenshot
89. sdr level trigger
90. update screenshot and readme
91. tablet interface (input field, on click opens popover, click digit input and units, e.g. dBm)
92. modal that gives help on how to add as mcp
93. ngscopeclient decoders and blocks
94. reviewer: read-only users can redefine math (createUnit); zeros(30000,30000) could exhaust memory
95. uart in/out
96. goal: implement everything from spec and test everything you can (write tests and manual verify)
97. configurable mcp notifications for things like triggers, uart/cli line, like diversity classifier; diversity-classifier-like recording and plotting
98. grafana like different timeframe longterm recordings of trends, like battery charging
99. update spec
100. catsniffer v3 fw and bridges (electroniccats.com/store/catsniffer-v3)
101. beamforming math
102. boardview like interface for pcb analysis, where something like pdf can be imported and drawn on, to trace schematics
103. use ~/rib/docs PCB schematics as the sample for schematic and boardview reconstruction
104. tigard
105. update spec
106. reviewer: rule actions skip approval; restored locked rule replaceable via id collision; rule eval errors silent; same-machine agent can approve itself
107. python headers for ui sdk elements, so it can build custom panes
108. python venv?
109. mailab managed (venv)
110. usb tree view, like ~/projects/proxyslave, with togglable power hub toggles
111. you made a typo? (a test lab.json committed under an ANSI-escaped directory name: removed, DATA_DIR guarded)
112. seriazable lab state, savable and loadable
113. just rm and commit, no history alteration (for the stray test file)
114. update spec
115. reviewer: pin the drivers' Python requirements to versions
116. not from scratch: port the USB inventory logic from ~/projects/proxy/slave
117. udev notifications: the AI can define "udev rules" (in-app, not real udev rules) to be notified on specific USB events
118. make sure to update spec with any of my requirements
119. use agents to do features in parallel
120. when I said uart, I meant usb to uart, tigard... ttyUSB / ttyACM
121. ~/pm5-og: the Proxmark5 (Iceman tree, PM5 platform) client + firmware; the lab's proxmark on ttyACM0 is a PM5
122. table sort, filter, export to csv and json
123. fix node-proxmark3 to publish lua (json.lua) too
124. webterm, so it supports colors
125. xterm dracula theme
126. reviewer: the AI can overwrite a trusted profile (e.g. maxVolts 30 under a bench-safe name) → overwriting is human-only on REST and needs approval over MCP, with a diff; load confirmations show a diff too
127. reviewer: pins only apply to fresh installs (import check) → intended (system numpy/SoapySDR not shadowed); mismatches are now logged
128. not really boardview: a tool to import a pdf as background and trace over traces, to recreate the schematic, a searchable graph and a pcb board view
129. datasheet db search mcp? fccid search?
130. update spec
131. audio file reader, to raw pcm?
132. audio/video decoder/encoder? sox? ffmpeg?
133. webaudioapi
134. webcam input from browser?
135. reviewer: the overwrite approval's diff was computed at request time but save() exported the state after approval (up to 2 min later) → the approved snapshot is what gets saved
136. vnc pane, good example why is ~/rib (old Windows 3.1 radio programming software in an emulator)
137. hex editor, peek, poke, bin diff, binary calcs... search replace, view... jump...
138. panes should be collapsable, organized in tabs, etc.
139. opencv
140. audio dsp, notch, filtering, nvidia ai denoise, realtime
141. compress (audio dynamics)
142. install torch, venv
143. reviewer: the new HTTP client reached the LAN (datasheet_fetch to 127.0.0.1 hit /admin/config; error echoed 16 bytes) → SSRF guard in the DNS lookup on every hop, allow-list for mirrors
144. https://github.com/nemanjan00/pymp305 (again: GitHub 0.6.3 vs PyPI 0.5.3 → update the driver)
145. reviewer: SSRF fix holds (every internal spelling blocked); gap: 6to4 2002::/16 embedding 127.0.0.1 counted as public → embedded IPv4 checked
146. yes to both (publish pymp305 0.6.3 to PyPI, node-proxmark3 0.0.13 to npm)
147. rfcat
148. update screenshot and docs
149. cynthion, luna
150. qrp good for this? (answered: yes for the shell; keep hot paths imperative; proposed raw/shallow state, append-friendly lists, scheduler, thunk warnings)
151. yes: fix the pymp305 issues found (program end marker, frame length wrap, BLE parity, set_output mode switch) and release 0.6.4
152. make docs for each block, with screenshot and use example; docs/ markdowns, dir per block
153. reviewer: torch install could pick PyPI's CPU 2.15.0 and resolve unpinned deps across two indexes → torch==2.15.0+cu134, --index-url for that step, constraints file with the exact dependency closure
154. nanokvm+ from sipeed
155. you need sdr tx
156. cool demo: craft wifi beacon bytes, modulate, view IQ/spectrum (loopback, not TX) — committed as demos/beacon-to-iq
157. with screenshot
158. commit that demo
159. oh, use real wifi modulation (OFDM, not single-carrier QAM256)
160. all-safety-bypass mode for a non-persistent env in an RF chamber
161. nanovna, tinysa
162. https://www.crowdsupply.com/othernet/morfeus (dual-channel RF signal generator)
161. reviewer: 2.4 GHz isn't in any REGIONS band, so a bladeRF Wi-Fi TX is refused by default — confirmed INTENDED. 2.4 GHz ISM is unlicensed but a raw SDR there interferes with certified Wi-Fi/BLE, so it stays out of the default allow-list; reach it only via operator-set MAILAB_RF_TX_EXTRA (2400M-2483.5M) or chamber bypass, rationale documented
163. html5 tab navigation ✅ — tabs are real URLs (/tab/<name>), back/forward works, deep links + reload serve the app; sign-out button clears the token (no more ?token= lingering)
164. CachyOS install with all deps, fullscreen web page as the DE (kiosk), whole PC an MCP host; ISO builder in os/ (subdir, parallel agent) — reference: lab host 10.69.1.91 + ~/lab/shack-ansible
165. RIGOL Web Control live screen + remote control ✅ — `rigol` driver (front-panel input injection over ws://host:9002: tap/touch/swipe/key; dom dialect onmouse* default for both DM858 + MHO98, rigol CONTROL_KEY_* kept; control session releases 3 s idle so the meter's front-panel remote lockout disengages) + `rigol` pane (the instrument's own H.264 player on ws://host:9001 with the SET_ENCODER handshake the MHO98 needs, native 1024x600 click mapping, view-only, reconnects). LIVE-VERIFIED on both the DM858 and the MHO98: video + injected clicks (meter UI visibly responded)
166. SCPI over the instrument's WebSocket command channel ✅ — src/services/scpiws (hex text frames = binary-safe IEEE blocks; greeting consumption; serialized; self-heals by reconnecting before the next exchange after a drop — the channel is single-seat and idle-times out); scpi driver `transport: "ws"` option (tcp default | usbtmc | ws). KEY FINDING: the DM858 locks its front panel ("remote mode") while a raw TCP SCPI session (5025) is open, but the WS channel (9004) drives the identical SCPI grammar WITHOUT locking — verified live
167. dm858 over ws:9004 ✅ — settings model, readings monitor, and screenshots all ride the WebSocket channel on the bench + lab instances; front panel never locks; 4 fake-server tests + live verification
168. mp305 on the lab host ✅ — verified live (telemetry, DC control surface); the full pymp305 GUI feature set (charge config/control, PDO select, current-over, energy reset, remote hold) is exposed as driver commands; 🟡 the rich control pane matching the desktop GUI's layout is in progress


## Lab host

mailab runs on the lab host (nemanjan00@10.69.1.91) in a detached tmux
session (`mailab`), cloned at ~/mailab, listening on 0.0.0.0:3000 with
MAILAB_TOKENS (viewer ro + ai rw) — pi reaches it as an MCP server via a
Bearer header. Local devices enumerated and live: DM858 multimeter
(10.69.2.52:5025, id `dmm`, deep integration verified live) and the
nRF52840 ESB bridge (Adafruit Feather at /dev/ttyACM0, id `esb`, firmware
config query verified). The MHO98 scope (10.69.1.89:5555) is driven from
the bench host instead, to avoid two controllers polling it at once.
