// The OpenCV vision service: one long-running python/vision_bridge.py speaking
// the JSON-lines helper protocol (src/devices/process). Started on first use
// (the managed venv installs the pinned opencv first), restarted on the next
// request after a crash; a failed start backs off so frames don't re-run pip.

const path = require("path");
const pyenv = require("../pyenv");
const processDriver = require("../../devices/process");

const REQUIRES = ["opencv-python-headless==4.14.0.94", "numpy==2.5.3"];
const SCRIPT = path.join(__dirname, "..", "..", "..", "python", "vision_bridge.py");
const START_BACKOFF_MS = 30000;
const REQUEST_TIMEOUT_MS = 30000;

/**
 * @param {{log: function(string, string)}} [options] log(text, level) for bridge output
 */
const create = (options) => {
	const opts = options || {};
	const log = opts.log || (() => null);

	const service = {
		_helper: null,
		_starting: null,
		_failedAt: 0,
		_failure: null,
		_inflight: 0,

		/**
		 * Requests sent and not answered yet (frames are dropped above a limit).
		 */
		inflight: () => service._inflight,

		running: () => Boolean(service._helper),

		_start: () => {
			if (service._helper) {
				return Promise.resolve(service._helper);
			}
			if (service._starting) {
				return service._starting;
			}
			if (service._failure && Date.now() - service._failedAt < START_BACKOFF_MS) {
				return Promise.reject(service._failure);
			}
			service._starting = pyenv.ensure(REQUIRES, (line) => log(line, "setup")).then((python) => {
				const helper = processDriver.create({ command: python, args: [SCRIPT] }, {
					log: (text, level) => log(text, level),
					status: (state, detail) => {
						// the helper exited: the next request starts a new one
						if (state === "error" || state === "stopped") {
							if (service._helper === helper) {
								service._helper = null;
							}
							if (state === "error") {
								log("vision bridge: " + detail, "error");
							}
						}
					}
				});
				return helper.start().then(() => {
					service._helper = helper;
					service._failure = null;
					return helper;
				});
			}).then((helper) => {
				service._starting = null;
				return helper;
			}, (err) => {
				service._starting = null;
				service._failure = new Error("vision bridge unavailable: " + err.message);
				service._failedAt = Date.now();
				throw service._failure;
			});
			return service._starting;
		},

		/**
		 * @param {string} command ops | run | watch | forget | versions
		 * @param {Object} [args]
		 */
		request: (command, args) => {
			service._inflight++;
			return service._start()
				.then((helper) => helper.command(command, Object.assign({ timeoutMs: REQUEST_TIMEOUT_MS }, args || {})))
				.then((result) => {
					service._inflight--;
					return result;
				}, (err) => {
					service._inflight--;
					throw err;
				});
		},

		stop: () => {
			const helper = service._helper;
			service._helper = null;
			return helper ? helper.stop() : Promise.resolve();
		}
	};

	return service;
};

module.exports = {
	create: create,
	REQUIRES: REQUIRES
};
