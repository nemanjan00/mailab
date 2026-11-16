{
  "version": 3,
  "id": "mwjvy5ad-5v0qub",
  "objective": "Implement every ⬜ (not-started) row in SPEC.md to working code with tests, finishing the in-flight OFDM restore first, and update SPEC.md status/notes per row; physical hardware verification stays noted as pending where devices are unreachable. Includes an env-only full-safety bypass for the isolated RF chamber / non-persistent image.",
  "status": "active",
  "autoContinue": true,
  "usage": {
    "tokensUsed": 55473,
    "activeSeconds": 313
  },
  "sisyphus": false,
  "createdAt": "2026-11-16T23:19:23.461Z",
  "updatedAt": "2026-11-16T23:24:41.753Z",
  "activePath": ".pi/goals/active_goal_2026111700192346_mwjvy5ad-5v0qub.md",
  "revision": 21,
  "scheduler": {
    "version": 1,
    "owner": "01a1e6a2-9c12-7475-b659-f9e88d40c92e",
    "generation": "200d3183-76c8-4303-9a3b-f541c36c4a74",
    "used": 1,
    "phase": "idle",
    "repairUsed": false
  },
  "taskList": {
    "tasks": [
      {
        "id": "ofdm-finish",
        "title": "Finish OFDM restore: jest block-docs green, demo runs, screenshot regenerated, block docs, commit + push",
        "status": "pending",
        "verificationContract": "Full jest run passes; python3 demos/beacon-to-iq/beacon.py runs against a live mailab; demos/beacon-to-iq/screenshot.png regenerated; docs/blocks/ofdm_mod + ofdm_demod (about.md + example.json) with yarn block-docs / block-shots; committed and pushed to master"
      },
      {
        "id": "rf-chamber",
        "title": "RF chamber / UNSAFE env bypass for ALL safety (TX allow-list, approvals, device limits) — isolated chamber + non-persistent image, RF <10 dBm",
        "status": "pending",
        "verificationContract": "Env-only flag (e.g. MAILAB_RF_CHAMBER / MAILAB_UNSAFE) lifts the RF TX band allow-list, per-TX approvals and device safety limits; persistent loud UI banner + safety_overview/activity marking on every line; still records all actions; PSU hardware-damage limits optionally kept via independent opt-out; tests; SPEC.md row updated"
      },
      {
        "id": "rf-tx-safety",
        "title": "Shared RF TX policy + soapy_sink/hackrf_transfer TX path",
        "status": "pending",
        "verificationContract": "One shared TX policy (MAILAB_RF_REGION bands + person-configured extras, per-TX approval, gain/power caps, auto-stop, UI TX state + kill switch) used by soapy_sink and rfcat; tests; SPEC.md rows (HackRF/bladeRF TX, hardware-safety TX gap) updated"
      },
      {
        "id": "modem-dsp",
        "title": "Modem/demod gaps: FSK/GFSK demod, baud estimation, bit/packet output, BLE/ESB decoding",
        "status": "pending",
        "verificationContract": "Flowgraph blocks implemented with BER/known-vector tests via fake transport; docs/blocks entries; SPEC.md demod row updated"
      },
      {
        "id": "ws-streams",
        "title": "WebSocket streams: ws-client/ws-server modes for net_source/net_sink",
        "status": "pending",
        "verificationContract": "Both modes stream IQ and data; jest tests with a local ws echo server; SPEC.md row updated"
      },
      {
        "id": "timebase",
        "title": "One timebase across instruments (sync pulse alignment)",
        "status": "pending",
        "verificationContract": "Samples align to a shared reference within stated tolerance; tests with fake devices; SPEC.md row updated"
      },
      {
        "id": "journal",
        "title": "Experiment journal with evidence tags",
        "status": "pending",
        "verificationContract": "Batch/run records options+setpoints+data; notes link to data with tags; persisted; tests; SPEC.md row updated"
      },
      {
        "id": "shell-terminals",
        "title": "Shared terminals: shell-session-mcp shell device + terminal pane",
        "status": "pending",
        "verificationContract": "PTY sessions (bash/gdb/openocd/serial) as a shell device, terminal pane (xterm.js), output pushes; fake-PTY test; SPEC.md row updated"
      },
      {
        "id": "protokai",
        "title": "protokai (.proto → .ksy) in the Kaitai view",
        "status": "pending",
        "verificationContract": "kaitai pane / kaitai_parse accept .proto via protokai (multi-file as supported); test with a sample .proto; SPEC.md row updated"
      },
      {
        "id": "analog-video",
        "title": "Analog video decode (PAL/NTSC composite → image frames)",
        "status": "pending",
        "verificationContract": "H/V sync detection + line assembly from IQ samples → image pane frames; synthetic-frame test; SPEC.md row updated"
      },
      {
        "id": "ngscopeclient",
        "title": "ngscopeclient/libscopehal decoders & blocks reuse",
        "status": "pending",
        "verificationContract": "Named decoders (CDR/PLL, TIE/jitter, 8b10b, Manchester, buses) available in flowgraph decode path where feasible; tests on synthetic vectors; SPEC.md row updated"
      },
      {
        "id": "dsp-perf",
        "title": "Move hot Python loops out of per-sample Python (libvolk or numpy vectorization)",
        "status": "pending",
        "verificationContract": "Carrier recovery / modem demod hot paths vectorized or VOLK-bound; no regression in BER tests; benchmark note in SPEC.md"
      },
      {
        "id": "webgpu",
        "title": "Optional WebGPU rendering (density/persistence RTSA, big constellations, waterfalls)",
        "status": "pending",
        "verificationContract": "Progressive enhancement with Canvas2D fallback; feature-detected; verified in headless Chrome where supported; SPEC.md row updated"
      },
      {
        "id": "drivers-rf",
        "title": "RF/signal drivers: MHO900 siggen preset, nRF52840 ESB modem, DeepAce KC901K/908V, HackRF/bladeRF completion",
        "status": "pending",
        "verificationContract": "Drivers implemented per existing driver conventions with fixture/fake tests; hardware-needed parts noted pending in SPEC.md"
      },
      {
        "id": "drivers-bench",
        "title": "Bench/RE drivers: InfiRay P2 Pro, Bus Pirate, Glasgow, ThunderScope, NanoKVM, JTAGulator, J-Link, OpenOCD, Black Magic Probe, Tigard, CatSniffer V3, ChipWhisperer Husky, SLogic libsigrok fork",
        "status": "pending",
        "verificationContract": "Each driver implemented per conventions with fake/fixture tests; unreachable hardware noted pending in SPEC.md"
      },
      {
        "id": "lab-host",
        "title": "Run on the lab host nemanjan00@10.69.1.91 (best-effort)",
        "status": "pending",
        "verificationContract": "mailab runs on the lab host with its local devices enumerated, or the blocker is documented in SPEC.md"
      },
      {
        "id": "final-sweep",
        "title": "Final SPEC.md sweep: every row status updated, full test suite green, push",
        "status": "pending",
        "verificationContract": "yarn test (husky) passes; grep confirms no remaining ⬜ rows except those explicitly documented as pending-on-hardware; all commits pushed to master"
      }
    ],
    "blockCompletion": false,
    "proposedAt": "2026-11-16T23:19:04.361Z"
  },
  "currentTaskId": "ofdm-finish"
}

# Goal Prompt

Implement every ⬜ (not-started) row in SPEC.md to working code with tests, finishing the in-flight OFDM restore first, and update SPEC.md status/notes per row; physical hardware verification stays noted as pending where devices are unreachable. Includes an env-only full-safety bypass for the isolated RF chamber / non-persistent image.

## Progress

- Status: running
- Auto-continue: on
- Sisyphus mode: no
- Time spent: 5m13s
- Tokens used: 55K (55,473) tokens
## Tasks

<!-- blockCompletion: false -->
- [ ] ofdm-finish: Finish OFDM restore: jest block-docs green, demo runs, screenshot regenerated, block docs, commit + push — contract: Full jest run passes; python3 demos/beacon-to-iq/beacon.py runs against a live mailab; demos/beacon-to-iq/screenshot.png regenerated; docs/blocks/ofdm_mod + ofdm_demod (about.md + example.json) with yarn block-docs / block-shots; committed and pushed to master
- [ ] rf-chamber: RF chamber / UNSAFE env bypass for ALL safety (TX allow-list, approvals, device limits) — isolated chamber + non-persistent image, RF <10 dBm — contract: Env-only flag (e.g. MAILAB_RF_CHAMBER / MAILAB_UNSAFE) lifts the RF TX band allow-list, per-TX approvals and device safety limits; persistent loud UI banner + safety_overview/activity marking on every line; still records all actions; PSU hardware-damage limits optionally kept via independent opt-out; tests; SPEC.md row updated
- [ ] rf-tx-safety: Shared RF TX policy + soapy_sink/hackrf_transfer TX path — contract: One shared TX policy (MAILAB_RF_REGION bands + person-configured extras, per-TX approval, gain/power caps, auto-stop, UI TX state + kill switch) used by soapy_sink and rfcat; tests; SPEC.md rows (HackRF/bladeRF TX, hardware-safety TX gap) updated
- [ ] modem-dsp: Modem/demod gaps: FSK/GFSK demod, baud estimation, bit/packet output, BLE/ESB decoding — contract: Flowgraph blocks implemented with BER/known-vector tests via fake transport; docs/blocks entries; SPEC.md demod row updated
- [ ] ws-streams: WebSocket streams: ws-client/ws-server modes for net_source/net_sink — contract: Both modes stream IQ and data; jest tests with a local ws echo server; SPEC.md row updated
- [ ] timebase: One timebase across instruments (sync pulse alignment) — contract: Samples align to a shared reference within stated tolerance; tests with fake devices; SPEC.md row updated
- [ ] journal: Experiment journal with evidence tags — contract: Batch/run records options+setpoints+data; notes link to data with tags; persisted; tests; SPEC.md row updated
- [ ] shell-terminals: Shared terminals: shell-session-mcp shell device + terminal pane — contract: PTY sessions (bash/gdb/openocd/serial) as a shell device, terminal pane (xterm.js), output pushes; fake-PTY test; SPEC.md row updated
- [ ] protokai: protokai (.proto → .ksy) in the Kaitai view — contract: kaitai pane / kaitai_parse accept .proto via protokai (multi-file as supported); test with a sample .proto; SPEC.md row updated
- [ ] analog-video: Analog video decode (PAL/NTSC composite → image frames) — contract: H/V sync detection + line assembly from IQ samples → image pane frames; synthetic-frame test; SPEC.md row updated
- [ ] ngscopeclient: ngscopeclient/libscopehal decoders & blocks reuse — contract: Named decoders (CDR/PLL, TIE/jitter, 8b10b, Manchester, buses) available in flowgraph decode path where feasible; tests on synthetic vectors; SPEC.md row updated
- [ ] dsp-perf: Move hot Python loops out of per-sample Python (libvolk or numpy vectorization) — contract: Carrier recovery / modem demod hot paths vectorized or VOLK-bound; no regression in BER tests; benchmark note in SPEC.md
- [ ] webgpu: Optional WebGPU rendering (density/persistence RTSA, big constellations, waterfalls) — contract: Progressive enhancement with Canvas2D fallback; feature-detected; verified in headless Chrome where supported; SPEC.md row updated
- [ ] drivers-rf: RF/signal drivers: MHO900 siggen preset, nRF52840 ESB modem, DeepAce KC901K/908V, HackRF/bladeRF completion — contract: Drivers implemented per existing driver conventions with fixture/fake tests; hardware-needed parts noted pending in SPEC.md
- [ ] drivers-bench: Bench/RE drivers: InfiRay P2 Pro, Bus Pirate, Glasgow, ThunderScope, NanoKVM, JTAGulator, J-Link, OpenOCD, Black Magic Probe, Tigard, CatSniffer V3, ChipWhisperer Husky, SLogic libsigrok fork — contract: Each driver implemented per conventions with fake/fixture tests; unreachable hardware noted pending in SPEC.md
- [ ] lab-host: Run on the lab host nemanjan00@10.69.1.91 (best-effort) — contract: mailab runs on the lab host with its local devices enumerated, or the blocker is documented in SPEC.md
- [ ] final-sweep: Final SPEC.md sweep: every row status updated, full test suite green, push — contract: yarn test (husky) passes; grep confirms no remaining ⬜ rows except those explicitly documented as pending-on-hardware; all commits pushed to master

