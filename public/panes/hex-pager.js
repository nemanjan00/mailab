// Paged, cached byte access to a lab blob for the hex editor: only the pages
// the view asks for are fetched (GET /api/blobs/:name/range), kept in an LRU,
// and after an invalidation the old pages stay visible until fresh ones land
// (no flicker on every save). Also the write queue: local pokes are shown
// at once (dirty overlay) and saved in debounced batches; insert / delete /
// fill go out immediately. Every save returns undo ops.

const PAGE = 16384;
const MAX_PAGES = 512;
const SAVE_DELAY_MS = 500;

/**
 * @param {string} name blob name
 * @param {function()} onChange called when pages arrive or the size changes
 */
export const createPager = (name, onChange) => {
	let pages = new Map();
	let stale = new Map();
	let loading = new Map();
	let gen = 0;

	const pager = {
		size: null,
		error: "",

		/**
		 * Byte at offset from cache (fresh, else stale), undefined if not loaded.
		 */
		byte: (o) => {
			const idx = Math.floor(o / PAGE);
			const page = pages.get(idx) || stale.get(idx);
			if (!page) {
				return undefined;
			}
			return page[o - idx * PAGE];
		},

		loaded: (o) => {
			const idx = Math.floor(o / PAGE);
			const page = pages.get(idx) || stale.get(idx);
			return Boolean(page) && o - idx * PAGE < page.length;
		},

		/**
		 * Make sure [start, end) is cached or on its way (also refreshes LRU order).
		 */
		want: (start, end) => {
			const first = Math.floor(start / PAGE);
			const last = Math.floor(Math.max(start, end - 1) / PAGE);
			for (let idx = first; idx <= last; idx++) {
				const page = pages.get(idx);
				if (page) {
					pages.delete(idx);
					pages.set(idx, page);
				} else if (!loading.has(idx)) {
					pager.fetchPage(idx);
				}
			}
		},

		fetchPage: (idx) => {
			const myGen = gen;
			loading.set(idx, myGen);
			fetch("/api/blobs/" + encodeURIComponent(name) + "/range?offset=" + idx * PAGE + "&length=" + PAGE)
				.then((res) => {
					if (!res.ok) {
						return res.json().then((body) => {
							throw new Error(body.error || res.statusText);
						});
					}
					const size = Number(res.headers.get("x-blob-size"));
					return res.arrayBuffer().then((buf) => ({ size: size, data: new Uint8Array(buf) }));
				})
				.then((r) => {
					if (myGen !== gen) {
						return;
					}
					loading.delete(idx);
					pager.error = "";
					pager.size = r.size;
					pages.set(idx, r.data);
					stale.delete(idx);
					while (pages.size > MAX_PAGES) {
						pages.delete(pages.keys().next().value);
					}
					onChange();
				}, (err) => {
					if (myGen !== gen) {
						return;
					}
					loading.delete(idx);
					pager.error = err.message;
					// a range past a shrunken end: refetch from 0 to learn the size
					if (/offset/.test(err.message) && idx > 0) {
						pager.want(0, 1);
					}
					onChange();
				});
		},

		/**
		 * Write into cached pages (after a save) so the view matches at once.
		 */
		poke: (o, value) => {
			const idx = Math.floor(o / PAGE);
			[pages.get(idx), stale.get(idx)].forEach((page) => {
				if (page && o - idx * PAGE < page.length) {
					page[o - idx * PAGE] = value;
				}
			});
		},

		/**
		 * The blob changed on the server: refetch what's shown, keep old pages meanwhile.
		 */
		invalidate: () => {
			gen++;
			stale = pages.size ? pages : stale;
			pages = new Map();
			loading = new Map();
			onChange();
		}
	};
	return pager;
};

/**
 * Write queue with undo / redo for one blob.
 * @param {Object} spec
 * @param {string} spec.name
 * @param {Object} spec.pager from createPager
 * @param {function(string, string, Object): Promise} spec.api ctx.api
 * @param {function(Object)} spec.onState ({save, error, canUndo, canRedo, note})
 */
export const createWriter = (spec) => {
	const dirty = new Map();
	let pending = [];
	let seq = 0;
	let timer = null;
	let queue = Promise.resolve();
	const undoStack = [];
	const redoStack = [];

	const report = (save, error, note) => {
		spec.onState({ save: save, error: error || "", note: note || "", canUndo: undoStack.length > 0 || pending.length > 0, canRedo: redoStack.length > 0 });
	};

	const send = (ops) => spec.api("PATCH", "/blobs/" + encodeURIComponent(spec.name), { ops: ops });

	// chain on the queue; errors are reported, never break the chain
	const enqueue = (job) => {
		const run = queue.then(job);
		queue = run.catch((err) => {
			report("error", err.message);
		});
		return run;
	};

	// take the unsaved edits now, so later edits queue behind whatever comes next
	const take = () => {
		clearTimeout(timer);
		const batch = { actions: pending, upTo: seq };
		pending = [];
		return batch;
	};

	const save = (batch) => {
		if (!batch.actions.length) {
			return Promise.resolve();
		}
		const ops = batch.actions.reduce((acc, a) => acc.concat(a.ops), []);
		report("saving");
		return send(ops).then((r) => {
			// what we sent is on the server now: move it from the overlay into the cache
			ops.forEach((op) => {
				hexBytes(op.hex).forEach((b, i) => {
					spec.pager.poke(op.offset + i, b);
				});
			});
			dirty.forEach((entry, o) => {
				if (entry.seq <= batch.upTo) {
					dirty.delete(o);
				}
			});
			let at = 0;
			batch.actions.forEach((a) => {
				const inverses = r.inverses ? r.inverses.slice(at, at + a.ops.length) : null;
				at += a.ops.length;
				if (inverses) {
					undoStack.push(inverses.slice().reverse().reduce((acc, inv) => acc.concat(inv), []));
				}
			});
			report(pending.length ? "dirty" : "saved");
		});
	};

	// pending edits first, then `job` (both in queue order)
	const afterSave = (job) => {
		const batch = take();
		return enqueue(() => save(batch).then(job));
	};

	// send ops; the inverse goes on `stack`
	const apply = (ops, stack) => {
		if (!ops || !ops.length) {
			report("saved");
			return null;
		}
		report("saving");
		return send(ops).then((r) => {
			if (r.undo) {
				stack.push(r.undo);
				report("saved");
			} else {
				report("saved", "", "too large to undo");
			}
			spec.pager.invalidate();
			return r;
		});
	};

	const writer = {
		/**
		 * Byte with unsaved local edits applied.
		 */
		byte: (o) => {
			const entry = dirty.get(o);
			return entry ? entry.v : spec.pager.byte(o);
		},

		isDirty: (o) => dirty.has(o),

		/**
		 * Overwrite bytes inside the blob (debounced save, one undo step).
		 */
		poke: (offset, data, merge) => {
			if (offset + data.length > (spec.pager.size || 0)) {
				return writer.commit([{ op: "poke", offset: offset, hex: toHex(data) }]);
			}
			seq++;
			data.forEach((b, i) => {
				dirty.set(offset + i, { v: b, seq: seq });
			});
			const last = pending[pending.length - 1];
			const op = { op: "poke", offset: offset, hex: toHex(data) };
			// merge: the second nibble of a byte belongs to the same undo step
			if (merge && last && last.ops.length === 1 && last.ops[0].offset === offset && last.ops[0].hex.length === op.hex.length) {
				last.ops[0] = op;
			} else {
				pending.push({ ops: [op] });
			}
			redoStack.length = 0;
			report("dirty");
			clearTimeout(timer);
			timer = setTimeout(() => {
				const batch = take();
				enqueue(() => save(batch));
			}, SAVE_DELAY_MS);
			return Promise.resolve();
		},

		/**
		 * Save pending edits, then apply ops at once (insert / delete / fill / large writes).
		 * @returns {Promise<Object>} the server's patch result
		 */
		commit: (ops) => {
			redoStack.length = 0;
			return afterSave(() => apply(ops, undoStack));
		},

		/**
		 * Record undo ops of a change made elsewhere (e.g. replace on the server).
		 */
		recordUndo: (ops) => {
			if (ops && ops.length) {
				undoStack.push(ops);
				redoStack.length = 0;
			}
			report("saved");
		},

		flush: () => afterSave(() => null),

		undo: () => afterSave(() => apply(undoStack.pop(), redoStack)),

		redo: () => afterSave(() => apply(redoStack.pop(), undoStack)),

		destroy: () => {
			clearTimeout(timer);
			// don't lose edits when the pane goes away
			if (pending.length) {
				save(take());
			}
		}
	};
	report("saved");
	return writer;
};

const toHex = (data) => Array.from(data, (b) => b.toString(16).padStart(2, "0")).join("");

const hexBytes = (hex) => {
	const out = [];
	for (let i = 0; i + 1 < hex.length; i += 2) {
		out.push(parseInt(hex.substr(i, 2), 16));
	}
	return out;
};

export const PAGE_SIZE = PAGE;
