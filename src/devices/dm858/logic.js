// Logic layer: operations composed from state-layer reads. monitor()
// polls readings into a channel so a strip-chart pane can watch the meter
// live; the AI asks, the logic decides when.

const createLogic = (meter) => {
	let monTimer = null;
	const monitor = (args, push) => {
		if (monTimer) {
			clearInterval(monTimer);
			monTimer = null;
		}
		if (!args || args.on === false) {
			return { monitoring: false };
		}
		const intervalMs = Math.max(100, Number(args.intervalMs) || 500);
		monTimer = setInterval(() => {
			meter.reading().then((r) => {
				push(r);
			}, () => null);
		}, intervalMs);
		return { monitoring: true, intervalMs: intervalMs };
	};
	const stop = () => {
		if (monTimer) {
			clearInterval(monTimer);
			monTimer = null;
		}
	};
	return { monitor: monitor, stop: stop };
};

module.exports = { createLogic: createLogic };
