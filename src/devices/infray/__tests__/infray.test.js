// InfiRay driver against a fake source: the input option feeds ffmpeg's
// lavfi testsrc instead of a real v4l2 device. Requires ffmpeg in PATH.

const spawnSync = require("child_process").spawnSync;
const infray = require("..");

const hasFfmpeg = spawnSync("sh", ["-c", "command -v ffmpeg"]).status === 0;

const fakeIo = () => {
	const io = { id: "ir1", images: {}, logs: [] };
	io.log = (text, level) => io.logs.push([level, text]);
	io.status = () => {};
	io.image = (name, data, mime) => {
		io.images[name] = { data: data, mime: mime };
	};
	return io;
};

describe("infray driver", () => {
	if (!hasFfmpeg) {
		test.skip("needs ffmpeg", () => {});
		return;
	}

	test("frame grabs a JPEG from the (lavfi) source into an image", () => {
		const io = fakeIo();
		const dev = infray.create({ input: "testsrc=size=160x120:rate=1", timeoutMs: 20000 }, io);
		return dev.start().then(() => dev.command("frame", { name: "shot" })).then((r) => {
			expect(r.image).toBe("ir1_shot");
			expect(r.bytes).toBeGreaterThan(500);
			expect(io.images.shot.data.slice(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // JPEG SOI
			expect(io.images.shot.mime).toBe("image/jpeg");
		});
	});

	test("stream emits frames and stops", () => {
		const io = fakeIo();
		const dev = infray.create({ input: "testsrc=size=80x60:rate=2", timeoutMs: 20000 }, io);
		return dev.start().then(() => {
			return dev.command("stream", { intervalMs: 250 });
		}).then((r) => {
			expect(r.streaming).toBe(true);
			return new Promise((resolve) => setTimeout(resolve, 900));
		}).then(() => {
			expect(Object.keys(io.images).length).toBeGreaterThanOrEqual(1);
			return dev.command("stream", { on: false });
		}).then((r) => {
			expect(r.streaming).toBe(false);
			return dev.stop();
		});
	});

	test("a missing source reports a reason", () => {
		const io = fakeIo();
		const dev = infray.create({ input: "nonexistentfilter=1", timeoutMs: 10000 }, io);
		return dev.start().then(() => dev.command("frame", {})).then(() => {
			throw new Error("should have failed");
		}, (err) => {
			expect(String(err)).toMatch("ffmpeg");
		});
	});
});
