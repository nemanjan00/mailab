const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");
const visionModule = require("..");
const labModule = require("../../lab");
const web = require("../../web");

const PNG = Buffer.from("89504e470d0a1a0a0000", "hex");
const MCP_HEADERS = { accept: "application/json, text/event-stream", "content-type": "application/json" };

// bridge whose replies the test releases by hand
const fakeBridge = (reply) => {
	const calls = [];
	const bridge = {
		calls: calls,
		inflightCount: 0,
		inflight: () => bridge.inflightCount,
		running: () => true,
		request: (command, args) => new Promise((resolve, reject) => {
			calls.push({ command: command, args: args, resolve: resolve, reject: reject });
		}),
		// answer the oldest open "watch" call, then wait out the 30 fps cap (waitMs 0: just settle)
		answer: (rois, waitMs) => {
			const call = calls.find((c) => c.command === "watch" && !c.done);
			call.done = true;
			call.resolve(reply ? reply(call, rois) : { rois: rois, ms: 3, size: [100, 50], annotated: PNG.toString("base64") });
			if (waitMs === 0) {
				return new Promise((resolve) => setImmediate(resolve));
			}
			return new Promise((resolve) => setTimeout(resolve, waitMs || 40));
		},
		open: () => calls.filter((c) => c.command === "watch" && !c.done),
		stop: () => Promise.resolve()
	};
	return bridge;
};

const fakeDeps = (bridge) => {
	const images = {};
	const handlers = [];
	const deps = {
		bridge: bridge,
		samples: [],
		notes: [],
		values: {},
		set: [],
		changes: 0,
		getImage: (name) => {
			if (!images[name]) {
				throw new Error("unknown image: " + name);
			}
			return images[name];
		},
		setImage: (name, data, mime) => {
			deps.set.push(name);
			images[name] = { data: data, mime: mime, t: Date.now() };
		},
		sample: (name, value) => deps.samples.push([name, value]),
		setValue: (name, value) => {
			deps.values[name] = value;
		},
		notify: (ev) => deps.notes.push(ev),
		onImage: (handler) => {
			handlers.push(handler);
			return () => handlers.splice(handlers.indexOf(handler), 1);
		},
		onChange: () => {
			deps.changes++;
		},
		// a new frame of `name`
		frame: (name) => {
			images[name] = { data: PNG, mime: "image/png", t: Date.now() };
			handlers.slice().forEach((h) => h({ name: name }));
		},
		handlers: handlers
	};
	return deps;
};

const WATCH = {
	name: "bench",
	image: "cam_frame",
	fps: 1000,
	rois: [
		{ name: "led", rect: [0, 0, 10, 10], kind: "led" },
		{ name: "num", rect: [10, 0, 40, 20], kind: "seven_seg", params: { count: 4 }, above: 100 }
	]
};

describe("vision watches", () => {
	test("validation", () => {
		expect(() => visionModule.normalize({ name: "bad-name", image: "x", rois: [] })).toThrow(/watch name/);
		expect(() => visionModule.normalize({ name: "w", rois: [] })).toThrow(/image/);
		expect(() => visionModule.normalize({ name: "w", image: "w_annotated" })).toThrow(/own annotated/);
		expect(() => visionModule.normalize({ name: "w", image: "x", rois: [{ name: "a", rect: [0, 0, 1, 1], kind: "laser" }] })).toThrow(/kind/);
		expect(() => visionModule.normalize({ name: "w", image: "x", rois: [{ name: "a", rect: [0, 0, 0, 1], kind: "led" }] })).toThrow(/rect/);
		expect(() => visionModule.normalize({ name: "w", image: "x", rois: [{ name: "a", rect: [0, 0, 1, 1], kind: "led" }, { name: "a", rect: [0, 0, 1, 1], kind: "led" }] })).toThrow(/duplicate/);
		const w = visionModule.normalize({ name: "w", image: "x", fps: 100, rois: [{ name: "a", rect: [0, 0, 1, 1], kind: "led", above: 3 }] });
		expect(w.fps).toBe(30);
		expect(w.annotate).toBe(true);
		expect(w.rois[0].above).toBe(3);
	});

	test("frames become channels, values, annotated images and change notifications", () => {
		const bridge = fakeBridge();
		const deps = fakeDeps(bridge);
		const vision = visionModule.create(deps);
		vision.start();
		vision.add(WATCH);
		expect(deps.changes).toBe(1);
		deps.frame("cam_frame");
		expect(bridge.open().length).toBe(1);
		const sent = bridge.open()[0].args;
		expect(sent.key).toBe("bench");
		expect(sent.rois.map((r) => r.kind)).toEqual(["led", "seven_seg"]);
		return bridge.answer({ led: { on: false, color: "off", value: 0, text: "off" }, num: { text: "0042", value: 42 } })
			.then(() => {
				expect(deps.samples).toEqual([["bench_led", 0], ["bench_num", 42]]);
				expect(deps.notes).toEqual([]);
				expect(deps.set).toContain("bench_annotated");
				expect(deps.values.bench_vision.rois.num.state).toBe("0042");
				deps.frame("cam_frame");
				return bridge.answer({ led: { on: true, color: "red", value: 1, text: "red" }, num: { text: "Err", value: null } });
			})
			.then(() => {
				expect(deps.samples.slice(2)).toEqual([["bench_led", 1]]);
				expect(deps.notes.map((n) => n.line)).toEqual(["bench.led: LED turned red", "bench.num: display shows \"Err\" (was \"0042\")"]);
				expect(deps.notes[0]).toMatchObject({ type: "vision", watch: "bench", roi: "led", state: "on red", prev: "off" });
				deps.frame("cam_frame");
				return bridge.answer({ led: { on: true, color: "red", value: 1 }, num: { text: "0150", value: 150 } });
			})
			.then(() => {
				// "Err" -> 150 is a change and a crossing above 100 (the Err frame had no value)
				const lines = deps.notes.slice(2).map((n) => n.line);
				expect(lines).toContain("bench.num: display shows \"0150\" (was \"Err\")");
				expect(vision.describe("bench").stats).toMatchObject({ seen: 3, frames: 3, dropped: 0, errors: 0 });
				expect(vision.describe("bench").last.led.state).toBe("on red");
			});
	});

	test("threshold crossings notify once per crossing", () => {
		const bridge = fakeBridge();
		const deps = fakeDeps(bridge);
		const vision = visionModule.create(deps);
		vision.start();
		vision.add({ name: "w", image: "img", fps: 1000, rois: [{ name: "t", rect: [0, 0, 5, 5], kind: "color", above: 50, notify: "none" }] });
		const step = (hue) => {
			deps.frame("img");
			return bridge.answer({ t: { value: hue, color: "x", text: "x" } });
		};
		return step(10).then(() => step(60)).then(() => step(70)).then(() => step(20)).then(() => step(90)).then(() => {
			expect(deps.notes.map((n) => n.value)).toEqual([60, 90]);
			expect(deps.notes[0]).toMatchObject({ threshold: "above", limit: 50, roi: "t" });
		});
	});

	test("stable: a flickering state is not reported", () => {
		const bridge = fakeBridge();
		const deps = fakeDeps(bridge);
		const vision = visionModule.create(deps);
		vision.start();
		vision.add({ name: "w", image: "img", fps: 1000, rois: [{ name: "d", rect: [0, 0, 5, 5], kind: "value_ocr", stable: 2 }] });
		const step = (text) => {
			deps.frame("img");
			return bridge.answer({ d: { text: text, value: Number(text) } });
		};
		return step("1").then(() => step("1")).then(() => step("7")).then(() => step("1")).then(() => step("2")).then(() => step("2")).then(() => {
			expect(deps.notes.map((n) => n.state)).toEqual(["2"]);
		});
	});

	test("busy bridge: frames coalesce to the latest, the rest are dropped", () => {
		const bridge = fakeBridge();
		const deps = fakeDeps(bridge);
		const vision = visionModule.create(deps);
		vision.start();
		vision.add(WATCH);
		deps.frame("cam_frame");
		deps.frame("cam_frame");
		deps.frame("cam_frame");
		deps.frame("cam_frame");
		// one evaluation out; frames 2..4 collapse into one queued evaluation
		expect(bridge.open().length).toBe(1);
		expect(vision.stats("bench")).toMatchObject({ seen: 4, dropped: 2 });
		return bridge.answer({}).then(() => {
			expect(bridge.open().length).toBe(1);
			return bridge.answer({});
		}).then(() => {
			expect(bridge.open().length).toBe(0);
			expect(vision.stats("bench")).toMatchObject({ seen: 4, frames: 2, dropped: 2 });
		});
	});

	test("fps cap delays the next frame; too many requests in flight hold frames back", () => {
		jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
		const bridge = fakeBridge();
		const deps = fakeDeps(bridge);
		const vision = visionModule.create(deps);
		vision.start();
		vision.add(Object.assign({}, WATCH, { fps: 2 }));
		deps.frame("cam_frame");
		return bridge.answer({}, 0).then(() => {
			deps.frame("cam_frame");
			deps.frame("cam_frame");
			// within 500 ms of the last run: held by the rate timer
			expect(bridge.open().length).toBe(0);
			jest.advanceTimersByTime(499);
			expect(bridge.open().length).toBe(0);
			jest.advanceTimersByTime(2);
			expect(bridge.open().length).toBe(1);
			expect(vision.stats("bench").dropped).toBe(1);
			return bridge.answer({}, 0);
		}).then(() => {
			bridge.inflightCount = visionModule.MAX_INFLIGHT;
			jest.advanceTimersByTime(1000);
			deps.frame("cam_frame");
			expect(bridge.open().length).toBe(0);
			bridge.inflightCount = 0;
			jest.advanceTimersByTime(500);
			expect(bridge.open().length).toBe(1);
			vision.stop();
		}).finally(() => {
			jest.useRealTimers();
		});
	});

	test("bridge errors are counted and logged once; other images and removed watches are ignored", () => {
		const bridge = fakeBridge();
		const deps = fakeDeps(bridge);
		const logs = [];
		deps.log = (text) => logs.push(text);
		const vision = visionModule.create(deps);
		vision.start();
		vision.add(WATCH);
		deps.frame("other");
		expect(bridge.open().length).toBe(0);
		deps.frame("cam_frame");
		bridge.open()[0].done = true;
		bridge.calls[0].reject(new Error("bridge down"));
		return new Promise((resolve) => setTimeout(resolve, 40)).then(() => {
			deps.frame("cam_frame");
			const call = bridge.open()[0];
			call.done = true;
			call.reject(new Error("bridge down"));
			return new Promise((resolve) => setImmediate(resolve));
		}).then(() => {
			expect(vision.stats("bench")).toMatchObject({ errors: 2, lastError: "bridge down" });
			expect(logs).toEqual(["watch bench: bridge down"]);
			vision.remove("bench");
			expect(bridge.calls.some((c) => c.command === "forget")).toBe(true);
			deps.frame("cam_frame");
			expect(bridge.open().length).toBe(0);
			expect(() => vision.describe("bench")).toThrow(/no vision watch/);
		});
	});

	test("template params are sent as image data", () => {
		const bridge = fakeBridge();
		const deps = fakeDeps(bridge);
		const vision = visionModule.create(deps);
		vision.start();
		deps.setImage("icon", Buffer.from("abc"), "image/png");
		vision.add({ name: "w", image: "img", rois: [{ name: "b", rect: [0, 0, 5, 5], kind: "template", params: { template: "icon" } }] });
		deps.frame("img");
		expect(bridge.open()[0].args.rois[0].params.template_data).toBe(Buffer.from("abc").toString("base64"));
	});

	test("run resolves op images and stores the annotated output", () => {
		const bridge = fakeBridge();
		const deps = fakeDeps(bridge);
		const vision = visionModule.create(deps);
		deps.setImage("photo", PNG, "image/png");
		deps.setImage("ref", Buffer.from("r"), "image/png");
		expect(() => vision.run({ image: "photo", ops: [{ op: "explode" }] })).toThrow(/unknown op/);
		const done = vision.run({ image: "photo", ops: [{ op: "align", reference: "ref" }, { op: "gray" }], output: "photo_gray" });
		const call = bridge.calls[0];
		expect(call.command).toBe("run");
		expect(call.args.ops[0].reference_data).toBe(Buffer.from("r").toString("base64"));
		call.resolve({ results: [{ op: "align" }, { op: "gray" }], ms: 5, size: [1, 1], annotated: PNG.toString("base64"), output: PNG.toString("base64") });
		return done.then((out) => {
			expect(out.annotated).toBe("photo_annotated");
			expect(out.output).toBe("photo_gray");
			expect(deps.set).toEqual(expect.arrayContaining(["photo_annotated", "photo_gray"]));
		});
	});

	test("sniffMime", () => {
		expect(visionModule.sniffMime(PNG)).toBe("image/png");
		expect(visionModule.sniffMime(Buffer.from("ffd8ffe0", "hex"))).toBe("image/jpeg");
		expect(visionModule.sniffMime(Buffer.from("hello"))).toBe("application/octet-stream");
	});
});

describe("vision in the lab", () => {
	const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mailab-vision-"));

	test("watches persist, restart with the lab and survive export / import", () => {
		const dataDir = tmp();
		const bridge = fakeBridge();
		const lab = labModule.create({ dataDir: dataDir, channelCapacity: 1000, watchUsb: false, visionBridge: bridge });
		let lab2;
		return lab.restore().then(() => {
			lab.vision.add(WATCH);
			const exported = lab.exportState();
			expect(exported.vision.map((w) => w.name)).toEqual(["bench"]);
			return lab.shutdown().then(() => exported);
		}).then((exported) => {
			const bridge2 = fakeBridge();
			lab2 = labModule.create({ dataDir: dataDir, channelCapacity: 1000, watchUsb: false, visionBridge: bridge2 });
			return lab2.restore().then(() => {
				expect(lab2.vision.list().map((w) => w.name)).toEqual(["bench"]);
				lab2.setImage("cam_frame", PNG, "image/png");
				expect(bridge2.open().length).toBe(1);
				return bridge2.answer({ led: { on: true, color: "green", value: 1 }, num: { text: "12", value: 12 } });
			}).then(() => {
				expect(lab2.channels.latest("bench_led").v).toBe(1);
				expect(lab2.channels.latest("bench_num").v).toBe(12);
				expect(lab2.getValue("bench_vision").value.rois.led.state).toBe("on green");
				expect(lab2.listImages().map((i) => i.name)).toContain("bench_annotated");
				return lab2.importState(Object.assign({}, exported, { vision: [] }));
			}).then(() => {
				expect(lab2.vision.list()).toEqual([]);
				return lab2.shutdown();
			});
		});
	});

	test("REST + MCP: upload an image, add a watch over REST, notifications reach the lab feed", () => {
		const bridge = fakeBridge();
		const lab = labModule.create({ dataDir: tmp(), channelCapacity: 1000, watchUsb: false, visionBridge: bridge });
		const created = web.create(lab, { pushIntervalMs: 50 });
		const app = created.app;
		const mcp = (name, args) => request(app).post("/mcp").set(MCP_HEADERS).send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: name, arguments: args || {} } });
		return lab.restore()
			.then(() => request(app).put("/api/images/cam_frame").set("content-type", "application/octet-stream").send(PNG).expect(200))
			.then((res) => {
				expect(res.body.mime).toBe("image/png");
				return request(app).put("/api/vision/watches/bench").send({ image: "cam_frame", fps: 1000, rois: [{ name: "led", rect: [0, 0, 4, 4], kind: "led" }] }).expect(200);
			})
			.then((res) => {
				expect(res.body.name).toBe("bench");
				// the current frame is evaluated right away
				expect(bridge.open().length).toBe(1);
				return bridge.answer({ led: { on: false, color: "off", value: 0 } });
			})
			.then(() => {
				lab.setImage("cam_frame", PNG, "image/png");
				return bridge.answer({ led: { on: true, color: "green", value: 1 } });
			})
			.then(() => mcp("notifications_read", { types: ["vision"] }))
			.then((res) => {
				const events = JSON.parse(res.body.result.content[0].text);
				expect(events.map((e) => e.line)).toEqual(["bench.led: LED turned green"]);
				return mcp("vision_watches");
			})
			.then((res) => {
				expect(JSON.parse(res.body.result.content[0].text)[0].stats.frames).toBe(2);
				return mcp("vision_ops");
			})
			.then((res) => {
				expect(Object.keys(JSON.parse(res.body.result.content[0].text).kinds)).toContain("seven_seg");
				return mcp("image_write", { name: "ref", data: PNG.toString("base64") });
			})
			.then((res) => {
				expect(JSON.parse(res.body.result.content[0].text).mime).toBe("image/png");
				return request(app).delete("/api/vision/watches/bench").expect(200);
			})
			.then(() => {
				created.server.close();
				return lab.shutdown();
			});
	});
});
