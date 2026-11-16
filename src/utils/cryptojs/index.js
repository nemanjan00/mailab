// CryptoJS.AES.encrypt(text, passphrase) compatible encryption: the OpenSSL
// "Salted__" format (EVP_BytesToKey with MD5, one iteration -> AES-256-CBC
// key + IV, PKCS#7 padding), base64. NanoKVM's web UI encrypts the login
// password this way with a fixed public key (sipeed/NanoKVM web/src/lib/encrypt.ts;
// the server decrypts with github.com/mervick/aes-everywhere aes256.Decrypt in
// server/utils/encrypt.go). It is obfuscation, not security.

const createHash = require("crypto").createHash;
const createCipheriv = require("crypto").createCipheriv;
const createDecipheriv = require("crypto").createDecipheriv;
const randomBytes = require("crypto").randomBytes;

const MAGIC = Buffer.from("Salted__", "latin1");
const SALT_BYTES = 8;
const KEY_BYTES = 32;
const IV_BYTES = 16;
const MD5_BYTES = 16;
const CIPHER = "aes-256-cbc";

/**
 * OpenSSL EVP_BytesToKey (MD5, 1 iteration): D_i = MD5(D_{i-1} || pass || salt).
 */
const deriveKey = (passphrase, salt) => {
	const pass = Buffer.from(String(passphrase), "utf8");
	const rounds = Math.ceil((KEY_BYTES + IV_BYTES) / MD5_BYTES);
	const blocks = Array.from({ length: rounds }).reduce((acc) => {
		const prev = acc.length ? acc[acc.length - 1] : Buffer.alloc(0);
		return acc.concat([createHash("md5").update(Buffer.concat([prev, pass, salt])).digest()]);
	}, []);
	const material = Buffer.concat(blocks);
	return { key: material.subarray(0, KEY_BYTES), iv: material.subarray(KEY_BYTES, KEY_BYTES + IV_BYTES) };
};

/**
 * @param {string} text
 * @param {string} passphrase
 * @param {Buffer} [salt] 8 bytes (random by default; fixed only for tests)
 * @returns {string} base64 of "Salted__" + salt + ciphertext
 */
const encrypt = (text, passphrase, salt) => {
	const s = salt || randomBytes(SALT_BYTES);
	if (s.length !== SALT_BYTES) {
		throw new Error("salt must be " + SALT_BYTES + " bytes");
	}
	const k = deriveKey(passphrase, s);
	const cipher = createCipheriv(CIPHER, k.key, k.iv);
	const body = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
	return Buffer.concat([MAGIC, s, body]).toString("base64");
};

/**
 * Inverse of encrypt (used by the tests' fake NanoKVM).
 */
const decrypt = (b64, passphrase) => {
	const raw = Buffer.from(String(b64), "base64");
	if (raw.length < MAGIC.length + SALT_BYTES || !raw.subarray(0, MAGIC.length).equals(MAGIC)) {
		throw new Error("not an OpenSSL salted ciphertext");
	}
	const salt = raw.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
	const k = deriveKey(passphrase, salt);
	const decipher = createDecipheriv(CIPHER, k.key, k.iv);
	return Buffer.concat([decipher.update(raw.subarray(MAGIC.length + SALT_BYTES)), decipher.final()]).toString("utf8");
};

module.exports = {
	encrypt: encrypt,
	decrypt: decrypt,
	deriveKey: deriveKey
};
