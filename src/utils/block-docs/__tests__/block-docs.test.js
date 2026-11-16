// Block docs (docs/blocks): the generated READMEs match the live block catalog,
// every catalog block is documented with about.md + example.json + screenshot,
// and every example graph builds and runs in the bridge for ~1 s with samples
// reaching every block and no block errors. Examples needing an unavailable
// optional dependency (ffmpeg, librnnoise) are skipped with the reason.
// Skipped entirely without numpy + scipy + liquid-dsp.

const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const spawnSync = require("child_process").spawnSync;
const config = require("../../../config");
const blockDocs = require("..");

const RUN_MS = 1200;
const PARALLEL = 6;

const available = () => {
	const probe = spawnSync(config.get("PYTHON"), ["-c", "import numpy, scipy, liquid_dsp"], { cwd: blockDocs.PYTHON_DIR });
	return probe.status === 0;
};

const maybe = available() ? test : test.skip;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const freePort = () => new Promise((resolve, reject) => {
	const server = net.createServer();
	server.on("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const port = server.address().port;
		server.close(() => resolve(port));
	});
});

let catalog = null;
const loadCatalog = () => {
	if (!catalog) {
		catalog = blockDocs.loadCatalog();
	}
	return catalog;
};

maybe("every catalog block has docs, an example and a screenshot; every param has a description", () => {
	return loadCatalog().then((cat) => {
		const names = Object.keys(cat);
		expect(names.length).toBeGreaterThan(50);
		const undocumented = names.filter((n) => ["about.md", "example.json", "screenshot.png"].some((f) => !fs.existsSync(path.join(blockDocs.DOCS_DIR, n, f))));
		expect(undocumented).toEqual([]);
		const orphans = blockDocs.documentedBlocks().filter((n) => !cat[n]);
		expect(orphans).toEqual([]);
		const noDoc = [];
		names.forEach((n) => {
			Object.keys(cat[n].params).forEach((p) => {
				if (!cat[n].params[p].doc) {
					noDoc.push(n + "." + p);
				}
			});
		});
		expect(noDoc).toEqual([]);
	});
}, 60000);

maybe("docs/blocks READMEs are up to date with the catalog (run `yarn block-docs`)", () => {
	return loadCatalog().then((cat) => {
		expect(blockDocs.stale(blockDocs.generate(cat))).toEqual([]);
	});
}, 60000);

/**
 * Run one example for RUN_MS; lab audio the graph publishes is fed back to its
 * audio_in blocks (what the flowgraph device does in the lab).
 */
const runExample = (name, media) => {
	const example = blockDocs.readExample(name);
	return freePort().then((port) => {
		const graph = blockDocs.prepareGraph(example, { media: media, port: port });
		let bridge = null;
		const onMessage = (msg) => {
			if (msg.type === "audio" && bridge) {
				bridge.client.command("audio_in", { stream: blockDocs.DEVICE + "_" + msg.name, rate: msg.rate, channels: 1, data: msg.data }).catch(() => {});
			}
		};
		bridge = blockDocs.startBridge(graph, { env: { MAILAB_MEDIA_ROOTS: media }, onMessage: onMessage });
		return wait(RUN_MS)
			.then(() => bridge.client.command("stats"))
			.then((stats) => {
				bridge.child.kill();
				const problems = [];
				graph.blocks.forEach((b) => {
					const s = stats[b.id];
					if (!s) {
						problems.push(b.id + ": not built");
					} else if (s.error) {
						problems.push(b.id + ": " + s.error);
					} else if (s.in === 0 && s.out === 0) {
						problems.push(b.id + ": no samples");
					}
				});
				return problems;
			}, (err) => {
				bridge.child.kill();
				return [err.message + " " + bridge.stderr().slice(-300)];
			});
	});
};

describe("block examples run", () => {
	const names = blockDocs.documentedBlocks();
	const media = fs.mkdtempSync(path.join(os.tmpdir(), "mailab-blockdocs-"));
	let results = null;

	// all examples at once, PARALLEL bridges at a time; each test then checks its own result
	const runAll = () => {
		if (!results) {
			blockDocs.makeMedia(media);
			const runnable = names.filter((n) => !blockDocs.missingRequirements(blockDocs.readExample(n)).length);
			const out = {};
			const lanes = Array.from({ length: PARALLEL }).map((_v, lane) => runnable.filter((_n, i) => i % PARALLEL === lane));
			results = loadCatalog()
				.then(() => Promise.all(lanes.map((lane) => lane.reduce((chain, n) => chain.then(() => runExample(n, media)).then((problems) => {
					out[n] = problems;
				}), Promise.resolve()))))
				.then(() => out);
		}
		return results;
	};

	afterAll(() => {
		fs.rmSync(media, { recursive: true, force: true });
	});

	names.forEach((name) => {
		const missing = available() ? blockDocs.missingRequirements(blockDocs.readExample(name)) : ["no numpy/scipy/liquid-dsp"];
		const run = missing.length ? test.skip : test;
		run(name + (missing.length ? " (skipped: " + missing.join(", ") + ")" : ""), () => {
			return runAll().then((all) => {
				expect(all[name]).toEqual([]);
			});
		}, 180000);
	});
});
