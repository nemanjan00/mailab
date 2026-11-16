// Raw serial port as a tiny EventEmitter "socket" ({write, on("data"), close}),
// compatible with libraries written against node-serialport (kc9531b, ci-v).
//
// Plain tty I/O instead of node-serialport: with serialport 13 on Node 26
// incoming data was only delivered on the next write (see mdp-p906 host).

const fs = require("fs");
const tty = require("tty");
const EventEmitter = require("events");
const execFileSync = require("child_process").execFileSync;

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

module.exports = {
	open: open,
	collect: collect
};
