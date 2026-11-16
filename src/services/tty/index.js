// Raw serial port as a tiny EventEmitter "socket" ({write, on("data"), close}),
// compatible with libraries written against node-serialport (kc9531b, ci-v).
//
// Plain tty I/O instead of node-serialport: with serialport 13 on Node 26
// incoming data was only delivered on the next write (see mdp-p906 host).

const fs = require("fs");
const tty = require("tty");
const EventEmitter = require("events");
const execFileSync = require("child_process").execFileSync;
const serialize = require("../../utils/mutex").serialize;

const DEFAULT_BAUD = 115200;

/**
 * @param {string} path serial device, e.g. /dev/ttyACM0
 * @param {{baud: number}} [options]
 */
const open = (path, options) => {
	const opts = options || {};
	const baud = opts.baud || DEFAULT_BAUD;
	// raw mode, no echo; opening the tty raises DTR, which USB CDC devices
	// usually want before they talk
	execFileSync("stty", ["-F", path, String(baud), "raw", "-echo", "-hupcl"]);
	const flags = fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK;
	const fd = fs.openSync(path, flags);
	const input = new tty.ReadStream(fd);
	input.setRawMode(true);

	const port = new EventEmitter();
	port.path = path;
	port.isOpen = true;
	// node-serialport compatibility (ci-v waits for "open" unless this is false)
	port.opening = false;

	input.on("data", (data) => {
		port.emit("data", data);
	});
	input.on("error", (err) => {
		port.emit("error", err);
	});

	port.write = (data) => {
		if (!port.isOpen) {
			return false;
		}
		fs.writeSync(fd, data);
		return true;
	};

	port.close = () => {
		port.isOpen = false;
		input.destroy();
		port.emit("close");
		return Promise.resolve();
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
	acquire: acquire,
	release: release,
	inUse: inUse,
	collect: collect
};
