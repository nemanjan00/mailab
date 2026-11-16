# mailab

MCP server + live web UI for a hardware lab the AI operates. See README.md
(usage), HW.md (per-instrument status and TODO).

**Always use the /implement-js skill when writing JS here.**

## Layout

- `src/index.js`: web entry (lab + UI + `/mcp` on one port)
- `src/lab`: core state. Devices → channels / traces / images / logs; derived math; panes; activity; persistence (`data/lab.json`)
- `src/devices/<driver>`: one module per driver, registered in `src/devices/index.js`
  - `process`: JSON-lines helper protocol; `pythonPreset` for bundled bridges in `python/`
  - `scpi`: generic SCPI plus `preset()` (dm858, mho900)
- `src/services/tty`: raw serial "socket" (write / on("data")). Use it instead of node-serialport, which delivers reads late on Node 26 (found in mdp-p906)
- `src/services/scpi`: TCP / usbtmc SCPI client with IEEE block parsing
- `src/mcp`: MCP tools (identity-aware, read-only gating); every call is recorded via `lab.recordActivity`. `sessions.js`: stateful Streamable HTTP sessions (stateless fallback), `notifyAll` for push
- `src/auth`: optional `MAILAB_TOKENS` (name:token:rw|ro), used by REST, `/mcp` and `/ws`
- `src/batch`: multi-call scripts with ~1 ms timing (the `batch` tool)
- `src/kaitai`: server-side .ksy compile (debug mode) + parse → tree + byte ranges
- `src/utils/args`: strict parsing for anything that switches hardware (`parseSwitch`, `parseNumber`); python side: `parse_switch`
- `bin/channel.js`: stdio MCP "channel" bridge pushing lab chat into Claude Code (channels are stdio-only)
- `src/web`: express REST (`/api`), WebSocket push (`/ws`), stateless Streamable HTTP MCP (`/mcp`)
- `public/`: browser ES modules (no build). `app.js` handles grid, state and ws; `panes/<type>.js` export `{mount(body, pane, ctx)}`
- `python/`: `mailab_bridge.py` helper protocol (sample/trace/point/value/blob/audio/options), device bridges, `liquid_dsp.py` (ctypes, stateful blocks), `flowgraph_bridge.py` (GNU Radio-style blocks: sources, DSP, sinks; `python` block = scriptable), `harogic_bridge.py` (vendor lib via ctypes; layouts checked against the header)

## Data model

channels (time series) · traces (x/y arrays; modes line/step/scatter/constellation/eye; optional `measurements`) · images · values (JSON) · blobs (binary) · audio streams · chat · activity

## Planning

SPEC.md lists every request with its status; update it as soon as a request comes in. HW.md is the per-instrument hardware TODO.

## Conventions

- Channel names are `<deviceId>_<field>` and must match `[A-Za-z_][A-Za-z0-9_]*` (mathjs symbols)
- New pane type: add it to `TYPES` in `src/panes`, write `public/panes/<type>.js`, register it in `public/app.js`
- ESLint 10 flat config (`eslint.config.js`): same rules as the usual `.eslintrc.json`
- External libs that aren't on npm (mdp-p906 host, ci-v) load from configurable paths (`MDP_HOST_PATH`, `CIV_PATH`)
- husky hooks are active (yarn ran `prepare`); commits run lint-staged + jest
- Vendor SDK files (e.g. `htra_api.h`) never go into the repo; bind via ctypes from layouts
- Never touch the MHO900's port 55555 (that's root ADB, not SCPI)

## Verify UI changes

Start a server on a spare port with a temp `DATA_DIR`, populate it through
`/mcp`, and screenshot it with headless Chrome via CDP (console errors
included). `google-chrome-stable` is available.
