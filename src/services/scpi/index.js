// SCPI client over raw TCP (port 5555 on Rigol & most LXI gear) or the Linux
// usbtmc driver (/dev/usbtmcN). Queries are serialized; replies are either a
// newline-terminated string or an IEEE 488.2 definite-length block (#NLLLL...).

const net = require("net");
const fs = require("fs");
const wrapper = require("queue-promised").wrapper;

const DEFAULT_TCP_PORT = 5555;
const DEFAULT_TIMEOUT_MS = 5000;
const USBTMC_READ_SIZE = 1024 * 1024;

// length of a complete IEEE block in `buf`, or -1 if more data is needed
const blockLength = (buf) => {
	if (buf.length < 2) {
		return -1;
	}
	const digits = Number(String.fromCharCode(buf[1]));
	if (buf.length < 2 + digits) {
		return -1;
	}
	const size = Number(buf.slice(2, 2 + digits).toString("ascii"));
	if (buf.length < 2 + digits + size) {
		return -1;
	}
	return 2 + digits + size;
};

const isComplete = (buf) => {
	if (buf.length === 0) {
		return false;
	}
	if (buf[0] === 0x23) {
		return blockLength(buf) !== -1;
	}
	return buf[buf.length - 1] === 0x0a;
};

/**
 * Strip block header / trailing newline.
 * @returns {Buffer}
 */
const unwrap = (buf) => {
	if (buf[0] === 0x23) {
		const digits = Number(String.fromCharCode(buf[1]));
		const size = Number(buf.slice(2, 2 + digits).toString("ascii"));
		return buf.slice(2 + digits, 2 + digits + size);
	}
	return buf;
};

const openTcp = (options) => {
	return new Promise((resolve, reject) => {
		const socket = net.connect(options.port || DEFAULT_TCP_PORT, options.host);
		let acc = Buffer.alloc(0);
		let waiter = null;

		socket.setNoDelay(true);
		socket.on("data", (data) => {
			acc = Buffer.concat([acc, data]);
			if (waiter && isComplete(acc)) {
				const done = waiter;
				waiter = null;
				const reply = acc;
				acc = Buffer.alloc(0);
				done.resolve(reply);
			}
		});
		socket.once("error", reject);
		socket.once("connect", () => {
			socket.off("error", reject);
			socket.on("error", (err) => {
				if (waiter) {
					waiter.reject(err);
					waiter = null;
				}
			});
			resolve({
				write: (text) => {
					socket.write(text + "\n");
					return Promise.resolve();
				},
				read: (timeoutMs) => {
					return new Promise((res, rej) => {
						const timer = setTimeout(() => {
							waiter = null;
							acc = Buffer.alloc(0);
							rej(new Error("SCPI timeout (" + options.host + ")"));
						}, timeoutMs);
						waiter = {
							resolve: (reply) => {
								clearTimeout(timer);
								res(reply);
							},
							reject: (err) => {
								clearTimeout(timer);
								rej(err);
							}
						};
						if (isComplete(acc)) {
							const reply = acc;
							acc = Buffer.alloc(0);
							waiter.resolve(reply);
							waiter = null;
						}
					});
				},
				close: () => {
					socket.destroy();
					return Promise.resolve();
				}
			});
		});
	});
};

const openUsbtmc = (options) => {
	return fs.promises.open(options.path, "r+").then((handle) => {
		const readUntilComplete = (acc) => {
			const chunk = Buffer.alloc(USBTMC_READ_SIZE);
			// the kernel driver applies its own timeout to each read
			return handle.read(chunk, 0, chunk.length, null).then((result) => {
				const next = Buffer.concat([acc, chunk.slice(0, result.bytesRead)]);
				if (result.bytesRead === 0 || isComplete(next)) {
					return next;
				}
				return readUntilComplete(next);
			});
		};
		return {
			write: (text) => {
				return handle.write(text + "\n").then(() => {
					return undefined;
				});
			},
			read: () => {
				return readUntilComplete(Buffer.alloc(0));
			},
			close: () => {
				return handle.close();
			}
		};
	});
};

/**
 * @param {{transport: string, host: string, port: number, path: string, timeoutMs: number}} options
 *   transport "tcp" (host, port) or "usbtmc" (path)
 */
const open = (options) => {
	const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
	let opening;
	if (options.transport === "usbtmc") {
		opening = openUsbtmc(options);
	} else {
		opening = openTcp(options);
	}
	return opening.then((link) => {
		const exchange = (command, expectReply) => {
			return link.write(command).then(() => {
				if (!expectReply) {
					return null;
				}
				return link.read(timeoutMs);
			});
		};
		const serialized = wrapper(exchange, 1);

		return {
			write: (command) => {
				return serialized(command, false);
			},

			query: (command) => {
				return serialized(command, true).then((reply) => {
					return unwrap(reply).toString("utf8").trim();
				});
			},

			queryNumber: (command) => {
				return serialized(command, true).then((reply) => {
					return Number(unwrap(reply).toString("utf8").trim());
				});
			},

			queryBinary: (command) => {
				return serialized(command, true).then(unwrap);
			},

			close: () => {
				return link.close();
			}
		};
	});
};

module.exports = {
	open: open,
	unwrap: unwrap,
	isComplete: isComplete
};
