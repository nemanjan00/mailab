// Realtime audio blocks (python/audio_dsp.py + audio_blocks.py): runs the python
// regression (python/test_audio_dsp.py: filter responses, hum/auto notch,
// compressor curve + timing, limiter ceiling, gate, AGC, spectral NR SNR gain,
// de-click, chunk-size independence, latency stats, denoise plumbing with a fake
// backend, rnnoise when librnnoise is installed), then drives a live bridge:
// stats with latency, live set_param, templates. Skipped without numpy + scipy +
// liquid-dsp.

const path = require("path");
const spawn = require("child_process").spawn;
const spawnSync = require("child_process").spawnSync;
const config = require("../../../config");

const PYTHON_DIR = path.join(__dirname, "..", "..", "..", "..", "python");
const CHECKS = ["biquad_responses", "fir_response_and_latency", "hum_notch_removes_harmonics", "auto_notch_finds_tone",
	"dc_block", "compressor_static_curve", "compressor_attack_release_timing", "compressor_lookahead_and_sidechain",
	"limiter_ceiling", "gate_and_expander", "audio_agc_levels", "spectral_nr_learned_profile", "spectral_nr_auto_speech",
	"declick_repairs_clicks", "chunk_size_independence", "latency_stats_match", "denoise_plumbing_fake_backend",
	"maxine_stub_explains", "live_param_changes_keep_state", "templates_build"];

const available = () => {
	const probe = spawnSync(config.get("PYTHON"), ["-c", "import numpy, scipy, liquid_dsp"], { cwd: PYTHON_DIR });
	return probe.status === 0;
};

const maybe = available() ? test : test.skip;

maybe("audio DSP regression", () => {
	const run = spawnSync(config.get("PYTHON"), ["test_audio_dsp.py"], { cwd: PYTHON_DIR, encoding: "utf8", timeout: 120000 });
	if (run.status !== 0) {
		throw new Error(run.stdout + run.stderr);
	}
	CHECKS.forEach((name) => {
		expect(run.stdout).toMatch(new RegExp("ok " + name));
	});
	// rnnoise runs for real when librnnoise is installed, else it's reported as skipped
	expect(run.stdout).toMatch(/(ok|skip) rnnoise_backend/);
}, 150000);

/**
 * JSON-lines client for a bridge process: command(name, args) -> result.
 */
const bridgeClient = (child) => {
	const pending = {};
	const samples = [];
	let buffer = "";
	let nextId = 1;
	child.stdout.on("data", (d) => {
		buffer += d;
		const lines = buffer.split("\n");
		buffer = lines.pop();
		lines.forEach((line) => {
			let msg;
			try {
				msg = JSON.parse(line);
			} catch (_err) {
				return;
			}
			if (msg.type === "result" && pending[msg.id]) {
				const p = pending[msg.id];
				delete pending[msg.id];
				if (msg.error) {
					p.reject(new Error(msg.error));
				} else {
					p.resolve(msg.result);
				}
			} else if (msg.type === "sample") {
				samples.push(msg);
			}
		});
	});
	return {
		samples: samples,
		command: (name, args) => {
			const id = nextId++;
			return new Promise((resolve, reject) => {
				pending[id] = { resolve: resolve, reject: reject };
				child.stdin.write(JSON.stringify({ id: id, command: name, args: args || {} }) + "\n");
			});
		}
	};
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

maybe("bridge: audio chain stats, live set_param, templates", () => {
	const graph = {
		blocks: [
			{ id: "src", type: "signal", params: { rate: 48000, freq: 1000, amp: 0.9, noise: 0.001 } },
			{ id: "hp", type: "biquad", params: { type: "highpass", freq: 80 } },
			{ id: "comp", type: "compressor", params: { threshold_db: -20, fps: 50 } },
			{ id: "lim", type: "limiter", params: { ceiling_db: -3, lookahead_ms: 5 } },
			{ id: "lvl", type: "measure", params: { stat: "peak", fps: 50 } }
		],
		links: [["src", "hp"], ["hp", "comp"], ["comp", "lim"], ["lim", "lvl"]]
	};
	const child = spawn(config.get("PYTHON"), ["flowgraph_bridge.py", "--graph", JSON.stringify(graph)], { cwd: PYTHON_DIR });
	const client = bridgeClient(child);
	return wait(1500)
		.then(() => {
			return client.command("stats");
		})
		.then((stats) => {
			expect(stats.lim.latency_samples).toBe(240);
			expect(stats.lim.latency_ms).toBe(5);
			expect(stats.comp.gr_db).toBeLessThan(-5);
			expect(stats.hp.latency_ms).toBe(0);
			expect(stats.lim.error).toBeNull();
			const peaks = client.samples.filter((s) => s.field === "lvl").map((s) => s.value);
			expect(peaks.length).toBeGreaterThan(0);
			expect(Math.max.apply(null, peaks)).toBeLessThanOrEqual(Math.pow(10, -3 / 20) + 1e-6);
			expect(client.samples.some((s) => s.field === "comp_gr" && s.unit === "dB")).toBe(true);
			return client.command("set_param", { block: "comp", key: "threshold_db", value: -10 });
		})
		.then((result) => {
			expect(result.live).toBe(true);
			return client.command("set_param", { block: "comp", key: "ratio", value: "loud" }).then(() => {
				throw new Error("bad value accepted");
			}, (err) => {
				expect(err.message).toMatch(/must be a number/);
			});
		})
		.then(() => {
			return client.command("get_graph");
		})
		.then((spec) => {
			expect(spec.blocks.find((b) => b.id === "comp").params.threshold_db).toBe(-10);
			return client.command("templates");
		})
		.then((templates) => {
			expect(Object.keys(templates)).toEqual(expect.arrayContaining(["voice_cleanup", "sdr_fm_audio", "sdr_am_audio", "hum_removal"]));
			return client.command("load_template", { name: "hum_removal", source: { type: "signal", params: { rate: 48000, freq: 50, amp: 0.5 } } });
		})
		.then((spec) => {
			expect(spec.blocks.map((b) => b.id)).toEqual(expect.arrayContaining(["src", "hum", "out", "spec_before", "spec_after"]));
			return wait(600).then(() => client.command("stats"));
		})
		.then((stats) => {
			expect(stats.hum.f0).toBe(null);
			expect(stats.hum.error).toBeNull();
		})
		.finally(() => {
			child.kill();
		});
}, 30000);
