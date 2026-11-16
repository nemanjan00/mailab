const camera = require("..");

describe("camera jpeg splitter", () => {
	test("splits concatenated JPEGs across chunk boundaries", () => {
		const frames = [];
		const feed = camera._jpegSplitter((frame) => {
			frames.push(frame.toString("hex"));
		});
		const a = Buffer.from("ffd80102ffd9", "hex");
		const b = Buffer.from("ffd8030405ffd9", "hex");
		const stream = Buffer.concat([a, b]);
		feed(stream.slice(0, 4));
		feed(stream.slice(4, 9));
		feed(stream.slice(9));
		expect(frames).toEqual([a.toString("hex"), b.toString("hex")]);
	});
});
