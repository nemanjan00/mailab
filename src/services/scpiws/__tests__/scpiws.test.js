// SCPI-over-WebSocket service against a fake instrument: hex text frames,
// a connect greeting (banner + *IDN? push), IEEE-block binary replies.

const WS = require("ws");
const scpiws = require("..");

describe("scpiws service", () => {
	let server = null;
	let port = null;
	let seen = null;

	const GREETING = [
		Buffer.from(" * Connected to: TCPIP::10.0.0.1::INST\n", "latin1").toString("hex"),
		Buffer.from("FAKE,DM858,1,1\n", "latin1").toString("hex")
	];

	beforeEach(() => new Promise((resolve) => {
		seen = [];
		server = new WS.Server({ port: 0 }, () => {
			port = server.address().port;
			server.on("connection", (sock) => {
				GREETING.forEach((g) => sock.send(g));
				sock.on("message", (d) => {
					const line = String(d);
					seen.push(line);
					if (line === "*IDN?") {
						// two frames, reply split across them
						sock.send(Buffer.from("FAKE,DM858,1", "latin1").toString("hex"));
						sock.send(Buffer.from(",1\n", "latin1").toString("hex"));
					} else if (line === ":CONF?") {
						sock.send(Buffer.from("VOLT 1.0\n", "latin1").toString("hex"));
					} else if (line === ":PNG?") {
						const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("fakepng")]);
						const head = Buffer.from("#8" + String(png.length).padStart(8, "0"), "latin1");
						sock.send(Buffer.concat([head, png]).toString("hex"));
					}
					// writes get no reply
				});
			});
			resolve();
		});
	}));

	afterEach(() => new Promise((resolve) => {
		server.close(resolve);
	}));

	const open = () => scpiws.create({ host: "127.0.0.1", port: port });

	test("connect consumes the greeting; queries return decoded text", () => {
		return open().then((c) => {
			return c.query("*IDN?").then((idn) => {
				expect(idn).toContain("FAKE,DM858");
				return c.query(":CONF?");
			}).then((conf) => {
				expect(conf).toBe("VOLT 1.0");
				expect(seen).toEqual(["*IDN?", ":CONF?"]);
				return c.close();
			});
		});
	});

	test("writes pass through without waiting for a reply", () => {
		return open().then((c) => {
			return c.write(":SENSe:FUNCtion \"VOLT\"").then(() => {
				return new Promise((r) => setTimeout(r, 150));
			}).then(() => {
				expect(seen).toEqual([":SENSe:FUNCtion \"VOLT\""]);
				return c.close();
			});
		});
	});

	test("queryBinary decodes the IEEE block losslessly (hex framing is binary-safe)", () => {
		return open().then((c) => {
			return c.queryBinary(":PNG?").then((png) => {
				expect(Array.from(png.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
				expect(png.length).toBe(11); // 4-byte sig + "fakepng"
				return c.close();
			});
		});
	});

	test("reconnects transparently after the socket drops (meter idle-timeout)", () => {
		let client = null;
		return open().then((c) => {
			client = c;
			return c.query(":CONF?");
		}).then((conf) => {
			expect(conf).toBe("VOLT 1.0");
			return client.close(); // simulate the meter timing the session out
		}).then(() => {
			return client.query(":CONF?"); // must heal, not error
		}).then((conf) => {
			expect(conf).toBe("VOLT 1.0");
			return client.close();
		});
	});

	test("queries are serialized: replies match their commands", () => {
		return open().then((c) => {
			return Promise.all([c.query("*IDN?"), c.query(":CONF?")]).then((r) => {
				expect(r[0]).toContain("FAKE");
				expect(r[1]).toBe("VOLT 1.0");
				return c.close();
			});
		});
	});
});
