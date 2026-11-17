// net_source/net_sink WebSocket modes: ws-client and ws-server stream IQ
// (cf32/cs16) and logic data (u8 words) both directions, against a local
// `ws` echo/feed server (RFC 6455: client masking, server handshake, ping).

const net = require("net");
const spawnSync = require("child_process").spawnSync;
const config = require("../../../config");
const blockDocs = require("../../../utils/block-docs");
const WsClient = require("ws").WebSocket;
const WsServer = require("ws").WebSocketServer;

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

// poll until the bridge's ws-server listener accepts (raw probe connect; the
// failed handshake is harmless, the endpoint re-accepts the real client)
const waitListen = (port) => new Promise((resolve) => {
	const attempt = () => {
		const probe = net.createConnection({ host: "127.0.0.1", port: port });
		probe.on("connect", () => {
			probe.end();
			resolve();
		});
		probe.on("error", () => setTimeout(attempt, 50));
	};
	attempt();
});

const connectWs = (port) => new Promise((resolve, reject) => {
	const ws = new WsClient("ws://127.0.0.1:" + port);
	ws.binaryType = "nodebuffer";
	ws.on("open", () => resolve(ws));
	ws.on("error", reject);
});

const kill = (bridge, wss) => {
	bridge.child.kill();
	if (wss) {
		wss.close();
	}
};

maybe("net_sink ws-client streams IQ to a websocket echo server", () => {
	return freePort().then((port) => {
		const wss = new WsServer({ host: "127.0.0.1", port: port });
		let got = Buffer.alloc(0);
		wss.on("connection", (ws) => {
			ws.on("message", (data) => {
				got = Buffer.concat([got, data]);
			});
		});
		const graph = { blocks: [
			{ id: "sig", type: "signal", params: { rate: 100e3, freq: 10e3, amp: 1, noise: 0 } },
			{ id: "out", type: "net_sink", params: { mode: "ws-client", host: "127.0.0.1", port: port, format: "cf32" } }
		], links: [["sig", "out"]] };
		const bridge = blockDocs.startBridge(graph);
		return wait(1500)
			.then(() => bridge.client.command("stats"))
			.then((stats) => {
				kill(bridge, wss);
				expect(stats.out.error).toBeFalsy();
				expect(stats.out.in).toBeGreaterThan(0);
				expect(got.length % 8).toBe(0);
				expect(got.length).toBeGreaterThan(1000);
				// first samples decode as a unit-amplitude tone
				const n = Math.min(got.length, 8000) / 8;
				let sum = 0;
				for (let i = 0; i < n; i++) {
					sum += Math.hypot(got.readFloatLE(i * 8), got.readFloatLE(i * 8 + 4));
				}
				expect(sum / n).toBeGreaterThan(0.9);
			}, (err) => {
				kill(bridge, wss);
				throw err;
			});
	});
}, 30000);

maybe("net_source ws-client receives IQ from a websocket server", () => {
	const rate = 1e6;
	const n = 20000;
	const payload = Buffer.alloc(n * 8);
	for (let i = 0; i < n; i++) {
		const ph = 2 * Math.PI * 100e3 * i / rate;
		payload.writeFloatLE(Math.cos(ph), i * 8);
		payload.writeFloatLE(Math.sin(ph), i * 8 + 4);
	}
	return freePort().then((port) => {
		const wss = new WsServer({ host: "127.0.0.1", port: port });
		wss.on("connection", (ws) => {
			const timer = setInterval(() => {
				if (ws.readyState === WsClient.OPEN) {
					ws.send(payload);
				}
			}, 20);
			ws.on("close", () => clearInterval(timer));
		});
		const power = [];
		const graph = { blocks: [
			{ id: "in", type: "net_source", params: { mode: "ws-client", host: "127.0.0.1", port: port, format: "cf32", rate: rate } },
			{ id: "pwr", type: "measure", params: { stat: "power_db" } }
		], links: [["in", "pwr"]] };
		const bridge = blockDocs.startBridge(graph, { onMessage: (msg) => {
			if (msg.type === "sample" && msg.field === "pwr" && Number.isFinite(msg.value)) {
				power.push(msg.value);
			}
		} });
		return wait(1500)
			.then(() => bridge.client.command("stats"))
			.then((stats) => {
				kill(bridge, wss);
				expect(stats["in"].error).toBeFalsy();
				expect(stats["in"].out).toBeGreaterThan(0);
				expect(power.length).toBeGreaterThan(0);
				expect(power[power.length - 1]).toBeGreaterThan(-1); // 0 dBFS tone
			}, (err) => {
				kill(bridge, wss);
				throw err;
			});
	});
}, 30000);

maybe("ws-server mode: the bridge accepts websocket clients (IQ out, logic data in)", () => {
	let sinkPort;
	let sourcePort;
	return freePort()
		.then((p) => {
			sinkPort = p;
			return freePort();
		})
		.then((p) => {
			sourcePort = p;
			const graph = { blocks: [
				{ id: "sig", type: "signal", params: { rate: 100e3, freq: 10e3, amp: 1, noise: 0 } },
				{ id: "out", type: "net_sink", params: { mode: "ws-server", host: "127.0.0.1", port: sinkPort, format: "cs16" } },
				{ id: "in", type: "net_source", params: { mode: "ws-server", host: "127.0.0.1", port: sourcePort, format: "u8", rate: 9600 } },
				{ id: "scope", type: "scope", params: { samples: 1000 } }
			], links: [["sig", "out"], ["in", "scope"]] };
			const bridge = blockDocs.startBridge(graph);
			const u8 = Buffer.alloc(2000);
			for (let i = 0; i < u8.length; i++) {
				u8[i] = i & 0x7f;
			}
			let got = Buffer.alloc(0);
			let outWs = null;
			let inWs = null;
			return waitListen(sinkPort)
				.then(() => waitListen(sourcePort))
				.then(() => connectWs(sinkPort))
				.then((ws) => {
					outWs = ws;
					ws.on("message", (data) => {
						got = Buffer.concat([got, data]);
					});
					return connectWs(sourcePort);
				})
				.then((ws) => {
					inWs = ws;
					const timer = setInterval(() => {
						if (ws.readyState === WsClient.OPEN) {
							ws.send(u8);
						}
					}, 20);
					ws.on("close", () => clearInterval(timer));
					return wait(1500);
				})
				.then(() => bridge.client.command("stats"))
				.then((stats) => {
					kill(bridge);
					if (outWs) {
						outWs.close();
					}
					if (inWs) {
						inWs.close();
					}
					expect(stats.out.error).toBeFalsy();
					expect(stats["in"].error).toBeFalsy();
					expect(got.length % 4).toBe(0); // cs16 = 4 bytes per sample
					expect(got.length).toBeGreaterThan(1000);
					expect(stats["in"].out).toBeGreaterThan(0);
					expect(stats.scope.in).toBeGreaterThan(0);
				}, (err) => {
					kill(bridge);
					if (outWs) {
						outWs.close();
					}
					if (inWs) {
						inWs.close();
					}
					throw err;
				});
		});
}, 30000);
