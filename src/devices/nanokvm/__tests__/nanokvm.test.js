// nanokvm driver against the fake NanoKVM (src/services/nanokvm/__fixtures__):
// login and re-login, HID message encoding, screen frames, power, media,
// stream settings, reconnect, approvals. No hardware.

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const spawnSync = require("child_process").spawnSync;
const request = require("supertest");
const nanokvm = require("..");
const fake = require("../../../services/nanokvm/__fixtures__/fake-server");
const safety = require("../../../safety");
const labModule = require("../../../lab");
const web = require("../../../web");

const MCP = { accept: "application/json, text/event-stream", "content-type": "application/json" };
const hasMagick = spawnSync("magick", ["-version"]).status === 0;
const withMagick = hasMagick ? test : test.skip;

const until = (cond, ms) => new Promise((resolve, reject) => {
	const started = Date.now();
	const poll = () => {
		const v = cond();
		if (v) {
			resolve(v);
		} else if (Date.now() - started > (ms || 3000)) {
			reject(new Error("timeout"));
		} else {
			setTimeout(poll, 5);
		}
	};
	poll();
});

const mockIo = () => {
	const io = { id: "kvm", images: [], logs: [], statuses: [] };
	io.image = (name, data, mime) => io.images.push({ name: name, data: data, mime: mime });
	io.log = (text, level) => io.logs.push({ text: text, level: level });
	io.status = (state, detail) => io.statuses.push({ state: state, detail: detail });
	io.value = () => null;
	return io;
};

// a real JPEG (16x8), black, optionally with a white box
const jpeg = (box) => {
	if (hasMagick) {
		const args = ["-size", "16x8", "xc:black"].concat(box ? ["-fill", "white", "-draw", "rectangle " + box] : []).concat(["-sampling-factor", "1x1", "-quality", "95", "jpeg:-"]);
		return spawnSync("magick", args).stdout;
	}
	// a minimal header-only JPEG (SOI + SOF0 16x8 + EOI): enough for size sniffing
	return Buffer.from("ffd8ffc0000b080008001003012200ffd9", "hex");
};

const readPng = (buf) => {
	const width = buf.readUInt32BE(16);
	const height = buf.readUInt32BE(20);
	const idatLen = buf.readUInt32BE(33);
	return { width: width, height: height, raw: zlib.inflateSync(buf.subarray(41, 41 + idatLen)) };
};

describe("nanokvm driver", () => {
	let server;
	let io;
	let dev;

	const startDev = (fakeOpts, devOpts) => fake.start(Object.assign({ password: "s3cret pw", frame: jpeg(), chunk: 7 }, fakeOpts)).then((s) => {
		server = s;
		io = mockIo();
		dev = nanokvm.create(Object.assign({ host: server.host, password: "s3cret pw" }, devOpts), io);
		return dev.start();
	}).then(() => until(() => io.statuses.some((s) => s.state === "running" || s.state === "error")));

	afterEach(() => {
		const d = dev;
		const s = server;
		dev = null;
		server = null;
		return (d ? d.stop() : Promise.resolve()).then(() => (s ? s.close() : null));
	});

	test("logs in (Set-Cookie session), opens the HID socket, never logs the password", () => {
		return startDev().then(() => {
			expect(io.statuses.pop().state).toBe("running");
			expect(server.logins).toEqual([{ username: "admin", password: "s3cret pw" }]);
			expect(server.sockets()).toBe(1);
			expect(JSON.stringify(io.logs)).not.toContain("s3cret");
			return dev.command("status");
		}).then((s) => {
			expect(s).toMatchObject({ connected: true, application: "2.5.4", hardware: "Beta", leds: { power: true, hdd: false, numLock: true, capsLock: false } });
			expect(JSON.stringify(s)).not.toContain("s3cret");
		});
	});

	test("token in the login body (older firmware / Pro) works the same", () => {
		return startDev({ tokenInBody: true }).then(() => {
			expect(io.statuses.pop().state).toBe("running");
			return dev.command("iso_list");
		}).then((r) => {
			expect(r.files).toContain("/data/debian.iso");
		});
	});

	test("logs in again on 401 and retries the request", () => {
		return startDev().then(() => {
			server.expire();
			return dev.command("iso_list");
		}).then((r) => {
			expect(r.files.length).toBe(2);
			expect(server.logins.length).toBe(2);
			return dev.command("status");
		}).then((s) => {
			expect(s.logins).toBe(2);
		});
	});

	test("a wrong password: error state with the device's message, slow retry", () => {
		return startDev({}, { password: "nope" }).then(() => {
			const last = io.statuses.pop();
			expect(last.state).toBe("error");
			expect(last.detail).toMatch(/invalid username or password/);
			expect(io.logs.some((l) => /in 300000 ms/.test(l.text))).toBe(true);
			expect(JSON.stringify(io.logs)).not.toContain("nope");
		});
	});

	test("type and key: 8-byte boot reports after event byte 1", () => {
		return startDev().then(() => dev.command("type", { text: "Hi", delayMs: 0 }))
			.then((r) => {
				expect(r).toEqual({ typed: 2 });
				return dev.command("key", { keys: "ctrl+alt+del", delayMs: 0 });
			})
			.then(() => until(() => server.hidMessages().length >= 10))
			.then(() => {
				expect(server.hidMessages().map((m) => m.toString("hex"))).toEqual([
					"0102000b0000000000", "010000000000000000",
					"0100000c0000000000", "010000000000000000",
					"010100000000000000", "010500000000000000", "0105004c0000000000",
					"010500000000000000", "010100000000000000", "010000000000000000"
				]);
			});
	});

	test("mouse: absolute reports scaled from screen pixels to 1..0x7fff", () => {
		const abs = (m) => ({ buttons: m[1], x: m.readUInt16LE(2), y: m.readUInt16LE(4), wheel: m.readInt8(6) });
		return startDev().then(() => dev.command("click", { x: 15, y: 7, button: "right" }))
			.then((r) => {
				expect(r).toEqual({ x: 15, y: 7, double: false });
				return until(() => server.hidMessages().length >= 3);
			})
			.then(() => {
				const msgs = server.hidMessages().map(abs);
				expect(server.hidMessages().every((m) => m[0] === 2 && m.length === 7)).toBe(true);
				expect(msgs).toEqual([
					{ buttons: 0, x: 0x7fff, y: 0x7fff, wheel: 0 },
					{ buttons: 2, x: 0x7fff, y: 0x7fff, wheel: 0 },
					{ buttons: 0, x: 0x7fff, y: 0x7fff, wheel: 0 }
				]);
				server.hid.length = 0;
				return dev.command("move", { x: 0, y: 4 });
			})
			.then(() => until(() => server.hidMessages().length >= 1))
			.then(() => {
				expect(abs(server.hidMessages()[0])).toEqual({ buttons: 0, x: 1, y: Math.round(4 * 0x7fff / 7), wheel: 0 });
				server.hid.length = 0;
				return dev.command("scroll", { x: 8, y: 4, dy: -2 });
			})
			.then(() => until(() => server.hidMessages().length >= 5))
			.then(() => {
				expect(server.hidMessages().map((m) => m.readInt8(6))).toEqual([0, 1, 0, 1, 0]);
				expect(() => nanokvm._absoluteReport(0, 0, { width: 1, height: 1 }, 1, 0)).not.toThrow();
				return expect(dev.command("click", { x: 16, y: 0 })).rejects.toThrow(/x/);
			});
	});

	test("screenshot: the current JPEG frame as image <id>_screen", () => {
		return startDev().then(() => dev.command("screenshot")).then((r) => {
			expect(r).toMatchObject({ image: "kvm_screen", width: 16, height: 8 });
			expect(r._image.mime).toBe("image/jpeg");
			expect(Buffer.from(r._image.data, "base64").equals(server.frame)).toBe(true);
			expect(io.images.pop()).toMatchObject({ name: "screen", mime: "image/jpeg" });
		});
	});

	withMagick("screenshot of a region: cropped PNG", () => {
		return startDev({ frame: jpeg("4,2 7,5") }).then(() => dev.command("screenshot", { region: { x: 4, y: 2, w: 4, h: 4 } })).then((r) => {
			expect(r._image.mime).toBe("image/png");
			const img = readPng(Buffer.from(r._image.data, "base64"));
			expect([img.width, img.height]).toEqual([4, 4]);
			// row 1, pixel 1 is inside the white box
			const at = 1 * (4 * 3 + 1) + 1 + 1 * 3;
			expect(img.raw[at]).toBeGreaterThan(200);
		});
	});

	withMagick("wait_change: detects a change in the region, ignores others, times out", () => {
		return startDev().then(() => {
			const waiting = dev.command("wait_change", { region: { x: 8, y: 0, w: 8, h: 8 }, timeoutMs: 3000 });
			setTimeout(() => {
				server.frame = jpeg("10,2 12,4");
			}, 150);
			return waiting;
		}).then((r) => {
			expect(r).toMatchObject({ changed: true, settled: true, region: { x: 8, y: 0, w: 8, h: 8 } });
			const waiting = dev.command("wait_change", { region: { x: 8, y: 0, w: 8, h: 8 }, timeoutMs: 600 });
			// outside the region
			setTimeout(() => {
				server.frame = jpeg("10,2 12,4 rectangle 0,0 2,2");
			}, 100);
			return waiting;
		}).then((r) => {
			expect(r.changed).toBe(false);
		});
	});

	test("power: GPIO presses (short, long, reset) with LEDs before / after", () => {
		return startDev().then(() => dev.command("power", { action: "on" }))
			.then((r) => {
				expect(r).toMatchObject({ action: "on", button: "power", ms: 800, ledBefore: { power: true }, ledAfter: { power: true } });
				return dev.command("power", { action: "long_press" });
			})
			.then(() => dev.command("power", { action: "reset", durationMs: 300 }))
			.then(() => {
				expect(server.gpio).toEqual([{ type: "power", duration: 800 }, { type: "power", duration: 12000 }, { type: "reset", duration: 300 }]);
				return expect(dev.command("power", { action: "explode" })).rejects.toThrow(/action must be/);
			});
	});

	test("view-only refuses input, power and media; screenshots still work", () => {
		return startDev({}, { viewOnly: true }).then(() => Promise.all([
			expect(dev.command("type", { text: "x" })).rejects.toThrow(/view-only/),
			expect(dev.command("power", { action: "on" })).rejects.toThrow(/view-only/),
			expect(dev.command("iso_mount", { file: "debian.iso" })).rejects.toThrow(/view-only/),
			dev.command("screenshot")
		])).then(() => {
			expect(server.gpio).toEqual([]);
			expect(server.hidMessages()).toEqual([]);
		});
	});

	test("virtual media: list, mount by unique name, refuse unknown files, unmount", () => {
		return startDev().then(() => dev.command("iso_mount", { file: "debian.iso", cdrom: true }))
			.then((r) => {
				expect(r).toEqual({ mounted: "/data/debian.iso", cdrom: true });
				expect(server.mounts).toEqual([{ file: "/data/debian.iso", cdrom: true }]);
				return dev.command("iso_list");
			})
			.then((r) => {
				expect(r.mounted).toBe("/data/debian.iso");
				return expect(dev.command("iso_mount", { file: "../etc/shadow" })).rejects.toThrow(/no such image/);
			})
			.then(() => dev.command("iso_unmount"))
			.then((r) => {
				expect(r).toEqual({ unmounted: true, api: "media/eject" });
				expect(server.ejects).toBe(1);
			});
	});

	test("Pro API: stream settings and unmount fall back on 404", () => {
		return startDev({ pro: true }).then(() => dev.command("stream", { fps: 30, quality: 80 }))
			.then((r) => {
				expect(r).toMatchObject({ fps: 30, quality: 80, api: "stream/quality" });
				expect(server.screen).toEqual([{ api: "stream", fps: 30 }, { api: "stream", quality: 80 }]);
				return dev.command("iso_unmount");
			})
			.then((r) => {
				expect(r.api).toBe("image/mount");
				expect(server.mounts).toEqual([{ file: "", cdrom: false }]);
			});
	});

	test("Cube API: /api/vm/screen; push rate pushes frames into the lab", () => {
		return startDev().then(() => dev.command("stream", { fps: 25, quality: 60, push: 20 }))
			.then((r) => {
				expect(server.screen).toEqual([{ type: "fps", value: 25 }, { type: "quality", value: 60 }]);
				expect(r).toMatchObject({ push: 20, api: "vm/screen" });
				return until(() => io.images.length >= 1);
			})
			.then(() => {
				expect(io.images[0]).toMatchObject({ name: "screen", mime: "image/jpeg" });
				return expect(dev.command("stream", {})).rejects.toThrow(/give fps/);
			});
	});

	test("reconnects (and logs in again) when the KVM drops the HID socket", () => {
		return startDev().then(() => {
			server.expire();
			server.dropSockets();
			return until(() => io.statuses.filter((s) => s.state === "running").length >= 2, 5000);
		}).then(() => {
			expect(server.sockets()).toBe(1);
			expect(server.logins.length).toBe(2);
			return dev.command("status");
		}).then((s) => {
			expect(s).toMatchObject({ connected: true, reconnects: 1 });
		});
	});
});

describe("nanokvm approvals", () => {
	test("power (any action) and iso_mount need approval by default; input does not", () => {
		const s = safety.create({}, {});
		["on", "off", "reset", "long_press"].forEach((action) => {
			expect(s.needsApproval("kvm", "nanokvm", "power", { action: action })).toBeTruthy();
		});
		expect(s.needsApproval("kvm", "nanokvm", "iso_mount", { file: "x.iso" })).toBeTruthy();
		expect(s.needsApproval("kvm", "nanokvm", "iso_unmount", {})).toBeNull();
		expect(s.needsApproval("kvm", "nanokvm", "type", { text: "x" })).toBeNull();
		expect(s.needsApproval("kvm", "nanokvm", "screenshot", {})).toBeNull();
	});

	describe("through MCP", () => {
		let lab;
		let app;
		let httpServer;
		let kvmServer;

		const call = (name, args) => request(app).post("/mcp").set(MCP).send({
			jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: name, arguments: args || {} }
		});

		beforeAll(() => {
			lab = labModule.create({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "mailab-nanokvm-")), channelCapacity: 100 });
			const created = web.create(lab, { pushIntervalMs: 50 });
			app = created.app;
			httpServer = created.server;
			return lab.restore()
				.then(() => fake.start({ frame: jpeg() }))
				.then((s) => {
					kvmServer = s;
					return lab.addDevice("kvm", "nanokvm", { host: s.host, password: "admin" });
				})
				.then(() => until(() => lab.getDevice("kvm").state === "running"));
		});

		afterAll(() => {
			httpServer.close();
			return lab.shutdown().then(() => kvmServer.close());
		});

		test("an AI power press waits for a person; denied means no press", () => {
			const pending = call("device_command", { id: "kvm", command: "power", args: { action: "reset" } });
			const deny = until(() => lab.safety.listPending()[0]).then((p) => {
				expect(p.reason).toMatch(/ATX power/);
				return request(app).post("/api/approvals/" + p.id).send({ approve: false }).expect(200);
			});
			return Promise.all([pending, deny]).then((results) => {
				expect(results[0].body.result.isError).toBe(true);
				expect(results[0].body.result.content[0].text).toMatch(/not approved/);
				expect(kvmServer.gpio).toEqual([]);
			});
		});

		test("approved: the press happens; typing needs no approval", () => {
			const pending = call("device_command", { id: "kvm", command: "power", args: { action: "on" } });
			const approve = until(() => lab.safety.listPending()[0]).then((p) => request(app).post("/api/approvals/" + p.id).send({ approve: true }).expect(200));
			return Promise.all([pending, approve]).then((results) => {
				expect(results[0].body.result.isError).toBeFalsy();
				expect(kvmServer.gpio).toEqual([{ type: "power", duration: 800 }]);
				return call("device_command", { id: "kvm", command: "type", args: { text: "ok", delayMs: 0 } });
			}).then((res) => {
				expect(res.body.result.isError).toBeFalsy();
				expect(lab.safety.listPending()).toEqual([]);
				expect(kvmServer.hidMessages().length).toBe(4);
			});
		});
	});
});
