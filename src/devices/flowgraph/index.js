// GNU Radio-style DSP flowgraph (python/flowgraph_bridge.py, numpy + liquid-dsp).
// The graph lives in the device options, so it survives restarts; edit it with
// set_graph / add_block / connect / set_param or in a flowgraph pane.
// Protocol decoding (python/protocol_decode.py): the `decode` block, plus the
// `decode` / `feed` commands for external captures (base64, hex, bits, or a
// lab blob by name, resolved here).
// Lab audio streams (e.g. a browser mic, <dev>_mic) reach `audio_in` blocks:
// this device subscribes to lab audio and forwards the wanted streams to the
// bridge as `audio_in` commands, one in flight per stream.

const processDriver = require("../process");

// commands whose {blob} argument is replaced by the blob's bytes (base64 data)
const BLOB_COMMANDS = ["decode", "feed"];
// lab audio -> audio_in blocks: chunks waiting per stream while one is in flight
// to the bridge; beyond this the oldest is dropped (a slow graph can't back up the lab)
const AUDIO_QUEUE = 4;
const AUDIO_DROP_LOG_EVERY = 100;

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
		feed: "{block, rate, blob | data | hex | bits, format} push external logic samples into a block (e.g. a decode block)",
		audio_in_stats: "lab audio forwarded to audio_in blocks: per stream forwarded / dropped / queued",
		audio_in: "{stream, rate, channels, data} (internal) a lab audio chunk for audio_in blocks; the device forwards subscribed streams itself"
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

/**
 * Lab audio streams the graph's audio_in blocks listen to.
 */
const audioStreams = (graph) => {
	return ((graph && graph.blocks) || []).filter((b) => b.type === "audio_in" && b.params && b.params.stream).map((b) => String(b.params.stream));
};

/**
 * Forwards lab audio chunks of the wanted streams to the bridge, one command in
 * flight per stream; a bounded queue absorbs bursts and drops the oldest.
 * @param {function(): string[]} wanted streams to forward
 * @param {function(Object): Promise} send forwards one chunk ({stream, rate, channels, data})
 * @param {function(string, string)} log
 * @returns {{push: function(Object), stats: function(): Object}}
 */
const audioFeeder = (wanted, send, log) => {
	const streams = {};
	const forward = (state, chunk) => {
		state.busy = true;
		const next = () => {
			state.busy = false;
			if (state.queue.length) {
				forward(state, state.queue.shift());
			}
		};
		send({ stream: chunk.name, rate: chunk.rate, channels: chunk.channels || 1, data: chunk.data }).then(next, (err) => {
			if (!state.failed) {
				log("audio_in " + chunk.name + ": " + err.message, "warn");
			}
			state.failed = true;
			next();
		});
	};
	return {
		push: (chunk) => {
			if (wanted().indexOf(chunk.name) === -1) {
				return;
			}
			const state = streams[chunk.name] || (streams[chunk.name] = { busy: false, queue: [], forwarded: 0, dropped: 0, failed: false });
			state.forwarded++;
			if (!state.busy) {
				forward(state, chunk);
				return;
			}
			state.queue.push(chunk);
			if (state.queue.length > AUDIO_QUEUE) {
				state.queue.shift();
				state.dropped++;
				if (state.dropped % AUDIO_DROP_LOG_EVERY === 1) {
					log("audio_in " + chunk.name + ": graph is behind, dropped " + state.dropped + " chunks so far", "warn");
				}
			}
		},
		stats: () => {
			const out = {};
			Object.keys(streams).forEach((name) => {
				out[name] = { forwarded: streams[name].forwarded, dropped: streams[name].dropped, queued: streams[name].queue.length };
			});
			return out;
		}
	};
};

module.exports = Object.assign({}, preset, {
	create: (options, io) => {
		// the bridge reports graph edits as options; keep the latest for audio_in routing
		let graph = options.graph;
		const tracked = Object.assign({}, io, {
			setOptions: (changes) => {
				if (changes && changes.graph) {
					graph = changes.graph;
				}
				io.setOptions(changes);
			}
		});
		const inner = preset.create(options, tracked);
		let unsubscribe = null;
		const feeder = audioFeeder(() => audioStreams(graph), (args) => inner.command("audio_in", args), io.log);
		return Object.assign({}, inner, {
			start: () => inner.start().then((result) => {
				if (io.onAudio) {
					unsubscribe = io.onAudio(feeder.push);
				}
				return result;
			}),
			stop: () => {
				if (unsubscribe) {
					unsubscribe();
					unsubscribe = null;
				}
				return inner.stop();
			},
			command: (name, args) => {
				if (name === "audio_in_stats") {
					return Promise.resolve(feeder.stats());
				}
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
	_resolveBlob: resolveBlob,
	_audioFeeder: audioFeeder,
	_audioStreams: audioStreams
});
