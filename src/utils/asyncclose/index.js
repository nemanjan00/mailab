// Close an fd without ever blocking the main thread.
//
// Closing a serial tty can sleep in the kernel (tty_wait_until_sent, up to
// closing_wait ≈ 30 s) when the device is present but not draining its USB
// endpoint — a dead CDC device must not freeze the whole lab. The close
// runs on a worker thread: if it hangs, only that worker leaks.
//
// Usage: closeFd(fd).then(...) — resolve/reject is best-effort; the fd is
// owned by the worker afterwards regardless.

const { Worker, isMainThread, workerData } = require("worker_threads");

if (!isMainThread) {
	const fs = require("fs");
	try {
		fs.closeSync(workerData.fd);
	} catch (_err) {
		// already gone — fine
	}
} else {
	module.exports = (fd) => {
		return new Promise((resolve) => {
			let worker;
			try {
				worker = new Worker(__filename, { workerData: { fd: fd } });
			} catch (_err) {
				resolve();
				return;
			}
			let settled = false;
			const done = () => {
				if (!settled) {
					settled = true;
					resolve();
				}
			};
			// resolve only when the fd is REALLY closed: a hung worker keeps
			// owning the fd, and resolving early could let the fd number be
			// reused and closed by mistake
			worker.once("exit", done);
			worker.once("error", done);
		});
	};
}
