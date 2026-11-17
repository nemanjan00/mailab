// Logic layer: operations composed from state-layer reads/writes.
// capture() pulls waveforms; watch() polls the trigger status and calls the
// push() callback (supplied by the UI layer) whenever the unit has a fresh
// acquisition — so the web UI updates when the scope triggers, without
// anyone asking. The logic layer decides WHEN; the UI layer decides HOW
// results are shown.

const createLogic = (scope) => {
	let watchTimer = null;
	let lastStatus = null;
	let lastPush = 0;
	let opts = { screen: true };

	const enabledSources = () => {
		const model = scope.get();
		const enabled = [1, 2, 3, 4].filter((n) => {
			return model.ch[String(n)] && model.ch[String(n)].on;
		});
		return (enabled.length ? enabled : [1]).map((n) => "CHAN" + n);
	};

	const capture = (sources) => {
		const srcs = sources && sources.length ? sources : enabledSources();
		return srcs.reduce((chain, source) => {
			return chain.then((acc) => {
				return scope.waveform(source).then((wave) => {
					return acc.concat([wave]);
				});
			});
		}, Promise.resolve([]));
	};

	// one acquisition -> one push() call (trace + optionally screen)
	const tick = (push) => {
		return scope.trigStatus().then((status) => {
			const done = status === "TD" || status === "STOP";
			const fresh = lastStatus !== status || Date.now() - lastPush > 2500;
			lastStatus = status;
			if (done && fresh) {
				lastPush = Date.now();
				return push().catch((err) => ({ watchError: err.message }));
			}
			return null;
		}, (err) => {
			return { watchError: err.message };
		});
	};

	const watch = (args, push) => {
		if (watchTimer) {
			clearInterval(watchTimer);
			watchTimer = null;
		}
		if (!args || args.on === false) {
			return { watching: false };
		}
		const intervalMs = Math.max(200, Number(args.intervalMs) || 1000);
		opts = { screen: args.screen !== false };
		watchTimer = setInterval(() => {
			tick(() => {
				return capture().then((waves) => {
					return push(waves, opts);
				});
			});
		}, intervalMs);
		return { watching: true, intervalMs: intervalMs, screen: opts.screen };
	};

	const watching = () => Boolean(watchTimer);

	// slow cache refresh: re-read the model from the unit every intervalMs so
	// front-panel changes show up in the UI without anyone asking
	let syncTimer = null;
	const autoSync = (intervalMs) => {
		if (syncTimer) {
			clearInterval(syncTimer);
			syncTimer = null;
		}
		if (!intervalMs) {
			return { autoSync: false };
		}
		syncTimer = setInterval(() => {
			scope.sync().catch(() => null);
		}, Math.max(5000, intervalMs));
		return { autoSync: true, intervalMs: Math.max(5000, intervalMs) };
	};

	const stop = () => {
		if (watchTimer) {
			clearInterval(watchTimer);
			watchTimer = null;
		}
		if (syncTimer) {
			clearInterval(syncTimer);
			syncTimer = null;
		}
	};

	return { capture: capture, watch: watch, watching: watching, autoSync: autoSync, stop: stop, enabledSources: enabledSources };
};

module.exports = { createLogic: createLogic };
