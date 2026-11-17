// DeepAce device framing (KC9531B power meter, KC901K/KC908V analyzers share
// the vendor protocol family): outgoing requests and incoming replies are
// length-prefixed frames with a 16-bit running-sum checksum.
//
//   outgoing: 0xFE 0x01 <code> <len_lo> <len_hi> <payload...> <cc_lo> <cc_hi>
//   incoming: 0xFF 0x01 <code> <status> <len_lo> <len_hi> <body...> <cc_lo> <cc_hi>
//
// cc is the low 16 bits of the byte sum over everything before it
// (incoming includes the 0xFF). status 1 = ok, 0 = device-side error.
// Reference: the kc9531b npm package (vendor-protocol derivation, USB
// sniffing). Wire format not yet verified against a KC901K on the bench [HW].

const OUT_MAGIC = 0xfe;
const IN_MAGIC = 0xff;
const VERSION = 0x01;

const checksum = (bytes) => {
	let sum = 0;
	Array.from(bytes).forEach((b) => {
		sum = (sum + b) & 0xffff;
	});
	return sum;
};

// code: transaction id (0..255), echoed by the reply
const buildFrame = (code, payload) => {
	const data = Buffer.from(payload || []);
	if (data.length > 0xffff) {
		throw new Error("payload too large: " + data.length);
	}
	const head = Buffer.from([OUT_MAGIC, VERSION, code & 0xff, data.length & 0xff, (data.length >> 8) & 0xff]);
	const cc = checksum(Buffer.concat([head, data]));
	return Buffer.concat([head, data, Buffer.from([cc & 0xff, (cc >> 8) & 0xff])]);
};

// Streaming parser: feed arbitrary chunks, get complete verified frames.
// Resynchronizes on a bad magic/version/checksum by scanning for the next
// 0xFF, like the vendor lib does.
const createParser = (onFrame, onError) => {
	let buf = Buffer.alloc(0);

	const fail = (reason, skip) => {
		if (onError) {
			onError(reason);
		}
		buf = buf.slice(skip);
		resync();
	};

	const resync = () => {
		let i = buf.indexOf(IN_MAGIC);
		while (i !== -1) {
			if (buf.length < 2 || buf[1] === VERSION) {
				break;
			}
			i = buf.indexOf(IN_MAGIC, i + 1);
		}
		if (i > 0) {
			buf = buf.slice(i);
		}
	};

	return {
		push: (chunk) => {
			buf = Buffer.concat([buf, chunk]);
			for (;;) {
				if (!buf.length || buf[0] !== IN_MAGIC) {
					resync();
					if (!buf.length || buf[0] !== IN_MAGIC) {
						buf = Buffer.alloc(0);
						return;
					}
				}
				if (buf.length >= 2 && buf[1] !== VERSION) {
					fail("bad version", 1);
					continue;
				}
				if (buf.length < 6) {
					return;
				}
				const size = buf.readUInt16LE(4);
				const total = 6 + size + 2;
				if (buf.length < total) {
					return;
				}
				const cc = buf.readUInt16LE(6 + size);
				if (checksum(buf.slice(0, 6 + size)) !== cc) {
					fail("bad checksum", 1);
					continue;
				}
				onFrame({
					code: buf[2],
					ok: buf[3] === 1,
					body: buf.slice(6, 6 + size)
				});
				buf = buf.slice(total);
			}
		}
	};
};

// incoming reply builder (0xFF header + status byte; checksum includes the
// 0xFF, unlike outgoing) — used by fakes/tests and any future mock
const buildReply = (code, status, body) => {
	const data = Buffer.from(body || []);
	const head = Buffer.from([IN_MAGIC, VERSION, code & 0xff, status & 0xff, data.length & 0xff, (data.length >> 8) & 0xff]);
	const cc = checksum(Buffer.concat([head, data]));
	return Buffer.concat([head, data, Buffer.from([cc & 0xff, (cc >> 8) & 0xff])]);
};

module.exports = { buildFrame: buildFrame, buildReply: buildReply, createParser: createParser, checksum: checksum, OUT_MAGIC: OUT_MAGIC, IN_MAGIC: IN_MAGIC };
