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

	describe("proto via protokai", () => {
		const PERSON_PROTO = [
			"syntax = \"proto3\";",
			"message Person {",
			"  string name = 1;",
			"  uint32 id = 2;",
			"  string email = 3;",
			"}"
		].join("\n");

		const fieldValue = (tree, tag) => {
			const entry = tree.entries.filter((e) => e.tagFieldNumber === tag)[0];
			return entry && entry.value && entry.value.value;
		};

		test("parses a .proto schema (converted to .ksy on the fly)", () => {
			// Person{name: "alice", id: 1, email: "a@b.c"}
			const data = Buffer.from("0a05616c69636510011a056140622e63", "hex");
			return kaitai.resolve({ proto: PERSON_PROTO }).then((spec) => {
				expect(Object.keys(spec.files)).toContain("person.ksy");
				return kaitai.parse(spec, data);
			}).then((r) => {
				expect(r.type).toBe("Person");
				expect(r.error).toBeNull();
				expect(fieldValue(r.tree, 1)).toBe("alice");
				expect(fieldValue(r.tree, 2)).toBe(1);
				expect(fieldValue(r.tree, 3)).toBe("a@b.c");
				expect(Object.keys(r.ranges).length).toBeGreaterThan(0);
			});
		});

		test("resolves imports from protoFiles and honors protoType", () => {
			const mainProto = [
				"syntax = \"proto3\";",
				"import \"phone.proto\";",
				"message Contact {",
				"  string name = 1;",
				"  Phone phone = 2;",
				"}"
			].join("\n");
			const phoneProto = [
				"syntax = \"proto3\";",
				"message Phone {",
				"  string number = 1;",
				"}"
			].join("\n");
			// Contact{name: "alice", phone: Phone{number: "5551234"}}
			const data = Buffer.from("0a05616c69636512090a0735353531323334", "hex");
			const request = {
				proto: mainProto,
				protoFiles: { "phone.proto": phoneProto },
				protoType: "Contact"
			};
			return kaitai.resolve(request).then((spec) => {
				expect(Object.keys(spec.files)).toContain("phone.ksy");
				return kaitai.parse(spec, data);
			}).then((r) => {
				expect(r.type).toBe("Contact");
				expect(r.error).toBeNull();
				expect(fieldValue(r.tree, 1)).toBe("alice");
			});
		});
	});
});
