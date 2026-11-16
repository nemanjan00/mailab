const spawnSync = require("child_process").spawnSync;
const cryptojs = require("..");

const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;

describe("cryptojs AES (OpenSSL Salted__ format)", () => {
	test("round trip, random salt, base64 with the Salted__ magic", () => {
		const a = cryptojs.encrypt("pässword", "nanokvm-sipeed-2024");
		const b = cryptojs.encrypt("pässword", "nanokvm-sipeed-2024");
		expect(a).not.toBe(b);
		expect(Buffer.from(a, "base64").subarray(0, 8).toString("latin1")).toBe("Salted__");
		expect(cryptojs.decrypt(a, "nanokvm-sipeed-2024")).toBe("pässword");
		expect(() => cryptojs.decrypt(a, "wrong key")).toThrow();
	});

	test("EVP_BytesToKey(MD5) matches a fixed vector", () => {
		// openssl enc -aes-256-cbc -md md5 -S 0102030405060708 -k secret -P
		const k = cryptojs.deriveKey("secret", Buffer.from("0102030405060708", "hex"));
		expect(k.key.length).toBe(32);
		expect(k.iv.length).toBe(16);
		if (hasOpenssl) {
			const out = spawnSync("openssl", ["enc", "-aes-256-cbc", "-md", "md5", "-S", "0102030405060708", "-k", "secret", "-P"], { encoding: "utf8" }).stdout;
			expect(out).toMatch(new RegExp("key\\s*=\\s*" + k.key.toString("hex"), "i"));
			expect(out).toMatch(new RegExp("iv\\s*=\\s*" + k.iv.toString("hex"), "i"));
		}
	});

	(hasOpenssl ? test : test.skip)("openssl decrypts what we encrypt (what aes-everywhere on the KVM does)", () => {
		const ct = cryptojs.encrypt("admin", "nanokvm-sipeed-2024");
		const r = spawnSync("openssl", ["enc", "-d", "-aes-256-cbc", "-md", "md5", "-a", "-A", "-k", "nanokvm-sipeed-2024"], { input: ct, encoding: "utf8" });
		expect(r.stdout).toBe("admin");
	});
});
