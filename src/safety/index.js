// Safety: server-enforced rules and human approvals for risky AI commands.
//
// Rules hold even if the AI is wrong, slow or gone: the server checks them on
// every sample of their inputs and on a short tick (for "silent" conditions).
//   {name, when: "mdp_i > 0.5", for_ms: 0, action: {device: "mdp", command: "output", args: {on: false}},
//    cooldown_ms: 5000, locked: true}
// Channel symbols are latest values; `<channel>_age` is seconds since its last sample.
//
// Approvals: an AI command matching the policy waits for a person to approve
// it in the chat pane. Default policy: power outputs on, voltage above 5 V,
// PTT, glitch campaigns, pairing.

const randomUUID = require("crypto").randomUUID;
const math = require("../math");

const TICK_MS = 250;
const APPROVAL_TIMEOUT_MS = 120000;
const MAX_FIRED_LOG = 200;

const DEFAULT_POLICY = [
	{ command: "output", when: "on", reason: "turns a power output on" },
	{ command: "set_output", when: "on", reason: "turns a power output on" },
	{ command: "set_voltage", when: "volts > 5", reason: "voltage above 5 V" },
	{ command: "ptt", when: "on", reason: "keys a transmitter" },
	{ command: "campaign", reason: "arms a glitch campaign" },
	{ command: "glitch", reason: "fires a glitch" },
	{ command: "pair", reason: "pairs a radio module" },
	{ command: "usb_power", reason: "switches power on a USB hub port (the device on it drops off the bus)" }
];

const truthy = (value) => {
	return value === true || (typeof value === "number" && value !== 0);
};

/**
 * Flatten command args into a mathjs scope: {on: true, volts: 3.3} -> on, volts
 * (booleans become 1/0; "on"/"off" strings count as switches).
 */
const argsScope = (args) => {
	const scope = {};
	Object.keys(args || {}).forEach((key) => {
		const v = args[key];
		if (v === "on" || v === "true") {
			scope[key] = 1;
		} else if (v === "off" || v === "false") {
			scope[key] = 0;
		} else if (typeof v === "boolean") {
			scope[key] = v ? 1 : 0;
		} else if (typeof v === "number") {
			scope[key] = v;
		} else if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
			scope[key] = Number(v);
		}
	});
	return scope;
};

/**
 * @param {Object} lab
 * @param {{rules: Object[], policy: Object[], onChange: function}} saved persisted rules/policy
 */
const create = (lab, saved) => {
	const s = saved || {};
	let rules = [];
	let policy = s.policy || DEFAULT_POLICY.slice();
	const fired = [];
	const pending = {};
	let nextApproval = 1;

	// unique ids: a counter restarting at boot could hand a new rule the id of a
	// restored (locked) one and silently replace it
	const newId = () => "r-" + randomUUID().slice(0, 8);

	const compileRule = (spec) => {
		const compiled = math.compile(spec.when);
		return Object.assign({
			id: spec.id || newId(),
			for_ms: 0,
			cooldown_ms: 5000,
			enabled: true,
			locked: false
		}, spec, {
			compiled: compiled,
			since: null,
			lastFired: 0,
			failing: false
		});
	};

	const describe = (r) => {
		return {
			id: r.id, name: r.name, when: r.when, for_ms: r.for_ms, action: r.action,
			cooldown_ms: r.cooldown_ms, enabled: r.enabled, locked: r.locked, lastFired: r.lastFired || null
		};
	};

	const fire = (r, value) => {
		r.lastFired = Date.now();
		const entry = { t: r.lastFired, rule: r.name || r.id, when: r.when, action: r.action };
		fired.push(entry);
		if (fired.length > MAX_FIRED_LOG) {
			fired.shift();
		}
		let actionText = "alarm only";
		let run = Promise.resolve();
		if (r.action && r.action.device && r.action.command) {
			actionText = r.action.device + "." + r.action.command + " " + JSON.stringify(r.action.args || {});
			run = lab.commandDevice(r.action.device, r.action.command, r.action.args || {});
		}
		lab.recordActivity({ who: "safety", tool: "rule " + (r.name || r.id), args: r.when + " → " + actionText, ok: true });
		lab.notify({ type: "rule", rule: r.name || r.id, when: r.when, value: value, action: actionText });
		return run.then(() => {
			lab.postChat({ from: "safety", kind: "safety", text: "⚠ rule **" + (r.name || r.id) + "** fired (`" + r.when + "` = " + value + "): " + actionText });
		}, (err) => {
			lab.recordActivity({ who: "safety", tool: "rule " + (r.name || r.id), args: actionText, ok: false, error: err.message });
			lab.postChat({ from: "safety", kind: "safety", text: "⚠ rule **" + (r.name || r.id) + "** fired but its action failed: " + err.message });
		});
	};

	const check = (r, now) => {
		if (!r.enabled) {
			return;
		}
		const scope = lab.scopeFor(r.compiled.inputs, { latest: true });
		// a rule over channels that have no data yet stays quiet
		const missing = r.compiled.inputs.some((sym) => scope[sym] === undefined && lab.isLabSymbol(sym));
		if (missing) {
			r.since = null;
			return;
		}
		let value;
		try {
			value = r.compiled.evaluate(scope);
		} catch (err) {
			// fail loud: a safety rule that can't be evaluated protects nothing
			if (!r.failing) {
				r.failing = true;
				lab.recordActivity({ who: "safety", tool: "rule " + (r.name || r.id), args: r.when, ok: false, error: err.message });
				lab.postChat({ from: "safety", kind: "safety", text: "⚠ rule **" + (r.name || r.id) + "** can't be evaluated (`" + r.when + "`): " + err.message + ". It is not protecting anything until fixed." });
			}
			return;
		}
		r.failing = false;
		if (!truthy(value)) {
			r.since = null;
			return;
		}
		if (r.since === null) {
			r.since = now;
		}
		if (now - r.since >= r.for_ms && now - r.lastFired >= r.cooldown_ms) {
			fire(r, value);
		}
	};

	const safety = {
		DEFAULT_POLICY: DEFAULT_POLICY,

		// ---- rules ---------------------------------------------------------

		addRule: (spec, who) => {
			if (!spec.when) {
				throw new Error("rule needs `when` (a condition over channels)");
			}
			if (spec.action && (!spec.action.device || !spec.action.command)) {
				throw new Error("rule action needs device and command");
			}
			const existing = spec.id && rules.find((x) => x.id === spec.id);
			if (existing && existing.locked) {
				throw new Error("rule " + spec.id + " is locked and can't be replaced");
			}
			const r = compileRule(spec);
			rules = rules.filter((x) => x.id !== r.id).concat([r]);
			lab.recordActivity({ who: who || "local", tool: "rule_add", args: (r.name || r.id) + ": " + r.when, ok: true });
			safety.changed();
			return describe(r);
		},

		/**
		 * @param {boolean} human only people may remove locked rules
		 */
		removeRule: (id, human) => {
			const r = rules.find((x) => x.id === id);
			if (!r) {
				throw new Error("unknown rule: " + id);
			}
			if (r.locked && !human) {
				throw new Error("rule " + id + " is locked: only a person can remove it (web UI)");
			}
			rules = rules.filter((x) => x.id !== id);
			safety.changed();
		},

		listRules: () => rules.map(describe),

		firedLog: () => fired.slice(),

		/**
		 * Check rules that depend on `channel` (called for every sample).
		 */
		onSample: (channel) => {
			const now = Date.now();
			rules.forEach((r) => {
				if (r.compiled.inputs.indexOf(channel) !== -1) {
					check(r, now);
				}
			});
		},

		tick: () => {
			const now = Date.now();
			rules.forEach((r) => check(r, now));
		},

		// ---- approvals -------------------------------------------------------

		setPolicy: (list) => {
			list.forEach((p) => {
				if (!p.command) {
					throw new Error("policy entries need `command`");
				}
				if (p.when) {
					math.compile(p.when);
				}
			});
			policy = list.slice();
			safety.changed();
		},

		getPolicy: () => policy.slice(),

		/**
		 * Policy entry matching an AI command, or null.
		 */
		needsApproval: (deviceId, driver, command, args) => {
			return policy.find((p) => {
				if (p.command !== command) {
					return false;
				}
				if (p.device && p.device !== deviceId) {
					return false;
				}
				if (p.driver && p.driver !== driver) {
					return false;
				}
				if (!p.when) {
					return true;
				}
				try {
					return truthy(math.compile(p.when).evaluate(argsScope(args)));
				} catch (_err) {
					// unknown args: ask rather than guess
					return true;
				}
			}) || null;
		},

		/**
		 * Ask the people in the lab; resolves on approve, rejects on deny/timeout.
		 */
		requestApproval: (request) => {
			const id = "a" + nextApproval++;
			const entry = Object.assign({ id: id, t: Date.now(), status: "pending" }, request);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					safety.decide(id, "timeout", "nobody");
				}, request.timeoutMs || APPROVAL_TIMEOUT_MS);
				timer.unref();
				pending[id] = { entry: entry, resolve: resolve, reject: reject, timer: timer };
				lab.postChat({
					from: "approval", kind: "approval", approval: entry,
					text: "🔐 **" + request.who + "** wants `" + request.device + "." + request.command + " " + JSON.stringify(request.args || {}) + "`: " + request.reason
				});
				lab.events.emit("approval", entry);
				lab.notify({ type: "approval", approval: entry.id, who: request.who, device: request.device, command: request.command, reason: request.reason });
			});
		},

		decide: (id, decision, who) => {
			const p = pending[id];
			if (!p) {
				throw new Error("no pending approval " + id);
			}
			delete pending[id];
			clearTimeout(p.timer);
			p.entry.status = decision;
			p.entry.by = who;
			lab.events.emit("approval", p.entry);
			lab.postChat({ from: "approval", kind: "approval", text: (decision === "approved" ? "✅ " : "⛔ ") + "`" + p.entry.device + "." + p.entry.command + "` " + decision + " by " + who });
			if (decision === "approved") {
				p.resolve(p.entry);
			} else {
				p.reject(new Error("not approved (" + decision + (who ? " by " + who : "") + "): " + p.entry.device + "." + p.entry.command));
			}
			return p.entry;
		},

		listPending: () => Object.keys(pending).map((id) => pending[id].entry),

		/**
		 * Command runner for multi-step AI work (sweep, optimize). Every command
		 * goes through the approval policy like device_command; `preapprove`
		 * asks a person once for a whole plan instead of once per step.
		 * @param {string} who actor shown in the approval request
		 */
		gate: (who) => {
			// "device.command" pairs a person approved as part of a plan
			const approved = {};
			const ruleFor = (c) => safety.needsApproval(c.device, lab.getDevice(c.device).driver, c.command, c.args || {});
			return {
				/**
				 * @param {{device: string, command: string, args: Object}[]} commands every command the plan may run
				 * @param {string} label what the plan is ("sweep psu.set_voltage volts 1..12")
				 * @returns {Promise<{needed: number}>} resolves when nothing needs approval or a person approved
				 */
				preapprove: (commands, label) => {
					const hits = commands.map((c) => ({ c: c, rule: ruleFor(c) })).filter((h) => h.rule);
					if (!hits.length) {
						return Promise.resolve({ needed: 0 });
					}
					const pairs = hits.map((h) => h.c.device + "." + h.c.command).filter((p, i, all) => all.indexOf(p) === i);
					const reasons = hits.map((h) => h.rule.reason || "approval required").filter((r, i, all) => all.indexOf(r) === i);
					return safety.requestApproval({
						who: who,
						device: pairs.map((p) => p.split(".")[0]).filter((d, i, all) => all.indexOf(d) === i).join(","),
						command: label,
						args: { steps: commands.length, needApproval: hits.length, first: hits[0].c.args, last: hits[hits.length - 1].c.args },
						reason: hits.length + " of " + commands.length + " steps: " + reasons.join("; ")
					}).then(() => {
						pairs.forEach((p) => {
							approved[p] = true;
						});
						return { needed: hits.length };
					});
				},

				run: (device, command, args) => {
					const rule = ruleFor({ device: device, command: command, args: args });
					if (!rule || approved[device + "." + command]) {
						return lab.commandDevice(device, command, args || {});
					}
					return safety.requestApproval({ who: who, device: device, command: command, args: args || {}, reason: rule.reason || "approval required" })
						.then(() => lab.commandDevice(device, command, args || {}));
				}
			};
		},

		// ---- persistence ------------------------------------------------------

		changed: () => {},

		snapshot: () => ({ rules: rules.map((r) => {
			const d = describe(r);
			delete d.lastFired;
			return d;
		}), policy: policy }),

		/**
		 * Replace rules and policy (loading a lab profile).
		 */
		load: (snap) => {
			rules = [];
			(snap.rules || []).forEach((spec) => {
				rules.push(compileRule(spec));
			});
			policy = (snap.policy || DEFAULT_POLICY).slice();
			safety.changed();
		},

		restore: () => {
			(s.rules || []).forEach((spec) => {
				try {
					rules.push(compileRule(spec));
				} catch (err) {
					lab.log("safety", "rule " + spec.id + ": " + err.message, "error");
				}
			});
		},

		start: () => {
			const timer = setInterval(safety.tick, TICK_MS);
			timer.unref();
			return () => clearInterval(timer);
		}
	};

	return safety;
};

module.exports = {
	create: create,
	argsScope: argsScope,
	DEFAULT_POLICY: DEFAULT_POLICY
};
