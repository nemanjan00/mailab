// SCPI over the instrument's WebSocket command channel (RIGOL Web
// Control, port 9004 by default): a text-mode SCPI session framed as
// hex-encoded replies over WebSocket.
//
// Wire format (verified live on a DM858 and the MHO98's Web Control):
//   - on connect the server pushes a greeting (banner + *IDN? reply) as
//     hex text frames, one frame per line
//   - each command (one SCPI line per text frame) gets exactly one reply
//     frame, hex-encoded; query replies include their trailing \n as 0a
//   - hex framing is binary-safe: IEEE-block replies (screenshots,
//     waveforms) decode losslessly, unlike the UTF-8 text path
//
// The client mirrors src/services/scpi's shape (write/query/queryBinary
// serialized through one chain) so device drivers can treat both
// transports identically.

const WS = require("ws");

const DEFAULT_PORT = 9004;
const CONNECT_TIMEOUT_MS = 5000;
const QUERY_TIMEOUT_MS = 10000;

const create = (options) => {
	const host = options.host;
	const port = Number(options.port) || DEFAULT_PORT;
	const url = options.url || ("ws://" + host + ":" + port);
	let ws = null;
	let greeting = null; // non-null while a connect greeting is being consumed
	let chain = Promise.resolve();

	const connect = () => {
		return new Promise((resolve, reject) => {
			greeting = true;
			const timer = setTimeout(() => {
				reject(new Error("scpiws connect timeout: " + url));
			}, CONNECT_TIMEOUT_MS);
			const sock = new WS(url, { perMessageDeflate: false });
			let hello = [];
			let waiters = [];

			sock.on("open", () => {
				ws = { sock: sock, waiters: waiters };
			});
			sock.on("message", (data) => {
				// replies are hex text; one frame per reply
				const frame = Buffer.from(String(data), "hex");
				if (greeting !== null) {
					hello.push(frame);
					// greeting = banner line + the unsolicited *IDN? reply
					if (hello.length >= 2 || hello.some((h) => h.toString("latin1").indexOf("Rigol") !== -1)) {
						clearTimeout(timer);
						greeting = null;
						hello = [];
						resolve(api);
					}
					return;
				}
				if (!waiters.length) {
					return; // unsolicited traffic: ignore
				}
				const w = waiters.shift();
				clearTimeout(w.timer);
				w.resolve(frame);
			});
			sock.on("error", (err) => {
				if (greeting !== null) {
					clearTimeout(timer);
					reject(err);
					return;
				}
				waiters.slice().forEach((w) => {
					clearTimeout(w.timer);
					w.reject(err);
				});
				waiters.length = 0;
			});
			sock.on("close", () => {
				if (greeting !== null) {
					clearTimeout(timer);
					reject(new Error("scpiws closed during connect"));
					return;
				}
				waiters.slice().forEach((w) => {
					clearTimeout(w.timer);
					w.reject(new Error("scpiws connection closed"));
				});
				waiters.length = 0;
			});
		});
	};

	// run fn after everything queued so far; failures don't break the chain
	const exclusive = (fn) => {
		const job = chain.then(fn);
		chain = job.catch(() => null);
		return job;
	};

	// the meter idle-times-out WS sessions: reconnect transparently before
	// the next exchange instead of erroring forever
	const ensureOpen = () => {
		if (ws && ws.sock.readyState === 1) {
			return Promise.resolve();
		}
		return connect();
	};

	const exchange = (line, wantReply, timeoutMs) => {
		return exclusive(() => {
			return ensureOpen().then(() => new Promise((resolve, reject) => {
				if (!ws) {
					reject(new Error("scpiws not connected"));
					return;
				}
				const waiter = {
					resolve: resolve,
					reject: reject,
					timer: setTimeout(() => {
						ws.waiters = ws.waiters.filter((w) => w !== waiter);
						reject(new Error("scpiws timeout (" + (timeoutMs || QUERY_TIMEOUT_MS) + " ms) after: " + line));
					}, timeoutMs || QUERY_TIMEOUT_MS)
				};
				if (wantReply) {
					ws.waiters.push(waiter);
				}
				ws.sock.send(line);
				if (!wantReply) {
					// writes still pass through the chain; resolve once sent
					clearTimeout(waiter.timer);
					waiter.resolve(Buffer.alloc(0));
				}
			}));
		});
	};

	const decodeText = (buf) => buf.toString("latin1").replace(/\r?\n$/, "");

	const api = {
		write: (command) => {
			return exchange(String(command), false).then(() => undefined);
		},
		query: (command, timeoutMs) => {
			return exchange(String(command), true, timeoutMs).then(decodeText);
		},
		queryNumber: (command, timeoutMs) => {
			return api.query(command, timeoutMs).then(Number);
		},
		queryBinary: (command, timeoutMs) => {
			return exchange(String(command), true, timeoutMs).then((buf) => {
				// strip the IEEE block header if present
				if (buf[0] === 0x23) {
					const digits = buf[1] - 0x30;
					const len = parseInt(buf.slice(2, 2 + digits).toString("latin1"), 10);
					return buf.slice(2 + digits, 2 + digits + len);
				}
				return buf;
			});
		},
		close: () => {
			return exclusive(() => {
				if (ws) {
					try {
						ws.sock.close();
					} catch (_err) {
						// already closed
					}
					ws = null;
				}
				return undefined;
			});
		}
	};

	greeting = true;
	return connect();
};

module.exports = { create: create, DEFAULT_PORT: DEFAULT_PORT };
