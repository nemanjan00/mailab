// GNU Radio-style DSP flowgraph (python/flowgraph_bridge.py, numpy + liquid-dsp).
// The graph lives in the device options, so it survives restarts; edit it with
// set_graph / add_block / connect / set_param or in a flowgraph pane.

const processDriver = require("../process");

module.exports = processDriver.pythonPreset({
	name: "flowgraph",
	description: "Composable DSP blocks (sources, liquid-dsp processing, sinks to traces/channels/audio). Run command \"blocks\" for the catalog",
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
		stats: "per-block throughput and errors"
	},
	args: (options) => {
		if (!options.graph) {
			return [];
		}
		return ["--graph", JSON.stringify(options.graph)];
	}
});
