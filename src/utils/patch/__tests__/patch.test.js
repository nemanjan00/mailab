const nodeCrypto = require("crypto");
const patch = require("..");

const hex = (buf) => buf.toString("hex");

// apply, then apply the undo: must restore the original
const roundTrip = (orig, ops) => {
	const r = patch.apply(orig, ops);
	const back = patch.apply(r.data, r.undo);
	expect(hex(back.data)).toBe(hex(orig));
	return r;
};

describe("patch", () => {
	const orig = Buffer.from("00112233445566778899", "hex");

	test("poke overwrites and never touches the input", () => {
		const r = roundTrip(orig, [{ op: "poke", offset: 2, hex: "aa bb" }]);
		expect(hex(r.data)).toBe("0011aabb445566778899");
		expect(hex(orig)).toBe("00112233445566778899");
	});

	test("poke past the end extends; at the end appends", () => {
		expect(hex(roundTrip(orig, [{ op: "poke", offset: 9, hex: "aabbcc" }]).data)).toBe("001122334455667788aabbcc");
		expect(hex(roundTrip(orig, [{ op: "poke", offset: 10, base64: Buffer.from([1]).toString("base64") }]).data)).toBe("0011223344556677889901");
		expect(() => patch.apply(orig, [{ op: "poke", offset: 11, hex: "00" }])).toThrow(/op 0: poke: offset/);
	});

	test("insert, delete, fill", () => {
		expect(hex(roundTrip(orig, [{ op: "insert", offset: 0, hex: "ff" }]).data)).toBe("ff00112233445566778899");
		expect(hex(roundTrip(orig, [{ op: "insert", offset: 10, bytes: [1, 2] }]).data)).toBe("001122334455667788990102");
		expect(hex(roundTrip(orig, [{ op: "delete", offset: 1, length: 3 }]).data)).toBe("00445566778899");
		expect(hex(roundTrip(orig, [{ op: "delete", offset: 0, length: 10 }]).data)).toBe("");
		expect(hex(roundTrip(orig, [{ op: "fill", offset: 2, length: 5, hex: "abcd" }]).data)).toBe("0011abcdabcdab778899");
		expect(hex(roundTrip(orig, [{ op: "fill", offset: 8, length: 2 }]).data)).toBe("00112233445566770000");
	});

	test("zero-length delete / fill are no-ops with empty inverses", () => {
		const r = patch.apply(orig, [{ op: "delete", offset: 3, length: 0 }, { op: "fill", offset: 0, length: 0 }]);
		expect(hex(r.data)).toBe(hex(orig));
		expect(r.undo).toEqual([]);
	});

	test("ops see the previous op's result; per-op inverses undo in reverse", () => {
		const ops = [
			{ op: "insert", offset: 0, hex: "aaaa" },
			{ op: "poke", offset: 1, hex: "bb" },
			{ op: "delete", offset: 5, length: 2 }
		];
		const r = roundTrip(orig, ops);
		expect(hex(r.data)).toBe("aabb00112255667788" + "99");
		expect(r.inverses.length).toBe(3);
		// undo only the last op
		const partial = patch.apply(r.data, r.inverses[2]);
		expect(hex(partial.data)).toBe("aabb00112233445566778899");
	});

	test("random patches always round-trip", () => {
		const base = nodeCrypto.randomBytes(200);
		for (let n = 0; n < 50; n++) {
			let size = base.length;
			const ops = Array.from({ length: 5 }, () => {
				const kind = patch.OPS[nodeCrypto.randomInt(4)];
				const offset = nodeCrypto.randomInt(size + 1);
				if (kind === "insert") {
					size += 3;
					return { op: kind, offset: offset, hex: "010203" };
				}
				if (kind === "poke") {
					size = Math.max(size, offset + 2);
					return { op: kind, offset: offset, hex: "ffee" };
				}
				const length = nodeCrypto.randomInt(size - offset + 1);
				if (kind === "delete") {
					size -= length;
				}
				return { op: kind, offset: offset, length: length, hex: "55" };
			});
			roundTrip(base, ops);
		}
	});

	test("validation", () => {
		expect(() => patch.apply(orig, [])).toThrow(/non-empty/);
		expect(() => patch.apply(orig, [{ op: "xor", offset: 0 }])).toThrow(/unknown op/);
		expect(() => patch.apply(orig, [{ op: "poke", offset: 0 }])).toThrow(/no data/);
		expect(() => patch.apply(orig, [{ op: "poke", offset: 0, hex: "abc" }])).toThrow(/bad hex/);
		expect(() => patch.apply(orig, [{ op: "poke", offset: -1, hex: "00" }])).toThrow(/offset/);
		expect(() => patch.apply(orig, [{ op: "poke", offset: 1.5, hex: "00" }])).toThrow(/offset/);
		expect(() => patch.apply(orig, [{ op: "delete", offset: 5, length: 6 }])).toThrow(/length/);
		expect(() => patch.apply(orig, [{ op: "fill", offset: 5 }])).toThrow(/length/);
		expect(() => patch.apply(orig, [{ op: "insert", offset: 0, bytes: [256] }])).toThrow(/byte/);
		expect(() => patch.apply(orig, new Array(patch.MAX_OPS + 1).fill({ op: "fill", offset: 0, length: 0 }))).toThrow(/more than/);
	});
});
