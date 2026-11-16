// Lab audio -> flowgraph audio_in: the JS feeder (bounded, one chunk in flight
// per stream) and the python block (skipped without numpy + liquid-dsp).

const path = require("path");
const spawn = require("child_process").spawn;
const spawnSync = require("child_process").spawnSync;
const config = require("../../../config");
const flowgraph = require("..");

const PYTHON_DIR = path.join(__dirname, "..", "..", "..", "..", "python");

const deferred = () => {
	const d = {};
	d.promise = new Promise((resolve) => {
		d.resolve = resolve;
	});
	return d;
};

describe("audio feeder", () => {
	test("audio_in streams come from the graph", () => {
		expect(flowgraph._audioStreams({ blocks: [
			{ id: "a", type: "audio_in", params: { stream: "phone_mic" } },
			{ id: "b", type: "audio_in", params: {} },
			{ id: "c", type: "scope", params: { stream: "x" } }
		] })).toEqual(["phone_mic"]);
		expect(flowgraph._audioStreams(undefined)).toEqual([]);
	});

	test("one chunk in flight, bounded queue drops the oldest, other streams ignored", () => {
		const calls = [];
		const logs = [];
		const feeder = flowgraph._audioFeeder(() => ["mic"], (args) => {
			const d = deferred();
			calls.push({ args: args, done: d.resolve });
			return d.promise;
		}, (text) => logs.push(text));
		feeder.push({ name: "other", rate: 8000, data: "AAAA" });
		[1, 2, 3, 4, 5, 6, 7].forEach((n) => feeder.push({ name: "mic", rate: 8000, data: String(n) }));
		expect(calls.length).toBe(1);
		expect(calls[0].args).toEqual({ stream: "mic", rate: 8000, channels: 1, data: "1" });
		expect(feeder.stats()).toEqual({ mic: { forwarded: 7, dropped: 2, queued: 4 } });
		expect(logs[0]).toMatch(/graph is behind/);
		calls[0].done();
		return Promise.resolve().then(() => Promise.resolve()).then(() => {
			// chunks 2 and 3 were dropped; 4 goes next
			expect(calls.length).toBe(2);
			expect(calls[1].args.data).toBe("4");
		});
	});

	test("a failing bridge logs once and keeps draining", () => {
		const logs = [];
		let n = 0;
		const feeder = flowgraph._audioFeeder(() => ["mic"], () => {
			n++;
			return Promise.reject(new Error("not started"));
		}, (text) => logs.push(text));
		feeder.push({ name: "mic", rate: 8000, data: "a" });
		feeder.push({ name: "mic", rate: 8000, data: "b" });
		return new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
			expect(n).toBe(2);
			expect(logs.length).toBe(1);
		});
	});
});

const available = () => {
	const probe = spawnSync(config.get("PYTHON"), ["-c", "import numpy, liquid_dsp"], { cwd: PYTHON_DIR });
	return probe.status === 0;
};

const maybe = available() ? test : test.skip;

maybe("audio_in block turns lab PCM into samples for the graph", () => {
	const graph = {
		blocks: [
			{ id: "mic", type: "audio_in", params: { stream: "phone_mic", channel: "right" } },
			{ id: "lvl", type: "measure", params: { stat: "peak", fps: 100 } }
		],
		links: [["mic", "lvl"]]
	};
	const child = spawn(config.get("PYTHON"), ["flowgraph_bridge.py", "--graph", JSON.stringify(graph)], { cwd: PYTHON_DIR });
	// stereo: left 0.25, right 0.5 full scale; the block picks the right channel
	const pcm = Buffer.alloc(800 * 4);
	for (let i = 0; i < 800; i++) {
		pcm.writeInt16LE(8192, i * 4);
		pcm.writeInt16LE(16384, i * 4 + 2);
	}
	let out = "";
	let stderr = "";
	child.stderr.on("data", (d) => {
		stderr += d;
	});
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("no sample from the graph: " + out + stderr)), 15000);
		child.stdout.on("data", (d) => {
			out += d;
			const lines = out.split("\n");
			lines.map((l) => {
				try {
					return JSON.parse(l);
				} catch (_err) {
					return null;
				}
			}).filter(Boolean).forEach((msg) => {
				if (msg.type === "result" && msg.id === 1) {
					expect(msg.result).toEqual({ blocks: 1, dropped: 0 });
				}
				if (msg.type === "sample" && msg.field === "lvl") {
					clearTimeout(timer);
					resolve(msg.value);
				}
			});
		});
		child.stdin.write(JSON.stringify({ id: 1, command: "audio_in", args: { stream: "phone_mic", rate: 16000, channels: 2, data: pcm.toString("base64") } }) + "\n");
	}).then((value) => {
		expect(value).toBeCloseTo(0.5, 3);
	}).finally(() => {
		child.kill();
	});
}, 20000);
