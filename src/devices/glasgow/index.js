// Glasgow Interface Explorer via its CLI: device list, applet discovery,
// and arbitrary applet runs with streamed output. Hardware-untested: the
// CLI surface is stable, applet args are passed through verbatim [HW].

const tool = require("../../utils/tool");

const parseList = (out) => {
	// "0: C3-20240101GT (rev C3, firmware 1.0.1)" per connected device
	return out.split("\n").map((line) => {
		const m = /^(\d+):\s+(\S+)\s+\(rev\s+([^,]+),\s+firmware\s+([^)]+)\)/.exec(line.trim());
		return m ? { index: parseInt(m[1], 10), serial: m[2], rev: m[3], firmware: m[4] } : null;
	}).filter(Boolean);
};

const create = (options, io) => {
	const settings = {
		exe: options.exe || "glasgow",
		timeoutMs: Number(options.timeoutMs) || 120000
	};
	// one applet at a time: the device is exclusive
	const runExclusive = require("../../utils/mutex").serialize((args, timeoutMs, onLine) => {
		return tool.run(settings.exe, args, { timeoutMs: timeoutMs || settings.timeoutMs, onLine: onLine });
	});

	const commands = {
		list: () => {
			return runExclusive(["list"], 30000).then((r) => {
				const devices = parseList(r.output);
				io.log("glasgow: " + (devices.length ? devices.length + " device(s)" : "no devices"), "info");
				return { devices: devices, raw: r.output.trim() };
			});
		},

		applets: () => {
			return runExclusive(["list-applets"], 30000).then((r) => {
				return { applets: r.output.split("\n").map((s) => s.trim()).filter(Boolean) };
			});
		},

		// run any applet: glasgow run <applet> [-- <args>], lines stream to the log
		run: (args) => {
			const applet = tool.checkName(args.applet, "applet");
			const rest = (args.args || []).map((a) => String(a));
			const cli = ["run", applet].concat(rest.length ? ["--"].concat(rest) : []);
			io.log("+ " + settings.exe + " " + cli.join(" "), "tx");
			return runExclusive(cli, args.timeoutMs).then((r) => {
				// applet output lands in the log on completion (tool.run buffers)
				r.output.trim().split("\n").slice(0, 100).forEach((line) => io.log(line, "rx"));
				return { code: r.code, out: r.stdout.trim(), err: r.stderr.trim() };
			});
		},

		status: () => ({ settings: settings })
	};

	return {
		start: () => Promise.resolve(),
		stop: () => Promise.resolve(),
		command: (name, args) => {
			if (!commands[name]) {
				return Promise.reject(new Error("unknown command: " + name));
			}
			return Promise.resolve().then(() => commands[name](args || {}));
		}
	};
};

module.exports = {
	name: "glasgow",
	description: "Glasgow Interface Explorer via the CLI: connected-device list, applet discovery, arbitrary applet runs with output streamed to the log",
	options: {
		exe: "glasgow binary (default from PATH)",
		timeoutMs: "default applet timeout (default 120000)"
	},
	commands: {
		list: "{} connected Glasgow devices (serial, rev, firmware)",
		applets: "{} available applets",
		run: "{applet, args?: [], timeoutMs?} run an applet, output -> log",
		status: "{} settings"
	},
	create: create,
	_test: { parseList: parseList }
};
