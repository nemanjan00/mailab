// Experiment journal: notes with enforced evidence tags + run records.
//
// Notes are AI/person conclusions. A note that links to real lab data
// (channels, traces, values, blobs, images, runs) is tagged [HW]
// automatically; a note with nothing backing it is tagged [INF] — the
// mdp-p906 convention, computed here so it cannot be forgotten.
//
// A run record (created around a batch, sweep, or any scripted sequence)
// stores the device options at start, the setpoints/commands issued, and the
// data references created during the run. Runs export to markdown.

const fs = require("fs");
const path = require("path");

const MAX_NOTES = 2000;
const MAX_RUNS = 500;
const MAX_LINKS = 50;

const load = (file) => {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (_e) {
		return {};
	}
};

const create = (lab, file) => {
	const saved = load(file);
	let notes = Array.isArray(saved.notes) ? saved.notes : [];
	let runs = Array.isArray(saved.runs) ? saved.runs : [];
	let noteId = notes.reduce((m, n) => Math.max(m, n.id || 0), 0);
	let runId = runs.reduce((m, r) => Math.max(m, r.id || 0), 0);

	const persist = () => {
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, JSON.stringify({ notes: notes, runs: runs }));
		} catch (e) {
			lab.log("journal", "persist failed: " + e.message, "error");
		}
	};

	// every live data reference, name -> kind
	const dataIndex = () => {
		const map = {};
		channelsIndex().forEach((name) => {
			map[name] = "channel";
		});
		lab.listTraces().forEach((tr) => {
			map[tr.name] = "trace";
		});
		lab.listValues().forEach((v) => {
			map[v.name] = "value";
		});
		lab.listBlobs().forEach((b) => {
			map[b.name] = "blob";
		});
		lab.listImages().forEach((im) => {
			map[im.name] = "image";
		});
		runs.forEach((r) => {
			map[r.name] = "run";
		});
		return map;
	};

	// channels.list() lives behind the lab state, not lab.*; find it lazily
	const channelsIndex = () => {
		const state = lab.state();
		return (state.channels || []).map((c) => c.name);
	};

	const resolveLink = (name, index) => {
		const kind = index[name];
		return kind ? { name: name, kind: kind } : null;
	};

	/**
	 * Add a journal note; the evidence tag is computed, never chosen.
	 * @param {{text: string, links?: string[], who?: string}} entry
	 */
	const addNote = (entry) => {
		const text = String(entry.text || "").trim();
		if (!text) {
			throw new Error("note text is empty");
		}
		const links = Array.from(new Set((entry.links || []).map(String))).slice(0, MAX_LINKS);
		const index = dataIndex();
		const resolved = [];
		const unresolved = [];
		links.forEach((name) => {
			const hit = resolveLink(name, index);
			if (hit) {
				resolved.push(hit);
			} else {
				unresolved.push(name);
			}
		});
		const note = {
			id: ++noteId,
			t: Date.now(),
			who: entry.who || "",
			text: text,
			links: resolved.map((r) => r.name),
			linkKinds: resolved.reduce((acc, r) => {
				acc[r.name] = r.kind;
				return acc;
			}, {}),
			tags: resolved.length ? ["HW"] : ["INF"],
			unresolved: unresolved
		};
		notes.push(note);
		if (notes.length > MAX_NOTES) {
			notes = notes.slice(-MAX_NOTES);
		}
		persist();
		return note;
	};

	/**
	 * Capture the state a run starts from; pass it to recordRun.
	 */
	const snapshot = () => {
		return {
			t: Date.now(),
			index: dataIndex(),
			devices: lab.listDevices().map((d) => {
				return { id: d.id, driver: d.driver, options: d.options || {} };
			})
		};
	};

	/**
	 * Record a run: device options snapshot, setpoints (activity) and data
	 * created while `fn` runs. `before` comes from snapshot(); when omitted it
	 * is taken here (which misses anything fn already did).
	 * @param {string} name
	 * @param {Object} [before] snapshot() taken before the run
	 * @param {function(): Promise} fn
	 * @returns {Promise<Object>} the run record
	 */
	const recordRun = (name, before, fn) => {
		const start = (typeof before === "function" ? null : before) || snapshot();
		const runFn = typeof before === "function" ? before : fn;
		return Promise.resolve().then(runFn).then((result) => {
			const after = dataIndex();
			const data = Object.keys(after).filter((n) => !start.index[n]).map((n) => {
				return { name: n, kind: after[n] };
			});
			const setpoints = lab.getActivity().filter((a) => a.t >= start.t).map((a) => {
				return { t: a.t, who: a.who || "", tool: a.tool, args: a.args, ok: a.ok !== false };
			});
			const run = {
				id: ++runId,
				name: name || ("run-" + runId),
				t: start.t,
				ok: !(result && result.ok === false),
				devices: start.devices,
				setpoints: setpoints,
				data: data
			};
			runs.push(run);
			if (runs.length > MAX_RUNS) {
				runs = runs.slice(-MAX_RUNS);
			}
			persist();
			return run;
		});
	};

	const findRun = (nameOrId) => {
		return runs.find((r) => r.name === nameOrId) || runs.find((r) => r.id === Number(nameOrId)) || null;
	};

	const esc = (s) => String(s).replace(/\|/g, "\\|");

	/** a run as markdown: devices, setpoints, data, and notes referencing it */
	const exportRun = (nameOrId) => {
		const run = findRun(nameOrId);
		if (!run) {
			throw new Error("no run named " + nameOrId);
		}
		const lines = [];
		lines.push("# Run \"" + run.name + "\" (" + new Date(run.t).toISOString() + ")");
		lines.push("");
		lines.push("- result: " + (run.ok ? "ok" : "failed"));
		lines.push("");
		lines.push("## Devices");
		lines.push("");
		lines.push("| device | driver | options |");
		lines.push("| --- | --- | --- |");
		run.devices.forEach((d) => {
			lines.push("| " + esc(d.id) + " | " + esc(d.driver) + " | `" + esc(JSON.stringify(d.options)) + "` |");
		});
		lines.push("");
		lines.push("## Setpoints");
		lines.push("");
		run.setpoints.forEach((s) => {
			lines.push("- `" + new Date(s.t).toISOString() + "` " + esc(s.who) + " " + esc(s.tool) + " " + esc(s.args) + (s.ok ? "" : " **FAILED**"));
		});
		lines.push("");
		lines.push("## Data");
		lines.push("");
		if (run.data.length) {
			run.data.forEach((d) => {
				lines.push("- " + d.name + " (" + d.kind + ")");
			});
		} else {
			lines.push("- (no new data references)");
		}
		const linked = notes.filter((n) => {
			return n.links.indexOf(run.name) !== -1 || n.links.some((l) => run.data.some((d) => d.name === l));
		});
		if (linked.length) {
			lines.push("");
			lines.push("## Notes");
			lines.push("");
			linked.forEach((n) => {
				lines.push("- [" + n.tags.join(",") + "] " + esc(n.text) + " — links: " + n.links.join(", "));
			});
		}
		lines.push("");
		return lines.join("\n");
	};

	return {
		addNote: addNote,
		snapshot: snapshot,
		notes: (filter) => {
			if (!filter) {
				return notes.slice();
			}
			return notes.filter((n) => n.text.indexOf(filter) !== -1);
		},
		getNote: (id) => notes.find((n) => n.id === Number(id)) || null,
		recordRun: recordRun,
		runs: () => runs.slice(),
		findRun: findRun,
		exportRun: exportRun
	};
};

module.exports = { create: create };
