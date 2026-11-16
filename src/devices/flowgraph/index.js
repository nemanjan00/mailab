// GNU Radio-style DSP flowgraph (python/flowgraph_bridge.py, numpy + liquid-dsp).
// The graph lives in the device options, so it survives restarts; edit it with
// set_graph / add_block / connect / set_param or in a flowgraph pane.
// Protocol decoding (python/protocol_decode.py): the `decode` block, plus the
// `decode` / `feed` commands for external captures (base64, hex, bits, or a
// lab blob by name, resolved here).

const processDriver = require("../process");

// commands whose {blob} argument is replaced by the blob's bytes (base64 data)
const BLOB_COMMANDS = ["decode", "feed"];

const preset = processDriver.pythonPreset({
	// pip packages, installed into the mailab-managed venv on first use
	requires: ["numpy==2.5.3"],
	name: "flowgraph",
	description: "Composable DSP blocks (sources, liquid-dsp processing, sinks to traces/channels/audio, protocol decoders). Run command \"blocks\" for the catalog",
	script: "flowgraph_bridge.py",
	options: {
		graph: "{blocks: [{id, type, params}], links: [[from, to]]} (managed by the commands below)"
	},
	commands: {
		blocks: "catalog of block types with params",
		get_graph: "",
		set_graph: "{graph}",
		add_block: "{id, type, params, from?}",
		remove_block: "{id}",
		connect: "{from, to}",
		disconnect: "{from, to}",
		set_param: "{block, key, value}",
		run: "{on}",
		stats: "per-block throughput and errors",
		decode: "{decoder, samplerate, blob | data (base64) | hex | bits, format: u8|u16|u32|bits, options, channels, stack, engine: auto|sigrok|builtin, annotations, name?} one-shot protocol decode of an external capture",
		feed: "{block, rate, blob | data | hex | bits, format} push external logic samples into a block (e.g. a decode block)"
	},
	args: (options) => {
		if (!options.graph) {
			return [];
		}
		return ["--graph", JSON.stringify(options.graph)];
	}
});

/**
 * Swap args.blob (a lab blob name) for its bytes as base64 `data`.
 */
const resolveBlob = (io, name, args) => {
	if (BLOB_COMMANDS.indexOf(name) === -1 || !args || !args.blob) {
		return args;
	}
	const out = Object.assign({}, args, { data: io.getBlob(args.blob).toString("base64") });
	delete out.blob;
	return out;
};

module.exports = Object.assign({}, preset, {
	create: (options, io) => {
		const inner = preset.create(options, io);
		return Object.assign({}, inner, {
			command: (name, args) => {
				return Promise.resolve()
					.then(() => {
						return resolveBlob(io, name, args);
					})
					.then((resolved) => {
						return inner.command(name, resolved);
					});
			}
		});
	},
	_resolveBlob: resolveBlob
});
