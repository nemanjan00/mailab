const fs = require("fs");
const os = require("os");
const path = require("path");
const labModule = require("../../lab");
const captureModule = require("..");

const RW = { name: "alice", role: "rw" };
const RO = { name: "viewer", role: "ro" };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64), Buffer.from([0xff, 0xd9])]);

const pcmChunk = (frames, channels, value) => {
	const buf = Buffer.alloc(frames * channels * 2);
	for (let i = 0; i < frames * channels; i++) {
		buf.writeInt16LE(value === undefined ? 8192 : value, i * 2);
	}
	return buf.toString("base64");
};

describe("browser capture", () => {
	let lab;
	let hub;

	const client = (who) => {
		const sent = [];
		const c = hub.connect(who || RW, (msg) => sent.push(msg));
		c.sent = sent;
		return c;
	};

	const start = (c, device, extra) => hub.message(c, Object.assign({ type: "capture_start", device: device, ref: 1, mic: { rate: 16000, channels: 1 }, cam: { fps: 2 } }, extra || {}));

	beforeEach(() => {
		lab = labModule.create({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mailab-capture-")), channelCapacity: 1000 });
		hub = captureModule.create(lab);
		return lab.restore();
	});

	afterEach(() => lab.shutdown());

	test("read-only identities can't push media", () => {
		return expect(start(client(RO), "phone")).rejects.toThrow(/read-only/).then(() => {
			expect(lab.listDevices().length).toBe(0);
		});
	});

	test("unknown messages and bad names are rejected", () => {
		const c = client();
		return Promise.all([
			expect(hub.message(c, { type: "state" })).rejects.toThrow(/unknown capture message/),
			expect(hub.message(c, null)).rejects.toThrow(/unknown capture message/),
			expect(start(c, "1phone")).rejects.toThrow(/invalid device name/),
			expect(start(c, "a b")).rejects.toThrow(/invalid device name/),
			expect(start(c, "x".repeat(60))).rejects.toThrow(/invalid device name/),
			expect(start(c, "phone", { mic: { rate: 96000 } })).rejects.toThrow(/mic rate/),
			expect(start(c, "phone", { mic: { rate: 16000, channels: 3 } })).rejects.toThrow(/channels/),
			expect(start(c, "phone", { cam: { fps: 30 } })).rejects.toThrow(/fps/),
			expect(start(c, "phone", { mic: null, cam: null })).rejects.toThrow(/nothing to capture/)
		]);
	});

	test("start registers a running browser device; disconnect stops it", () => {
		const c = client();
		return start(c, "phone").then((reply) => {
			expect(reply).toMatchObject({ type: "capture_started", device: "phone", ref: 1, mic: { rate: 16000, channels: 1 }, cam: { fps: 2 } });
			const dev = lab.describeDevice("phone");
			expect(dev.driver).toBe("browser");
			expect(dev.state).toBe("running");
			expect(dev.detail).toMatch(/alice: mic 16000 Hz, camera 2 fps/);
			hub.disconnect(c);
			expect(lab.describeDevice("phone").state).toBe("stopped");
			expect(lab.describeDevice("phone").detail).toMatch(/disconnected/);
			return expect(lab.commandDevice("phone", "snapshot", {})).rejects.toThrow(/stopped/);
		});
	});

	test("an existing non-browser device can't be captured into; another browser can't take over", () => {
		const a = client();
		const b = client({ name: "bob", role: "human" });
		return lab.addDevice("simdev", "sim", {})
			.then(() => expect(start(a, "simdev")).rejects.toThrow(/not a browser capture/))
			.then(() => start(a, "phone"))
			.then(() => expect(start(b, "phone")).rejects.toThrow(/already streaming from alice/))
			.then(() => {
				hub.disconnect(a);
				return start(b, "phone");
			})
			.then((reply) => {
				expect(reply.type).toBe("capture_started");
				expect(lab.describeDevice("phone").detail).toMatch(/bob/);
			});
	});

	test("caps the number of captures per browser", () => {
		const c = client();
		const names = ["d1", "d2", "d3", "d4"];
		return names.reduce((p, name) => p.then(() => start(c, name)), Promise.resolve())
			.then(() => expect(start(c, "d5")).rejects.toThrow(/too many captures/));
	});

	test("audio chunks become the <dev>_mic stream and level channels", () => {
		const c = client();
		const chunks = [];
		lab.events.on("audio", (chunk) => chunks.push(chunk));
		return start(c, "phone")
			.then(() => hub.message(c, { type: "capture_audio", device: "phone", rate: 16000, channels: 1, data: pcmChunk(800, 1) }))
			.then((reply) => {
				expect(reply).toBe(null);
				expect(chunks.length).toBe(1);
				expect(chunks[0]).toMatchObject({ name: "phone_mic", rate: 16000 });
				expect(chunks[0].channels).toBeUndefined();
				// 8192 / 32768 = -12.04 dBFS, DC so RMS = peak
				expect(lab.channels.latest("phone_mic_level").v).toBeCloseTo(-12.04, 1);
				expect(lab.channels.latest("phone_mic_peak").v).toBeCloseTo(-12.04, 1);
				expect(lab.channels.list().find((ch) => ch.name === "phone_mic_level").unit).toBe("dBFS");
			});
	});

	test("stereo chunks keep their channel count", () => {
		const c = client();
		const chunks = [];
		lab.events.on("audio", (chunk) => chunks.push(chunk));
		return start(c, "phone", { mic: { rate: 48000, channels: 2 } })
			.then(() => hub.message(c, { type: "capture_audio", device: "phone", rate: 48000, channels: 2, data: pcmChunk(480, 2) }))
			.then(() => {
				expect(chunks[0].channels).toBe(2);
			});
	});

	test("audio validation: format, framing, size, base64, ownership", () => {
		const c = client();
		const other = client({ name: "eve", role: "rw" });
		const audio = (extra, who) => hub.message(who || c, Object.assign({ type: "capture_audio", device: "phone", rate: 16000, channels: 1, data: pcmChunk(10, 1) }, extra));
		return start(c, "phone").then(() => Promise.all([
			expect(audio({ rate: 8000 })).rejects.toThrow(/format differs/),
			expect(audio({ channels: 2 })).rejects.toThrow(/format differs/),
			expect(audio({ data: Buffer.alloc(3).toString("base64") })).rejects.toThrow(/whole int16 frames/),
			expect(audio({ data: "@@@@" })).rejects.toThrow(/not base64/),
			expect(audio({ data: "" })).rejects.toThrow(/data \(base64\) required/),
			expect(audio({ data: Buffer.alloc(captureModule.LIMITS.maxChunkBytes + 4).toString("base64") })).rejects.toThrow(/too large/),
			expect(audio({}, other)).rejects.toThrow(/not capturing into phone/),
			expect(audio({ device: "nope" })).rejects.toThrow(/not capturing into nope/)
		]));
	});

	test("audio beyond the announced rate is dropped", () => {
		const c = client();
		let count = 0;
		lab.events.on("audio", () => count++);
		const send = () => hub.message(c, { type: "capture_audio", device: "phone", rate: 8000, channels: 1, data: pcmChunk(4000, 1) });
		// 8000 Hz * 1.5 slack = 12000 frames per second: three 4000-frame chunks pass, the rest drop
		return start(c, "phone", { mic: { rate: 8000 } })
			.then(() => [1, 2, 3, 4, 5].reduce((p) => p.then(send), Promise.resolve()))
			.then(() => lab.commandDevice("phone", "status"))
			.then((status) => {
				expect(count).toBe(3);
				expect(status.chunks).toBe(3);
				expect(status.dropped).toBe(2);
			});
	});

	test("frames: validated, stored as <dev>_frame, rate capped", () => {
		const c = client();
		const frame = (extra) => hub.message(c, Object.assign({ type: "capture_frame", device: "phone", mime: "image/jpeg", data: JPEG.toString("base64") }, extra));
		return start(c, "phone", { mic: null })
			.then(() => Promise.all([
				expect(frame({ data: Buffer.from("not an image").toString("base64") })).rejects.toThrow(/not a valid image\/jpeg/),
				expect(frame({ mime: "image/svg+xml" })).rejects.toThrow(/image type/),
				expect(frame({ data: Buffer.alloc(captureModule.LIMITS.maxFrameBytes + 3).toString("base64") })).rejects.toThrow(/too large/)
			]))
			.then(() => frame())
			.then(() => {
				expect(lab.getImage("phone_frame").data.equals(JPEG)).toBe(true);
				expect(lab.getImage("phone_frame").mime).toBe("image/jpeg");
				// 2 fps: an immediate second frame is dropped
				return frame();
			})
			.then(() => lab.commandDevice("phone", "status"))
			.then((status) => {
				expect(status.frames).toBe(1);
				expect(status.dropped).toBe(1);
				// user snapshots bypass the frame rate, but have their own cap
				return frame({ snapshot: true });
			})
			.then((reply) => {
				expect(reply).toMatchObject({ type: "capture_snapshot_saved", image: "phone_snapshot" });
				expect(lab.getImage("phone_snapshot").data.equals(JPEG)).toBe(true);
				return frame({ snapshot: true });
			})
			.then(() => expect(frame({ snapshot: true })).rejects.toThrow(/too many snapshots/));
	});

	test("frames without a started camera are refused", () => {
		const c = client();
		return start(c, "phone", { cam: null })
			.then(() => expect(hub.message(c, { type: "capture_frame", device: "phone", mime: "image/jpeg", data: JPEG.toString("base64") })).rejects.toThrow(/camera not started/));
	});

	test("snapshot command asks the browser and returns its frame", () => {
		const c = client();
		return start(c, "phone", { mic: null })
			.then(() => {
				const pending = lab.commandDevice("phone", "snapshot", {});
				const ask = c.sent.find((m) => m.type === "capture_snapshot");
				expect(ask).toMatchObject({ device: "phone" });
				return hub.message(c, { type: "capture_frame", device: "phone", mime: "image/jpeg", data: JPEG.toString("base64"), request: ask.request })
					.then(() => pending);
			})
			.then((result) => {
				expect(result.image).toBe("phone_snapshot");
				expect(result._image).toEqual({ data: JPEG.toString("base64"), mime: "image/jpeg" });
				// a second answer to the same request is refused
				return expect(hub.message(c, { type: "capture_frame", device: "phone", mime: "image/jpeg", data: JPEG.toString("base64"), request: c.sent[0].request })).rejects.toThrow(/unknown snapshot request/);
			});
	});

	test("snapshot times out cleanly when the browser doesn't answer", () => {
		const c = client();
		return start(c, "phone", { mic: null })
			.then(() => expect(lab.commandDevice("phone", "snapshot", { timeout: 50 })).rejects.toThrow(/no snapshot from the browser within 50 ms/))
			.then(() => {
				expect(Object.keys(c.pending).length).toBe(0);
			});
	});

	test("snapshot without a camera fails at once; a disconnect rejects pending ones", () => {
		const c = client();
		return start(c, "mic_only", { cam: null })
			.then(() => expect(lab.commandDevice("mic_only", "snapshot", {})).rejects.toThrow(/no camera/))
			.then(() => start(c, "phone", { mic: null }))
			.then(() => {
				const pending = lab.commandDevice("phone", "snapshot", { timeout: 10000 });
				hub.disconnect(c);
				return expect(pending).rejects.toThrow(/ended before the snapshot arrived/);
			});
	});

	test("stopping the device in the lab tells the browser; a new start restarts it", () => {
		const c = client();
		return start(c, "phone")
			.then(() => lab.stopDevice("phone"))
			.then(() => {
				expect(c.sent).toContainEqual(expect.objectContaining({ type: "capture_stop", device: "phone" }));
				return expect(hub.message(c, { type: "capture_audio", device: "phone", rate: 16000, channels: 1, data: pcmChunk(10, 1) })).rejects.toThrow(/not capturing/);
			})
			.then(() => start(c, "phone"))
			.then(() => {
				expect(lab.describeDevice("phone").state).toBe("running");
			});
	});

	test("capture_stop detaches the device", () => {
		const c = client();
		return start(c, "phone")
			.then(() => hub.message(c, { type: "capture_stop", device: "phone", ref: 7 }))
			.then((reply) => {
				expect(reply).toEqual({ type: "capture_stopped", device: "phone", ref: 7 });
				expect(lab.describeDevice("phone").state).toBe("stopped");
				expect(lab.describeDevice("phone").detail).toMatch(/stopped capturing/);
			});
	});
});
