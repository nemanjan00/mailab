const des = require("..");

describe("des", () => {
	test("FIPS 46 worked example", () => {
		const out = des.encryptBlock(Buffer.from("133457799bbcdff1", "hex"), Buffer.from("0123456789abcdef", "hex"));
		expect(out.toString("hex")).toBe("85e813540f0ab405");
	});

	test("VNC auth response (checked against openssl des-ecb with the bit-reversed key)", () => {
		const challenge = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
		expect(des.vncResponse("secret", challenge).toString("hex")).toBe("ee22539f33a5983ec12f9c2edbc995dd");
	});

	test("only the first 8 password characters count", () => {
		const challenge = Buffer.alloc(16, 7);
		expect(des.vncResponse("password123", challenge)).toEqual(des.vncResponse("password", challenge));
	});

	test("rejects bad sizes", () => {
		expect(() => des.vncResponse("x", Buffer.alloc(8))).toThrow("16 bytes");
		expect(() => des.encryptBlock(Buffer.alloc(7), Buffer.alloc(8))).toThrow();
	});
});
