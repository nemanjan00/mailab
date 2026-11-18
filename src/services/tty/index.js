// Raw serial port as a tiny EventEmitter "socket" ({write, on("data"), close}),
// compatible with libraries written against node-serialport (kc9531b, ci-v).
//
// Plain tty I/O instead of node-serialport: with serialport 13 on Node 26
// incoming data was only delivered on the next write (see mdp-p906 host).

const fs = require("fs");
const EventEmitter = require("events");
const execFileSync = require("child_process").execFileSync;
const serialize = require("../../utils/mutex").serialize;
const closeFd = require("../../utils/asyncclose");

const DEFAULT_BAUD = 115200;
const FLOW = { none: ["-crtscts", "-ixon", "-ixoff"], rtscts: ["crtscts", "-ixon", "-ixoff"], xonxoff: ["-crtscts", "ixon", "ixoff"] };

/**
 * stty arguments for a line format.
 * @param {{baud: number, format: string, flow: string}} options format like "8N1", "7E1", "8O2"
 * @returns {string[]}
 */
const sttyArgs = (options) => {
	const opts = options || {};
	const baud = Number(opts.baud || DEFAULT_BAUD);
	if (!Number.isInteger(baud) || baud < 50 || baud > 20000000) {
		throw new Error("bad baud rate: " + opts.baud);
	}
	const m = /^([5-8])([NEO])([12])$/i.exec(opts.format || "8N1");
	if (!m) {
		throw new Error("bad format (expected e.g. 8N1, 7E1): " + opts.format);
	}
	const flow = FLOW[opts.flow || "none"];
	if (!flow) {
		throw new Error("flow must be none, rtscts or xonxoff");
	}
	const parity = m[2].toUpperCase();
	return [String(baud), "cs" + m[1], parity === "N" ? "-parenb" : "parenb", parity === "O" ? "parodd" : "-parodd", m[3] === "2" ? "cstopb" : "-cstopb"].concat(flow);
};

/**
 * Change baud / format / flow control of a (possibly open) port.
 */
const configure = (path, options) => {
	execFileSync("stty", ["-F", path].concat(sttyArgs(options)));
};

/**
 * @param {string} path serial device, e.g. /dev/ttyACM0
 * @param {{baud: number}} [options]
 */
const open = (path, options) => {
	const opts = options || {};
	const baud = opts.baud || DEFAULT_BAUD;
	// raw mode, no echo; opening the tty raises DTR, which USB CDC devices
	// usually want before they talk
	execFileSync("stty", ["-F", path, "raw", "-echo", "-hupcl"].concat(opts.format || opts.flow ? sttyArgs(opts) : [String(baud)]));
	const flags = fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK;
	const fd = fs.openSync(path, flags);
	// poll-read instead of tty.ReadStream: same prompt delivery, and closing
	// never runs on the main thread (a dead device can sleep in the kernel
	// for tens of seconds in tty_wait_until_sent — see utils/asyncclose)
	const chunk = Buffer.alloc(4096);
	const POLL_MS = 10;

	const port = new EventEmitter();
	port.path = path;
	port.isOpen = true;
	// node-serialport compatibility (ci-v waits for "open" unless this is false)
	port.opening = false;

	port.poll = setInterval(() => {
		if (!port.isOpen) {
			return;
		}
		let n;
		try {
			n = fs.readSync(fd, chunk, 0, chunk.length, null);
		} catch (err) {
			if (err.code === "EAGAIN") {
				return;
			}
			port.isOpen = false;
			port.emit("error", err);
			return;
		}
		if (n > 0) {
			// copy: Buffer.slice is a VIEW into the reusable chunk buffer —
			// emitting it would let the next poll tick corrupt data consumers
			// are still holding (capture blobs, terminals)
			port.emit("data", Buffer.from(chunk.subarray(0, n))); /* subarray=view, Buffer.from(typedArray)=COPY */
		}
	}, POLL_MS);

	port.write = (data) => {
		if (!port.isOpen) {
			return false;
		}
		try {
			fs.writeSync(fd, data);
			return true;
		} catch (err) {
			port.emit("error", err);
			return false;
		}
	};

	port.close = () => {
		port.isOpen = false;
		clearInterval(port.poll);
		port.emit("close");
		return closeFd(fd).catch(() => {});
	};

	return port;
};

/**
 * Collect incoming data until `done(buffer)` is true or the timeout hits.
 * @param {EventEmitter} port from open()
 * @param {function(Buffer): boolean} done
 * @param {number} timeoutMs
 * @returns {Promise<Buffer>}
 */
const collect = (port, done, timeoutMs) => {
	return new Promise((resolve, reject) => {
		let acc = Buffer.alloc(0);
		const finish = (err) => {
			clearTimeout(timer);
			port.off("data", onData);
			if (err) {
				err.partial = acc;
				reject(err);
			} else {
				resolve(acc);
			}
		};
		const onData = (data) => {
			acc = Buffer.concat([acc, data]);
			if (done(acc)) {
				finish();
			}
		};
		const timer = setTimeout(() => {
			finish(new Error("serial timeout on " + port.path));
		}, timeoutMs);
		port.on("data", onData);
	});
};

// path -> {port, owners: [ids], shared, lock}
const registry = {};

/**
 * Open a port through the registry so several devices can use one bus
 * (CI-V radios) and two devices can't fight over a port by accident.
 * @param {string} path
 * @param {{baud: number, shared: boolean, owner: string}} options
 *   shared: allow other shared users of the same path (they must agree)
 * @returns {EventEmitter} port, plus port.exclusive(fn) that serializes fn() across all users
 */
const acquire = (path, options) => {
	const opts = options || {};
	const entry = registry[path];
	if (entry) {
		if (!entry.shared || !opts.shared) {
			throw new Error("port " + path + " is in use by " + entry.owners.join(", "));
		}
		entry.owners.push(opts.owner || "?");
		return entry.port;
	}
	const port = open(path, opts);
	const lock = serialize();
	port.exclusive = (fn) => {
		return lock(fn);
	};
	registry[path] = { port: port, owners: [opts.owner || "?"], shared: Boolean(opts.shared) };
	return port;
};

/**
 * Release a port taken with acquire(); closes it when the last user leaves.
 */
const release = (path, owner) => {
	const entry = registry[path];
	if (!entry) {
		return Promise.resolve();
	}
	const index = entry.owners.indexOf(owner || "?");
	if (index !== -1) {
		entry.owners.splice(index, 1);
	}
	if (entry.owners.length) {
		return Promise.resolve();
	}
	delete registry[path];
	return entry.port.close();
};

const inUse = () => {
	const out = {};
	Object.keys(registry).forEach((path) => {
		out[path] = registry[path].owners.slice();
	});
	return out;
};

module.exports = {
	open: open,
	configure: configure,
	sttyArgs: sttyArgs,
	acquire: acquire,
	release: release,
	inUse: inUse,
	collect: collect
};
