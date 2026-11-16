// Device list with status and start/stop/remove/console actions.

import { escapeHtml } from "./util.js";

export default {
	mount: (body, _initial, ctx) => {
		const render = () => {
			const list = ctx.state.devices;
			if (!list.length) {
				body.innerHTML = "<div class=\"empty\">no devices — use “+ device”, or let the AI add some</div>";
				return;
			}
			body.innerHTML = "<table><thead><tr><th>id</th><th>driver</th><th>state</th><th></th></tr></thead><tbody>"
				+ list.map((d) => {
					const running = d.state === "running" || d.state === "starting";
					return "<tr data-id=\"" + escapeHtml(d.id) + "\"><td class=\"mono\">" + escapeHtml(d.id) + "</td>"
						+ "<td>" + escapeHtml(d.driver) + "</td>"
						+ "<td><span class=\"state " + escapeHtml(d.state) + "\" title=\"" + escapeHtml(d.detail) + "\">" + escapeHtml(d.state) + "</span></td>"
						+ "<td>"
						+ "<button class=\"icon\" data-act=\"" + (running ? "stop" : "start") + "\" title=\"" + (running ? "stop" : "start") + "\">" + (running ? "■" : "▶") + "</button>"
						+ "<button class=\"icon\" data-act=\"console\" title=\"open console\">⌨</button>"
						+ "<button class=\"icon\" data-act=\"remove\" title=\"remove\">×</button>"
						+ "</td></tr>";
				}).join("") + "</tbody></table>";
		};

		body.addEventListener("click", (event) => {
			const button = event.target.closest("button[data-act]");
			if (!button) {
				return;
			}
			const id = button.closest("tr").dataset.id;
			const act = button.dataset.act;
			if (act === "start" || act === "stop") {
				ctx.api("POST", "/devices/" + id + "/" + act);
			} else if (act === "remove") {
				if (confirm("Remove device " + id + "?")) {
					ctx.api("DELETE", "/devices/" + id);
				}
			} else if (act === "console") {
				ctx.api("POST", "/panes", { type: "log", title: id + " console", config: { device: id } });
			}
		});

		const off = ctx.on("state", render);
		render();
		return { destroy: off };
	}
};
