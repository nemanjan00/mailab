# mailab

**m**y **ai** **lab**: the AI owns the lab. mailab is an MCP server that
gives an AI your bench instruments, SDRs, logic analyzers, glitchers and DSP,
plus a live web UI where you watch, steer and collaborate with it.

![mailab](docs/screenshot.png)

## What's in it

**Instruments** (21 drivers; any instrument can run as several instances):
power supplies (Miniware MDP-P906, ISDT MP305), Rigol DM858E and MHO900 over
SCPI, sigrok logic analyzers (Sipeed SLogic), RF (KC9531B power meter, tinySA
Ultra, LiteVNA, Harogic HTRA), SDRs (HackRF, bladeRF, RTL-SDR via SoapySDR),
Icom radios over CI-V, Proxmark3, PicoGlitcher (findus), webcams/V4L2 capture,
serial gadgets, and any program that speaks JSON lines.
[HW.md](HW.md) tracks what has been verified on hardware.

**DSP flowgraph**: GNU Radio-style blocks (numpy + liquid-dsp) that you or
the AI wire up live:
- **Modulation:** every common scheme (AM/DSB/SSB/FM/PM; OOK, ASK, PSK, DPSK,
  APSK, QAM 4–256, 2/4-FSK, MSK, GFSK, GMSK), with PRBS/pattern/framed bit
  sources.
- **Receive chain:** AWGN/CFO channel, matched filter, symbol and clock
  recovery, carrier recovery, slicer, BER meter, sync-word framer.
- **Views and I/O:** spectrum analyzer (RBW, max/min hold, averaging),
  triggered scope with measurements (Vpp, RMS, frequency, duty…),
  constellation, eye diagram, level trigger, audio out, IQ over TCP/UDP.
- **Scripting:** a `python` block for your own DSP.

**Views**: configurable panes that you and the AI share:
- **Plots:** live charts, traces with spectrum markers and readings, waterfall,
  constellation, eye diagram, glitch scatter and findus-style parameter map.
- **Math:** graphing calculator, live math (KaTeX), value readouts.
- **Data:** markdown notes, JSON view, Kaitai Struct view (parse binary blobs:
  field tree + hex).
- **Lab:** flowgraph editor, audio, camera, device consoles, AI activity, lab chat.

**AI tools**: lab overview, device control, data reads, math and the
graphing calculator, Kaitai parsing, UI control, chat, and `batch`, which
runs many calls in one request with ~1 ms timing for tight sequences.

**Collaboration**: several people and AIs on one lab. Optional
read-write/read-only tokens, every AI call attributed in the activity feed, a
shared chat, and push into Claude Code through a channel bridge.

## Run

```sh
yarn install
yarn watch          # dev: esbuild --watch + nodemon, http://127.0.0.1:3000
yarn web            # prod: build the UI bundle, then forever
```

Connect an AI over MCP (Streamable HTTP):

```sh
claude mcp add --transport http mailab http://127.0.0.1:3000/mcp
```

Then ask it something like *"add the sim device, chart it and tell me the
RMS"* or *"build a QPSK link with 20 dB SNR and show me the constellation and
BER"*.

Python is managed by mailab: on first use it creates a venv in
`DATA_DIR/python` (with system site packages, so apt-installed SoapySDR and
liquid-dsp bindings stay visible) and pip-installs each Python driver's
requirements when you add the device (mp305 → pymp305, picoglitcher → findus,
…), logging progress to the device log. System libraries stay system-level:
`libliquid` (liquid-dsp ≥ 1.6) and SoapySDR. Set `MAILAB_MANAGE_PYTHON=0` or
`PYTHON=/path/to/python` to manage Python yourself.

### Docker

```sh
docker build -t mailab .
docker run --privileged --network host -v /dev:/dev -v mailab-data:/data \
  -e MAILAB_TOKENS="me:$(openssl rand -hex 24):rw" mailab
```

The container listens on all interfaces, so it requires `MAILAB_TOKENS`: it
refuses to start without them (`MAILAB_ALLOW_OPEN=1` overrides that on a
trusted network). Open the UI once as `http://host:3000/?token=<token>`; the
server swaps the token for an HttpOnly cookie and redirects to the clean URL.
API and MCP clients use `Authorization: Bearer`.

The image includes sigrok-cli, liquid-dsp, SoapySDR (HackRF/bladeRF/RTL-SDR),
hackrf tools, ffmpeg/v4l-utils, uhubctl, pymp305 and findus. It doesn't
include the SLogic libsigrok fork, vendor SDKs (Harogic), the Proxmark3
client, or the mdp-p906/ci-v checkouts; mount those and set `MDP_HOST_PATH` /
`CIV_PATH`.

### Configuration (env)

| Var | Default | |
|---|---|---|
| `PORT` / `HOST` | `3000` / `127.0.0.1` | a non-loopback HOST needs `MAILAB_TOKENS` |
| `MAILAB_TOKENS` | – | `name:token:human\|rw\|ro,…` turns on auth |
| `MAILAB_ALLOW_OPEN` | – | `1` = allow a non-loopback HOST without tokens (trusted networks) |
| `MAILAB_ALLOWED_HOSTS` | – | extra Host names accepted without tokens |
| `DATA_DIR` | `./data` | `lab.json`: devices, derived channels, panes, chat |
| `CHANNEL_CAPACITY` | `200000` | samples kept per channel |
| `MDP_HOST_PATH` / `CIV_PATH` | `~/mdp-p906/host` / `~/ci-v` | libraries loaded from checkouts |
| `SIGROK_CLI` / `PM3_CLIENT` / `PYTHON` | `sigrok-cli` / `proxmark3` / `python3` | external tools |

## Collaboration

- `MAILAB_TOKENS="alice:secret:human,claude:secret2:rw,viewer:secret3:ro"` turns on
  auth for the UI, REST, WebSocket and MCP. Tokens go in a Bearer header, or
  in the UI's HttpOnly cookie set by a one-time `/?token=` login link.
  - `human`: people. Can do everything, and are the only ones who can approve
    risky AI commands, change the approval policy or remove locked safety rules.
  - `rw`: AIs. Drive the lab, but their risky commands wait for a human.
  - `ro`: look and chat.
- Without tokens there is one local user, and that user counts as human. An
  AI that can only reach the lab over MCP still can't approve its own commands
  (there is no approval tool), but an agent with a shell on the same machine
  could call the REST API directly. Give AIs `rw` tokens and people `human`
  tokens whenever an agent has shell access.
- Without tokens (local use) the server only accepts loopback `Host` headers
  (plus `MAILAB_ALLOWED_HOSTS`) and same-origin requests, which blocks DNS
  rebinding from web pages.
- The activity pane shows who made each MCP call (`alice/claude-code`).
- **Lab chat**: the chat pane for people, `chat_send` / `chat_read` for AIs.
- **Push into Claude Code**: chat messages arrive in a Claude Code session
  through the stdio channel bridge `bin/channel.js` (Claude Code channels
  only work over stdio). HTTP MCP sessions also receive each message as a
  `notifications/message` log event.

  ```json
  {"mcpServers": {"mailab-chat": {"command": "node", "args": ["/path/to/mailab/bin/channel.js"],
    "env": {"MAILAB_URL": "http://127.0.0.1:3000", "MAILAB_NAME": "claude", "MAILAB_TOKEN": "secret"}}}}
  ```

  `claude --dangerously-load-development-channels server:mailab-chat` (research preview)

## MCP tools

| Tool | |
|---|---|
| `lab_overview`, `lab_drivers` | what's in the lab, what can be added |
| `device_add/remove/start/stop`, `device_command`, `device_log` | instruments, including the flowgraph (`device_command fg blocks` lists its block catalog) |
| `channel_read`, `channel_write` | time series (stats + downsampled data) |
| `trace_read`, `trace_write`, `image_get` | captures, spectra, screenshots |
| `math_eval`, `math_derive`, `math_remove`, `plot` | analysis and the graphing calculator |
| `value_read`, `value_write`, `blob_write`, `blob_read`, `kaitai_parse` | JSON values, binary blobs, Kaitai parsing |
| `pane_types`, `pane_add`, `pane_update`, `pane_remove`, `note` | the shared UI |
| `chat_send`, `chat_read` | lab chat |
| `batch` | many calls in one request, ~1 ms timing, loops, result references |

Every call shows up in the **AI activity** pane.

## Extending

**Driver**: a module in `src/devices/<name>/index.js`:

```js
module.exports = {
	name: "mydev",
	description: "...",
	options: { path: "serial port" },
	commands: { set: "{value}" },
	create: (options, io) => {
		// io.sample(field, value, {unit, t}), io.trace(name, {x, series}),
		// io.point(dataset, {x, y, class}), io.image(name, buffer, mime),
		// io.value(name, json), io.blob(name, buffer), io.log(text, level)
		return { start: () => Promise, stop: () => Promise, command: (name, args) => Promise };
	}
};
```

Register it in `src/devices/index.js`. For Python libraries, write a bridge
on `python/mailab_bridge.py` and wrap it with `processDriver.pythonPreset(...)`
(see `src/devices/mp305`).

**Pane**: a module in `public/panes/<type>.js` built on the GUI SDK
(`public/sdk`, on [qrp](https://github.com/nemanjan00/qrp)):

```js
export default pane((ctx) => table({
	rows: () => ctx.state.devices,
	key: (d) => d.id,
	columns: [{ title: "id", mono: true, value: (d) => d.id }, { title: "state", value: (d) => d.state }],
	empty: "no devices"
}));
```

**Flowgraph block**: a class in `python/flowgraph_bridge.py` with
`params`, `doc` and `work(x, rate) -> (y, rate)`, or write it inline in a
`python` block.

## Develop

```sh
yarn test        # jest, incl. the python modem BER regression (python/test_modem.py)
yarn lint
yarn build       # UI bundle
```

[SPEC.md](SPEC.md) lists every requested feature and its status,
[HW.md](HW.md) the per-instrument hardware checklist, and
[CLAUDE.md](CLAUDE.md) the architecture notes for AI contributors.
