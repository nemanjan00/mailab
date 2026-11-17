// Minimal GDB Remote Serial Protocol (RSP) client over a serial port.
// Packets: "$<payload>#<xx checksum>", "+" / "-" acks. Replies may be
// interleaved with async stop notifications ($T..) — those are acked and
// queued for the caller. Used by the Black Magic Probe driver.

const createRsp = (send, onAsync) => {
	let buf = "";
	const waiters = []; // {prefix, resolve}
	let notifications = [];

	const checksum = (payload) => {
		let sum = 0;
		for (let i = 0; i < payload.length; i++) {
			sum = (sum + payload.charCodeAt(i)) & 0xff;
		}
		return sum.toString(16).padStart(2, "0");
	};

	const onData = (data) => {
		buf += data.toString("latin1");
		let i;
		while ((i = buf.indexOf("$")) !== -1) {
			const hash = buf.indexOf("#", i + 1);
			if (hash === -1 || hash + 3 > buf.length) {
				// keep the partial packet (and any junk before it) for later
				if (i > 0) {
					buf = buf.slice(i);
				}
				break;
			}
			const payload = buf.slice(i + 1, hash);
			const given = buf.slice(hash + 1, hash + 3);
			buf = buf.slice(hash + 3);
			send(Buffer.from("+", "latin1"));
			if (given.toLowerCase() !== checksum(payload)) {
				continue; // checksum mismatch: acked "+", packet dropped
			}
			if (payload === "S" || payload === "W" || payload === "X" || payload[0] === "T"
				|| (payload[0] === "O" && payload !== "OK")) {
				// async stop / console-output record: not a command reply
				notifications.push(payload);
				if (onAsync) {
					onAsync(payload);
				}
				continue;
			}
			// a real reply belongs to the oldest pending command (RSP replies
			// don't echo the command: m -> hex data, g -> hex regs, M/P -> OK)
			const w = waiters.shift();
			if (w) {
				w.resolve(payload);
			}
		}
	};

	// command("m...") -> reply payload (without $/#). Replies are matched
	// FIFO: everything that isn't an async notification is the oldest pending
	// command's reply.
	const command = (payload, timeoutMs) => {
		const text = "$" + payload + "#" + checksum(payload);
		send(Buffer.from(text, "latin1"));
		return new Promise((resolve, reject) => {
			const w = {
				resolve: (p) => {
					clearTimeout(timer);
					resolve(p);
				}
			};
			const timer = setTimeout(() => {
				const i = waiters.indexOf(w);
				if (i !== -1) {
					waiters.splice(i, 1);
				}
				reject(new Error("timeout waiting for GDB reply to " + payload.slice(0, 24)));
			}, timeoutMs || 5000);
			waiters.push(w);
		});
	};

	const drainNotifications = () => {
		const out = notifications;
		notifications = [];
		return out;
	};

	return { onData: onData, command: command, drainNotifications: drainNotifications, checksum: checksum };
};

module.exports = { createRsp: createRsp };
