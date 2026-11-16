const kaitai = require("..");

const KSY = [
	"meta:",
	"  id: demo",
	"  endian: le",
	"seq:",
	"  - id: magic",
	"    contents: [0x4d, 0x4c]",
	"  - id: count",
	"    type: u2",
	"  - id: items",
	"    type: item",
	"    repeat: expr",
	"    repeat-expr: count",
	"types:",
	"  item:",
	"    seq:",
	"      - id: kind",
	"        type: u1",
	"      - id: value",
	"        type: u4",
	"instances:",
	"  total:",
	"    value: count * 5"
].join("\n");

describe("kaitai", () => {
	test("parses fields, instances and byte ranges", () => {
		const data = Buffer.from("4d4c0200" + "0178563412" + "02efbeadde", "hex");
		return kaitai.parse(KSY, data).then((r) => {
			expect(r.type).toBe("Demo");
			expect(r.error).toBeNull();
			expect(r.tree.count).toBe(2);
			expect(r.tree.items[1]).toEqual({ kind: 2, value: 0xdeadbeef });
			expect(r.tree.total).toBe(10);
			expect(r.ranges[".items[1].value"]).toEqual([10, 14]);
		});
	});

	test("keeps what parsed before running out of data", () => {
		return kaitai.parse(KSY, Buffer.from("4d4c0200017856", "hex")).then((r) => {
			expect(r.error).toBeTruthy();
			expect(r.tree.count).toBe(2);
		});
	});
});
