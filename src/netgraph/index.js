// Connectivity from traced geometry: pins, wires (polylines), vias, net
// labels and test points join into nets wherever they touch. No manual net
// naming needed: a net is named by a label / wire net name on it, else after
// its first pin (KiCad style "Net-(R1.2)").
//
// Then: graph queries (net members, neighbours, path between parts) and
// netlist export (JSON, CSV, KiCad .net).

const DEFAULT_TOLERANCE = 3;
const AUTO_PREFIX = "Net-(";

// sides connect when equal or when either is "any" (THT pin, via, unsided wire)
const sidesMeet = (a, b) => !a || !b || a === b;

const unionFind = () => {
	const parent = {};
	const find = (k) => {
		if (parent[k] === undefined) {
			parent[k] = k;
		}
		let root = k;
		while (parent[root] !== root) {
			root = parent[root];
		}
		// path compression
		let cur = k;
		while (parent[cur] !== root) {
			const next = parent[cur];
			parent[cur] = root;
			cur = next;
		}
		return root;
	};
	const union = (a, b) => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) {
			parent[ra] = rb;
		}
	};
	return { find: find, union: union };
};

const distToSegment = (p, a, b) => {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const len2 = dx * dx + dy * dy;
	const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
	return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
};

const pinKey = (ref, pin) => ref + "." + pin;

// every point that can carry a connection
const collectNodes = (board) => {
	const nodes = [];
	(board.components || []).forEach((c) => {
		(c.pins || []).forEach((p) => {
			nodes.push({ key: "P:" + pinKey(c.id, p.name), kind: "pin", ref: c.id, pin: p.name, at: [p.x, p.y], side: c.side || null });
		});
	});
	(board.wires || []).forEach((w) => {
		(w.points || []).forEach((pt, i) => {
			nodes.push({ key: "W:" + w.id + ":" + i, kind: "vertex", wire: w.id, at: pt, side: w.side || null });
		});
	});
	(board.vias || []).forEach((v) => {
		nodes.push({ key: "V:" + v.id, kind: "via", id: v.id, at: [v.x, v.y], side: null });
	});
	(board.labels || []).forEach((l) => {
		nodes.push({ key: "L:" + l.id, kind: "label", id: l.id, name: l.name, at: [l.x, l.y], side: l.side || null });
	});
	(board.testpoints || []).forEach((t) => {
		nodes.push({ key: "T:" + t.id, kind: "testpoint", id: t.id, at: [t.x, t.y], side: t.side || null });
	});
	return nodes;
};

/**
 * Compute nets from the traced geometry.
 * @param {Object} board components/wires/vias/labels/testpoints/nets
 * @param {number} [tolerance] distance (board units) at which things touch
 * @returns {{nets: Array, pinNet: Object<string, string>, unconnected: Array<string>}}
 */
const connectivity = (board, tolerance) => {
	const tol = tolerance === undefined ? (board.snap || DEFAULT_TOLERANCE) : tolerance;
	const uf = unionFind();
	const nodes = collectNodes(board);
	nodes.forEach((n) => uf.find(n.key));

	// 1. a wire conducts along its length
	(board.wires || []).forEach((w) => {
		(w.points || []).slice(1).forEach((_, i) => uf.union("W:" + w.id + ":" + i, "W:" + w.id + ":" + (i + 1)));
	});

	// 2. points that coincide (grid buckets of size tol keep this near-linear)
	const cell = Math.max(tol, 1e-6);
	const buckets = {};
	const bucketKey = (x, y) => Math.floor(x / cell) + "," + Math.floor(y / cell);
	nodes.forEach((n) => {
		const k = bucketKey(n.at[0], n.at[1]);
		(buckets[k] = buckets[k] || []).push(n);
	});
	nodes.forEach((n) => {
		const bx = Math.floor(n.at[0] / cell);
		const by = Math.floor(n.at[1] / cell);
		[-1, 0, 1].forEach((dx) => [-1, 0, 1].forEach((dy) => {
			(buckets[(bx + dx) + "," + (by + dy)] || []).forEach((m) => {
				if (m.key < n.key && sidesMeet(n.side, m.side) && Math.hypot(n.at[0] - m.at[0], n.at[1] - m.at[1]) <= tol) {
					uf.union(n.key, m.key);
				}
			});
		}));
	});

	// 3. T-junctions: a point lying on another wire's segment
	(board.wires || []).forEach((w) => {
		const pts = w.points || [];
		pts.slice(1).forEach((b, i) => {
			const a = pts[i];
			const minX = Math.min(a[0], b[0]) - tol;
			const maxX = Math.max(a[0], b[0]) + tol;
			const minY = Math.min(a[1], b[1]) - tol;
			const maxY = Math.max(a[1], b[1]) + tol;
			nodes.forEach((n) => {
				if (n.wire === w.id || n.at[0] < minX || n.at[0] > maxX || n.at[1] < minY || n.at[1] > maxY || !sidesMeet(n.side, w.side || null)) {
					return;
				}
				if (distToSegment(n.at, a, b) <= tol) {
					uf.union(n.key, "W:" + w.id + ":" + i);
				}
			});
		});
	});

	// 4. same name = same net (schematic labels, named wires)
	const named = {};
	const nameNode = (name, key) => {
		if (named[name]) {
			uf.union(named[name], key);
		} else {
			named[name] = key;
		}
	};
	nodes.filter((n) => n.kind === "label" && n.name).forEach((n) => nameNode(n.name, n.key));
	(board.wires || []).filter((w) => w.net && (w.points || []).length).forEach((w) => nameNode(w.net, "W:" + w.id + ":0"));

	// group
	const groups = {};
	nodes.forEach((n) => {
		const root = uf.find(n.key);
		(groups[root] = groups[root] || []).push(n);
	});
	const wireNames = {};
	(board.wires || []).forEach((w) => {
		wireNames[w.id] = w.net;
	});

	const meta = board.nets || {};
	const nets = Object.keys(groups).map((root) => {
		const members = groups[root];
		const pins = members.filter((n) => n.kind === "pin").map((n) => pinKey(n.ref, n.pin)).sort(comparePins);
		const wires = Array.from(new Set(members.filter((n) => n.kind === "vertex").map((n) => n.wire))).sort();
		const names = Array.from(new Set(members.filter((n) => n.kind === "label").map((n) => n.name)
			.concat(wires.map((id) => wireNames[id]).filter(Boolean)))).sort();
		let name = names[0];
		if (!name) {
			name = AUTO_PREFIX + (pins[0] || wires[0] || members[0].key) + ")";
		}
		return {
			name: name,
			aliases: names.slice(1),
			pins: pins,
			wires: wires,
			vias: members.filter((n) => n.kind === "via").map((n) => n.id).sort(),
			testpoints: members.filter((n) => n.kind === "testpoint").map((n) => n.id).sort(),
			labels: members.filter((n) => n.kind === "label").map((n) => n.id).sort(),
			color: (meta[name] && meta[name].color) || undefined,
			auto: names.length === 0
		};
	}).filter((net) => net.pins.length || net.wires.length || net.labels.length || net.testpoints.length)
		.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

	// a pin touching nothing is not a net
	const lone = (net) => net.pins.length === 1 && !net.wires.length && !net.testpoints.length && !net.labels.length && !net.vias.length;
	const kept = nets.filter((net) => !lone(net));
	const pinNet = {};
	kept.forEach((net) => net.pins.forEach((p) => {
		pinNet[p] = net.name;
	}));
	return { nets: kept, pinNet: pinNet, unconnected: nets.filter(lone).map((net) => net.pins[0]) };
};

function comparePins(a, b) {
	return a.localeCompare(b, undefined, { numeric: true });
}

/**
 * Query the connectivity graph.
 * @param {Object} board
 * @param {Object} conn result of connectivity()
 */
const graph = (board, conn) => {
	const comps = {};
	(board.components || []).forEach((c) => {
		comps[c.id] = c;
	});
	const netByName = {};
	conn.nets.forEach((net) => {
		netByName[net.name] = net;
		net.aliases.forEach((a) => {
			netByName[a] = net;
		});
	});
	const refOf = (pin) => pin.slice(0, pin.lastIndexOf("."));

	const q = {
		net: (name) => {
			const net = netByName[name];
			if (!net) {
				throw new Error("unknown net: " + name);
			}
			return net;
		},

		/**
		 * The net on a pin ("U3.12") and everything else on it.
		 */
		pin: (pin) => {
			const ref = refOf(pin);
			if (!comps[ref] || !(comps[ref].pins || []).some((p) => pinKey(ref, p.name) === pin)) {
				throw new Error("unknown pin: " + pin + " (use REF.PIN, e.g. U3.12)");
			}
			const name = conn.pinNet[pin];
			if (!name) {
				return { pin: pin, net: null, connected: [] };
			}
			const net = netByName[name];
			return { pin: pin, net: name, connected: net.pins.filter((p) => p !== pin), testpoints: net.testpoints };
		},

		/**
		 * Per pin of a component: its net and the other pins on it; plus the
		 * set of neighbouring components (optionally ignoring nets like GND).
		 */
		neighbors: (ref, avoid) => {
			const c = comps[ref];
			if (!c) {
				throw new Error("unknown component: " + ref);
			}
			const skip = new Set(avoid || []);
			const pins = (c.pins || []).map((p) => {
				const key = pinKey(ref, p.name);
				const name = conn.pinNet[key] || null;
				const others = name ? netByName[name].pins.filter((o) => o !== key) : [];
				return { pin: p.name, net: name, connected: others };
			});
			const near = new Set();
			pins.filter((p) => p.net && !skip.has(p.net)).forEach((p) => p.connected.forEach((o) => {
				if (refOf(o) !== ref) {
					near.add(refOf(o));
				}
			}));
			return { ref: ref, value: c.value, pins: pins, neighbors: Array.from(near).sort(comparePins) };
		},

		/**
		 * Shortest path from a component / pin / net to another, through
		 * components and nets. `avoid` lists nets not to walk through (GND, VCC).
		 */
		path: (from, to, avoid) => {
			const skip = new Set(avoid || []);
			const start = q.nodeOf(from);
			const goal = q.nodeOf(to);
			const prev = {};
			prev[start] = null;
			const queue = [start];
			while (queue.length && prev[goal] === undefined) {
				const cur = queue.shift();
				q.edges(cur, skip).forEach((e) => {
					if (prev[e.to] === undefined) {
						prev[e.to] = { from: cur, via: e.via };
						queue.push(e.to);
					}
				});
			}
			if (prev[goal] === undefined) {
				return { from: from, to: to, found: false, steps: [] };
			}
			const steps = [];
			let cur = goal;
			while (prev[cur]) {
				steps.unshift({ node: cur, via: prev[cur].via });
				cur = prev[cur].from;
			}
			steps.unshift({ node: start });
			return { from: from, to: to, found: true, steps: steps };
		},

		// graph nodes are "C:<ref>" and "N:<net>"; edges go through pins
		nodeOf: (what) => {
			if (comps[what]) {
				return "C:" + what;
			}
			if (netByName[what]) {
				return "N:" + netByName[what].name;
			}
			if (conn.pinNet[what]) {
				return "N:" + conn.pinNet[what];
			}
			throw new Error("not a component, pin or net: " + what);
		},

		edges: (node, skip) => {
			if (node.startsWith("C:")) {
				const ref = node.slice(2);
				return (comps[ref].pins || []).map((p) => pinKey(ref, p.name))
					.filter((key) => conn.pinNet[key] && !skip.has(conn.pinNet[key]))
					.map((key) => ({ to: "N:" + conn.pinNet[key], via: key }));
			}
			const net = netByName[node.slice(2)];
			return net.pins.filter((p) => comps[refOf(p)]).map((p) => ({ to: "C:" + refOf(p), via: p }));
		},

		/**
		 * Components, pins and nets matching a text (case-insensitive substring).
		 */
		search: (text) => {
			const needle = String(text).toLowerCase();
			const hit = (s) => s !== undefined && s !== null && String(s).toLowerCase().indexOf(needle) !== -1;
			return {
				components: Object.keys(comps).filter((ref) => hit(ref) || hit(comps[ref].value) || hit(comps[ref].footprint)).sort(comparePins),
				nets: conn.nets.filter((n) => hit(n.name) || n.aliases.some(hit)).map((n) => n.name),
				pins: Object.keys(conn.pinNet).filter(hit).sort(comparePins)
			};
		}
	};
	return q;
};

const csvCell = (v) => {
	const s = String(v === undefined || v === null ? "" : v);
	return /[",\n]/.test(s) ? "\"" + s.replace(/"/g, "\"\"") + "\"" : s;
};

const sexpString = (v) => "\"" + String(v === undefined || v === null ? "" : v).replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\"";

/**
 * Netlist in `format`: "json" (object), "csv" (net,ref,pin rows) or "kicad"
 * (KiCad s-expression .net, version E).
 */
const netlist = (board, conn, format) => {
	const refOf = (pin) => pin.slice(0, pin.lastIndexOf("."));
	const pinOf = (pin) => pin.slice(pin.lastIndexOf(".") + 1);
	const comps = (board.components || []).slice().sort((a, b) => comparePins(a.id, b.id));
	if (format === "csv") {
		const rows = [["net", "ref", "pin"]].concat(...conn.nets.map((net) => net.pins.map((p) => [net.name, refOf(p), pinOf(p)])));
		return rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
	}
	if (format === "kicad") {
		const compLines = comps.map((c) => "    (comp (ref " + sexpString(c.id) + ") (value " + sexpString(c.value || "~") + ") (footprint " + sexpString(c.footprint || "") + "))");
		const netLines = conn.nets.filter((n) => n.pins.length).map((net, i) => "    (net (code " + sexpString(i + 1) + ") (name " + sexpString(net.name) + ")\n"
			+ net.pins.map((p) => "      (node (ref " + sexpString(refOf(p)) + ") (pin " + sexpString(pinOf(p)) + "))").join("\n") + ")");
		return "(export (version \"E\")\n  (design (source " + sexpString(board.name || "") + ") (tool \"mailab\"))\n"
			+ "  (components\n" + compLines.join("\n") + ")\n  (nets\n" + netLines.join("\n") + "))\n";
	}
	return {
		components: comps.map((c) => ({
			ref: c.id, value: c.value || "", footprint: c.footprint || "", side: c.side || null,
			pins: (c.pins || []).map((p) => ({ name: p.name, net: conn.pinNet[pinKey(c.id, p.name)] || null }))
		})),
		nets: conn.nets.map((net) => ({ name: net.name, aliases: net.aliases, nodes: net.pins.map((p) => ({ ref: refOf(p), pin: pinOf(p) })), testpoints: net.testpoints })),
		unconnected: conn.unconnected
	};
};

module.exports = {
	DEFAULT_TOLERANCE: DEFAULT_TOLERANCE,
	connectivity: connectivity,
	graph: graph,
	netlist: netlist,
	sidesMeet: sidesMeet
};
