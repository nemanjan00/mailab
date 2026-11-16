// Device list with status and start/stop/console/remove actions.

import { el } from "@nemanjan00/qrp";
import { iconButton, pane, table } from "../sdk/index.js";

const isRunning = (d) => d.state === "running" || d.state === "starting";

export default pane((ctx) => table({
	rows: () => ctx.state.devices,
	key: (d) => d.id,
	name: "devices",
	empty: "no devices — use “+ device”, or let the AI add some",
	columns: [
		{ title: "id", mono: true, value: (d) => d.id },
		{ title: "driver", value: (d) => d.driver },
		{ title: "state", raw: (d) => d.state, value: (d) => el("span", { class: "state " + d.state, title: d.detail }, d.state) },
		{
			value: (d) => [
				iconButton(isRunning(d) ? "■" : "▶", isRunning(d) ? "stop" : "start",
					() => ctx.api("POST", "/devices/" + d.id + "/" + (isRunning(d) ? "stop" : "start"))),
				iconButton("⌨", "open console",
					() => ctx.api("POST", "/panes", { type: "log", title: d.id + " console", config: { device: d.id } })),
				iconButton("×", "remove", () => {
					if (confirm("Remove device " + d.id + "?")) {
						ctx.api("DELETE", "/devices/" + d.id);
					}
				})
			]
		}
	]
}));
