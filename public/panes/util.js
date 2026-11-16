// Shared helpers for pane modules.

export const cssVar = (name) => {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
};

export const escapeHtml = (text) => {
	return String(text).replace(/[&<>"']/g, (c) => {
		return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
	});
};

const PREFIXES = [[1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"]];

// engineering notation: 0.00123 -> "1.230 m"
export const eng = (value, digits) => {
	if (value === null || value === undefined || !Number.isFinite(value)) {
		return "—";
	}
	const abs = Math.abs(value);
	if (abs === 0) {
		return (0).toFixed(digits === undefined ? 3 : digits) + " ";
	}
	const match = PREFIXES.find((p) => abs >= p[0]) || PREFIXES[PREFIXES.length - 1];
	return (value / match[0]).toFixed(digits === undefined ? 3 : digits) + " " + match[1];
};

export const time = (t) => {
	return new Date(t).toLocaleTimeString([], { hour12: false });
};

// coalesce redraw requests into one per animation frame
export const frameThrottle = (fn) => {
	let queued = false;
	return () => {
		if (queued) {
			return;
		}
		queued = true;
		requestAnimationFrame(() => {
			queued = false;
			fn();
		});
	};
};

export const axisStyle = () => {
	return {
		stroke: cssVar("--muted"),
		grid: { stroke: cssVar("--grid-line"), width: 1 },
		ticks: { stroke: cssVar("--grid-line"), width: 1 }
	};
};

// size of a pane body minus the uPlot legend
export const plotSize = (body, legend) => {
	return { width: Math.max(50, body.clientWidth), height: Math.max(40, body.clientHeight - (legend ? 28 : 0)) };
};

// latest value of a channel: the live buffer, else the server's last sample
export const liveValue = (ctx, channel) => {
	const v = ctx.store.live[channel];
	if (v !== undefined) {
		return v;
	}
	const ch = ctx.state.channels.find((c) => c.name === channel);
	return ch && ch.latest ? ch.latest.v : undefined;
};

export const channelUnit = (ctx, channel) => {
	const ch = ctx.state.channels.find((c) => c.name === channel);
	return (ch && ch.unit) || "";
};

// "{{channel}}" / "{{channel|digits}}" -> "1.234 mV" (engineering notation)
export const formatPlaceholder = (ctx, name, precision) => {
	const v = liveValue(ctx, name);
	if (typeof v !== "number" || !Number.isFinite(v)) {
		return "—";
	}
	return eng(v, precision) + channelUnit(ctx, name);
};
