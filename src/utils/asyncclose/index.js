// Close an fd without blocking the event loop.
//
// Closing a serial tty can sleep in the kernel for tens of seconds
// (tty_wait_until_sent, up to closing_wait ≈ 30 s) when the device is
// present but not draining its USB endpoint. libuv runs fs.close on its
// threadpool, so the sleep ties up one pool worker at worst — never the
// main loop, never timers or sockets.
//
// Do NOT close fds from worker_threads for this: fds are process-global and
// the worker's bookkeeping corrupts the parent's fd table (observed on the
// lab host as "File descriptor N closed but not opened in unmanaged mode"
// followed by a uv__io_poll assertion crash and a wedged HTTP listener).

const fs = require("fs");

module.exports = (fd) => {
	return new Promise((resolve) => {
		fs.close(fd, () => {
			resolve();
		});
	});
};
