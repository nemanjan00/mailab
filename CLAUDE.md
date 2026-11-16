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
- `src/mcp`: MCP tools; every call is recorded via `lab.recordActivity`
- `src/web`: express REST (`/api`), WebSocket push (`/ws`), stateless Streamable HTTP MCP (`/mcp`)
- `public/`: browser ES modules (no build). `app.js` handles grid, state and ws; `panes/<type>.js` export `{mount(body, pane, ctx)}`
- `python/`: `mailab_bridge.py` helper protocol, device bridges, `liquid_dsp.py` (ctypes)

## Conventions

- Channel names are `<deviceId>_<field>` and must match `[A-Za-z_][A-Za-z0-9_]*` (mathjs symbols)
- New pane type: add it to `TYPES` in `src/panes`, write `public/panes/<type>.js`, register it in `public/app.js`
- ESLint 10 flat config (`eslint.config.js`): same rules as the usual `.eslintrc.json`
- External libs that aren't on npm (mdp-p906 host, ci-v) load from configurable paths (`MDP_HOST_PATH`, `CIV_PATH`)
- Don't run `husky` / `yarn install` just to set up hooks: they write `core.hooksPath` to git config

## Verify UI changes

Start a server on a spare port with a temp `DATA_DIR`, populate it through
`/mcp`, and screenshot it with headless Chrome via CDP (console errors
included). `google-chrome-stable` is available.
