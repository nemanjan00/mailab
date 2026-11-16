# mailab

**m**y **ai** **lab**: an MCP server that hands a hardware lab to an AI, plus a
live web UI where you watch (and steer) what it does.

- **Devices**: drivers for bench gear, SDRs, logic analyzers, RF tools and
  glitchers. Any program that speaks JSON lines can be a device too, which is
  how the Python libraries plug in. See [HW.md](HW.md) for what's supported and
  what still needs testing.
- **Channels**: live time series (`<device>_<field>`) in ring buffers.
- **Traces**: captured arrays such as spectra, VNA sweeps, scope and logic
  captures, and glitch scatter plots.
- **Math**: mathjs over channels and traces (`rms(psu_i)`, `max(mag(fft(scope_ch1)))`),
  plus derived channels computed per sample (`psu_v * psu_i`).
- **Panes**: a configurable grid of charts, traces, waterfalls, readouts,
  live math, markdown notes with KaTeX, consoles and an AI activity feed.
  You and the AI edit the same layout.

![mailab](docs/screenshot.png)

## Run

```sh
yarn install
yarn watch          # dev (nodemon), http://127.0.0.1:3000
yarn web            # prod (forever)
```

Connect an AI over MCP (Streamable HTTP):

```sh
claude mcp add --transport http mailab http://127.0.0.1:3000/mcp
```

Then ask it something like *"add the sim device, chart it and tell me the RMS"*.

### Configuration (env)

| Var | Default | |
|---|---|---|
| `PORT` / `HOST` | `3000` / `127.0.0.1` | the lab drives real hardware, so keep it local |
| `DATA_DIR` | `./data` | `lab.json` holds devices, derived channels and panes |
| `CHANNEL_CAPACITY` | `200000` | samples kept per channel |
| `MDP_HOST_PATH` | `~/mdp-p906/host` | mdp-p906 host library |
| `CIV_PATH` | `~/ci-v` | ci-v library |
| `SIGROK_CLI` | `sigrok-cli` | |
| `PM3_CLIENT` | `proxmark3` | Proxmark3 client binary |
| `PYTHON` | `python3` | for python bridges |

Python bridges need their libraries: `pymp305`, `findus`, `SoapySDR` + `numpy`,
and `libliquid` for demodulation.

## MCP tools

| Tool | |
|---|---|
| `lab_overview`, `lab_drivers` | what's in the lab, what can be added |
| `device_add/remove/start/stop`, `device_command`, `device_log` | instruments |
| `channel_read`, `channel_write` | time series (stats + downsampled data) |
| `trace_read`, `trace_write`, `image_get` | captures and screenshots |
| `math_eval`, `math_derive`, `math_remove` | analysis |
| `pane_types`, `pane_add`, `pane_update`, `pane_remove`, `note` | the user's UI |

Every call shows up in the **AI activity** pane.

## Writing a driver

A driver is a module in `src/devices/<name>/index.js`:

```js
module.exports = {
	name: "mydev",
	description: "...",
	options: { path: "serial port" },
	commands: { set: "{value}" },
	create: (options, io) => {
		// io.sample(field, value, {unit, t}), io.trace(name, {x, series}),
		// io.point(dataset, {x, y, class}), io.image(name, buffer, mime),
		// io.log(text, level), io.status(state, detail)
		return { start: () => Promise, stop: () => Promise, command: (name, args) => Promise };
	}
};
```

Register it in `src/devices/index.js`. For Python libraries, write a bridge
with `python/mailab_bridge.py` and a `processDriver.pythonPreset(...)`
(see `src/devices/mp305`).

## Develop

```sh
yarn test
yarn lint
```
