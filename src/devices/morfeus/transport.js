// Default (real-hardware) transport for the Morfeus / moRFeus.
//
// IMPORTANT / UNVERIFIED TRANSPORT: the real Othernet moRFeus is a USB *HID*
// device (Silicon Labs CP2112-class, VID 0x10C4 / PID 0xEAC9), controlled with
// 16-byte feature/interrupt reports - NOT a CDC ASCII serial port as the
// request assumed. This opens its Linux hidraw node (e.g. /dev/hidraw0) and
// exchanges fixed-length reports. It is HARDWARE-UNTESTED here (no device is
// attached); every driver test uses an injected fake transport instead.
//
// Protocol source for the report exchange (verified across two independent
// community tools):
//   - tai/morfeus (morfeus/device.py): hid, 16-byte reports, GET 0x72 / SET 0x77
//   - Psynosaur/moRFeusQt (moRFeusQt/mrf.py): same register map, host-driven sweep
// See src/devices/morfeus/index.js for the register/value layout and citations.

const fs = require("fs");

const READ_POLL_MS = 5;
const DEFAULT_READ_TIMEOUT_MS = 1000;

/**
 * Open a hidraw node as a report transport.
 * @param {string} path hidraw device node, e.g. /dev/hidraw0
 * @returns {{write: function(Buffer): void, read: function(number, number): Promise<Buffer>, close: function(): void}}
 */
const open = (path) => {
	// non-blocking so an empty read reports EAGAIN instead of stalling the loop
	const fd = fs.openSync(path, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);

	return {
		write: (buffer) => {
			fs.writeSync(fd, buffer, 0, buffer.length);
		},

		read: (length, timeoutMs) => {
			return new Promise((resolve, reject) => {
				const buffer = Buffer.alloc(length);
				const deadline = Date.now() + (timeoutMs || DEFAULT_READ_TIMEOUT_MS);
				const attempt = () => {
					let read = 0;
					try {
						read = fs.readSync(fd, buffer, 0, length, null);
					} catch (err) {
						if (err.code !== "EAGAIN") {
							reject(err);
							return;
						}
					}
					if (read > 0) {
						resolve(buffer.slice(0, read));
						return;
					}
					if (Date.now() >= deadline) {
						reject(new Error("morfeus HID read timeout on " + path));
						return;
					}
					setTimeout(attempt, READ_POLL_MS);
				};
				attempt();
			});
		},

		close: () => {
			try {
				fs.closeSync(fd);
			} catch (_err) {
				// already gone
			}
		}
	};
};

module.exports = {
	open: open
};
