// Screenshot every flowgraph block example into docs/blocks/<block>/screenshot.png.
// Per block: a fresh mailab server (temp DATA_DIR outside the repo, port picked
// free), the example loaded over MCP (device_add + pane_add), headless Chrome
// via CDP, then a palette-quantized PNG (ImageMagick) to keep the repo small.
// usage: node bin/block-shots.js [block ...]   (default: all documented blocks)
// env: SHOT_WIDTH / SHOT_HEIGHT (1200x600), SHOT_WAIT_MS (4000), SHOT_COLORS (128)

const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const http = require("http");
const spawn = require("child_process").spawn;
const spawnSync = require("child_process").spawnSync;
const WsClient = require("ws");
const blockDocs = require("../src/utils/block-docs");

const WIDTH = Number(process.env.SHOT_WIDTH || 1200);
const HEIGHT = Number(process.env.SHOT_HEIGHT || 600);
const WAIT_MS = Number(process.env.SHOT_WAIT_MS || 4000);
const COLORS = Number(process.env.SHOT_COLORS || 128);
const CHROME = process.env.CHROME || "google-chrome-stable";
const SERVER_START_TIMEOUT_MS = 20000;
const FLOWGRAPH_H = 3;
const RESULT_H = 5;
// graphs at least this tall and at most this wide get the side-by-side layout
const SIDE_ROWS = 3;
const SIDE_COLUMNS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const freePort = () => new Promise((resolve, reject) => {
	const server = net.createServer();
	server.on("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const port = server.address().port;
		server.close(() => resolve(port));
	});
});

const httpGet = (port, urlPath) => new Promise((resolve, reject) => {
	http.get({ host: "127.0.0.1", port: port, path: urlPath }, (res) => {
		let body = "";
		res.on("data", (d) => {
			body += d;
		});
		res.on("end", () => resolve({ status: res.statusCode, body: body }));
	}).on("error", reject);
});

const waitFor = (fn, timeoutMs) => {
	const started = Date.now();
	const attempt = () => fn().catch((err) => {
		if (Date.now() - started > timeoutMs) {
			throw err;
		}
		return sleep(200).then(attempt);
	});
	return attempt();
};

/**
 * Child process exit as a promise; kill() sends SIGTERM to this child only.
 */
const exited = (child) => new Promise((resolve) => {
	if (child.exitCode !== null) {
		resolve();
		return;
	}
	child.on("exit", () => resolve());
});

// ---- mailab server + MCP ----------------------------------------------------------

const startServer = (dataDir, mediaDir) => {
	return freePort().then((port) => {
		const child = spawn(process.execPath, [path.join(blockDocs.ROOT, "src", "index.js")], {
			cwd: blockDocs.ROOT,
			env: Object.assign({}, process.env, {
				PORT: String(port),
				HOST: "127.0.0.1",
				DATA_DIR: dataDir,
				MAILAB_MANAGE_PYTHON: "0",
				MAILAB_TOKENS: "",
				MAILAB_MEDIA_DIRS: mediaDir
			}),
			stdio: ["ignore", "ignore", "pipe"]
		});
		let stderr = "";
		child.stderr.on("data", (d) => {
			stderr += d;
		});
		return waitFor(() => httpGet(port, "/"), SERVER_START_TIMEOUT_MS)
			.then(() => ({ port: port, child: child, stderr: () => stderr }));
	});
};

const mcpClient = (port) => {
	const url = "http://127.0.0.1:" + port + "/mcp";
	const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
	let session = null;
	let nextId = 1;
	const post = (body) => fetch(url, {
		method: "POST",
		headers: Object.assign({}, headers, session ? { "mcp-session-id": session } : {}),
		body: JSON.stringify(body)
	});
	const parse = (text) => {
		const line = text.split("\n").find((l) => l.startsWith("data:"));
		return JSON.parse(line ? line.slice(5) : text);
	};
	const client = {
		init: () => post({ jsonrpc: "2.0", id: nextId++, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "block-shots", version: "1" } } })
			.then((res) => {
				session = res.headers.get("mcp-session-id");
				return res.text();
			})
			.then(() => post({ jsonrpc: "2.0", method: "notifications/initialized" }))
			.then((res) => res.text()),
		call: (name, args) => post({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name: name, arguments: args } })
			.then((res) => res.text())
			.then((text) => {
				const msg = parse(text);
				if (msg.error || msg.result.isError) {
					throw new Error(name + ": " + JSON.stringify(msg.error || msg.result.content));
				}
				const first = msg.result.content[0];
				try {
					return JSON.parse(first.text);
				} catch (_err) {
					return first.text;
				}
			})
	};
	return client;
};

/**
 * Most blocks in one column of the flowgraph pane's layout (column = depth from a source).
 */
const graphShape = (graph) => {
	const parent = {};
	graph.links.forEach((l) => {
		parent[l[1]] = l[0];
	});
	const depth = (id, seen) => (parent[id] && seen < 50 ? depth(parent[id], seen + 1) + 1 : 0);
	const rows = {};
	graph.blocks.forEach((b) => {
		const col = depth(b.id, 0);
		rows[col] = (rows[col] || 0) + 1;
	});
	return { rows: Math.max.apply(null, Object.values(rows).concat([1])), columns: Object.keys(rows).length };
};

/**
 * Wide graphs: flowgraph pane on top (tall enough for the graph), result panes
 * side by side below. Tall, narrow graphs (3+ rows, at most 3 columns):
 * flowgraph on the left half, result panes stacked on the right.
 */
const layoutPanes = (example, graph) => {
	const results = example.panes || [];
	const shape = graphShape(graph);
	if (shape.rows >= SIDE_ROWS && shape.columns <= SIDE_COLUMNS) {
		const height = FLOWGRAPH_H + RESULT_H;
		const each = Math.floor(height / Math.max(1, results.length));
		return [Object.assign({}, blockDocs.FLOWGRAPH_PANE, { x: 0, y: 0, w: 6, h: height })]
			.concat(results.map((pane, i) => Object.assign({}, pane, { x: 6, y: i * each, w: 6, h: each })));
	}
	const top = Object.assign({}, blockDocs.FLOWGRAPH_PANE, { x: 0, y: 0, w: 12, h: example.flowgraphH || FLOWGRAPH_H + shape.rows - 1 });
	let x = 0;
	// panes without a w share what the sized ones leave
	const fixed = results.reduce((sum, pane) => sum + (pane.w || 0), 0);
	const flexible = results.filter((pane) => !pane.w).length;
	const width = Math.floor((12 - fixed) / Math.max(1, flexible));
	const placed = results.map((pane) => {
		const w = pane.w || width;
		const out = Object.assign({}, pane, { x: x, y: top.h, w: w, h: pane.h || Math.max(RESULT_H - top.h + FLOWGRAPH_H, 3) });
		x += w;
		return out;
	});
	return [top].concat(placed);
};

// ---- chrome (CDP) -------------------------------------------------------------------

const startChrome = (profileDir) => {
	return freePort().then((port) => {
		const child = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--mute-audio",
			"--remote-debugging-port=" + port, "--user-data-dir=" + profileDir, "--window-size=" + WIDTH + "," + HEIGHT, "about:blank"], { stdio: "ignore" });
		return waitFor(() => httpGet(port, "/json").then((res) => {
			const page = JSON.parse(res.body).find((t) => t.type === "page");
			if (!page) {
				throw new Error("no page target");
			}
			return page;
		}), SERVER_START_TIMEOUT_MS).then((page) => cdpSession(child, page.webSocketDebuggerUrl));
	});
};

const cdpSession = (child, wsUrl) => new Promise((resolve, reject) => {
	const ws = new WsClient(wsUrl);
	const pending = {};
	let nextId = 1;
	let problems = [];
	const send = (method, params) => new Promise((res) => {
		const id = nextId++;
		pending[id] = res;
		ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
	});
	ws.on("message", (raw) => {
		const msg = JSON.parse(raw);
		if (msg.id && pending[msg.id]) {
			pending[msg.id](msg.result || {});
			delete pending[msg.id];
		} else if (msg.method === "Runtime.exceptionThrown") {
			const d = msg.params.exceptionDetails;
			problems.push("exception: " + ((d.exception && d.exception.description) || d.text));
		} else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
			problems.push("console.error: " + msg.params.args.map((a) => a.value || a.description).join(" "));
		} else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
			problems.push("log: " + msg.params.entry.text + " " + (msg.params.entry.url || ""));
		}
	});
	ws.on("error", reject);
	ws.on("open", () => {
		send("Runtime.enable")
			.then(() => send("Log.enable"))
			.then(() => send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }))
			.then(() => resolve({
				shoot: (url, waitMs) => {
					problems = [];
					return send("Page.navigate", { url: url })
						.then(() => sleep(waitMs))
						.then(() => send("Page.captureScreenshot", { format: "png" }))
						.then((shot) => ({ png: Buffer.from(shot.data, "base64"), problems: problems.slice() }));
				},
				close: () => {
					ws.close();
					child.kill();
					return exited(child);
				}
			}));
	});
});

// ---- per block ----------------------------------------------------------------------

const quantize = (input, output) => {
	const run = spawnSync("magick", [input, "-strip", "+dither", "-colors", String(COLORS), "PNG8:" + output], { encoding: "utf8" });
	if (run.status !== 0) {
		// no ImageMagick: keep the full PNG
		fs.copyFileSync(input, output);
	}
};

const shootBlock = (name, chrome, tmp, mediaDir) => {
	const example = blockDocs.readExample(name);
	const dataDir = path.join(tmp, "data-" + name);
	const report = { block: name, problems: [] };
	let server = null;
	return freePort()
		.then((port) => {
			const graph = blockDocs.prepareGraph(example, { media: mediaDir, port: port });
			return startServer(dataDir, mediaDir).then((started) => {
				server = started;
				const mcp = mcpClient(server.port);
				return mcp.init()
					.then(() => mcp.call("lab_overview", {}))
					.then((overview) => Promise.all(((overview && overview.panes) || []).map((p) => mcp.call("pane_remove", { id: p.id }))))
					.then(() => mcp.call("device_add", { id: blockDocs.DEVICE, driver: "flowgraph", options: { graph: graph } }))
					.then(() => layoutPanes(example, graph).reduce((chain, pane) => chain.then(() => mcp.call("pane_add", pane)), Promise.resolve()))
					.then(() => sleep(example.shotWarmupMs || 1500))
					.then(() => chrome.shoot("http://127.0.0.1:" + server.port + "/", example.shotWaitMs || WAIT_MS))
					.then((shot) => {
						report.problems = report.problems.concat(shot.problems);
						const raw = path.join(tmp, name + ".png");
						fs.writeFileSync(raw, shot.png);
						const out = path.join(blockDocs.DOCS_DIR, name, "screenshot.png");
						quantize(raw, out);
						report.bytes = fs.statSync(out).size;
						return mcp.call("device_command", { id: blockDocs.DEVICE, command: "stats", args: {} });
					})
					.then((stats) => {
						Object.keys(stats || {}).forEach((id) => {
							if (stats[id].error) {
								report.problems.push("block " + id + ": " + stats[id].error);
							}
						});
					});
			});
		})
		.catch((err) => {
			report.problems.push("failed: " + err.message + (server ? "\n" + server.stderr().slice(-500) : ""));
		})
		.then(() => {
			if (!server) {
				return report;
			}
			server.child.kill("SIGTERM");
			return exited(server.child).then(() => report);
		});
};

const main = () => {
	const wanted = process.argv.slice(2);
	const names = wanted.length ? wanted : blockDocs.documentedBlocks();
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mailab-shots-"));
	const mediaDir = blockDocs.makeMedia(path.join(tmp, "media"));
	let chrome = null;
	const reports = [];
	return startChrome(path.join(tmp, "chrome"))
		.then((session) => {
			chrome = session;
			return names.reduce((chain, name) => chain
				.then(() => shootBlock(name, chrome, tmp, mediaDir))
				.then((report) => {
					reports.push(report);
					console.log(name + ": " + (report.bytes ? Math.round(report.bytes / 1024) + " KB" : "no image")
						+ (report.problems.length ? "\n  " + report.problems.join("\n  ") : ""));
				}), Promise.resolve());
		})
		.then(() => {
			const total = reports.reduce((sum, r) => sum + (r.bytes || 0), 0);
			const failed = reports.filter((r) => r.problems.length);
			console.log(reports.length + " screenshots, " + Math.round(total / 1024) + " KB total, " + failed.length + " with problems");
			return failed.length;
		})
		.then((failures) => chrome.close().then(() => failures), (err) => (chrome ? chrome.close() : Promise.resolve()).then(() => {
			throw err;
		}))
		.then((failures) => {
			fs.rmSync(tmp, { recursive: true, force: true });
			process.exit(failures ? 1 : 0);
		});
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
