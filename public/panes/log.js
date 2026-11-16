// Device log / console. With config.device set, the input runs driver
// commands:  name {"json": "args"}

import { escapeHtml, time } from "./util.js";

const MAX_LINES = 1000;

const line = (entry) => {
	return "<div class=\"" + escapeHtml(entry.level) + "\"><span class=\"t\">" + time(entry.t) + " "
		+ escapeHtml(entry.device) + "</span> " + escapeHtml(entry.text) + "</div>";
};

export default {
	mount: (body, initial, ctx) => {
		let pane = initial;
		body.innerHTML = "<div class=\"console\"><div class=\"feed\"></div>"
			+ "<form><input placeholder=\"command {&quot;args&quot;: 1}\"><button>run</button></form></div>";
		const feed = body.querySelector(".feed");
		const form = body.querySelector("form");
		const input = form.querySelector("input");

		const matches = (entry) => !pane.config.device || entry.device === pane.config.device;

		const append = (html) => {
			const stick = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 20;
			feed.insertAdjacentHTML("beforeend", html);
			while (feed.childElementCount > MAX_LINES) {
				feed.firstElementChild.remove();
			}
			if (stick) {
				feed.scrollTop = feed.scrollHeight;
			}
		};

		const load = () => {
			form.style.display = pane.config.device ? "" : "none";
			const query = pane.config.device ? "?device=" + encodeURIComponent(pane.config.device) : "";
			ctx.api("GET", "/logs" + query).then((entries) => {
				feed.innerHTML = entries.map(line).join("");
				feed.scrollTop = feed.scrollHeight;
			});
		};

		form.addEventListener("submit", (event) => {
			event.preventDefault();
			const text = input.value.trim();
			if (!text) {
				return;
			}
			const space = text.indexOf(" ");
			const name = space === -1 ? text : text.slice(0, space);
			let args = {};
			try {
				args = space === -1 ? {} : JSON.parse(text.slice(space + 1));
			} catch (err) {
				append(line({ t: Date.now(), device: "ui", level: "error", text: "args must be JSON: " + err.message }));
				return;
			}
			input.value = "";
			append(line({ t: Date.now(), device: pane.config.device, level: "tx", text: "> " + text }));
			ctx.api("POST", "/devices/" + pane.config.device + "/command", { command: name, args: args })
				.then((result) => {
					append(line({ t: Date.now(), device: pane.config.device, level: "rx", text: JSON.stringify(result, null, 1).slice(0, 4000) }));
				}, (err) => {
					append(line({ t: Date.now(), device: pane.config.device, level: "error", text: err.message }));
				});
		});

		const off = ctx.on("log", (msg) => {
			if (matches(msg.entry)) {
				append(line(msg.entry));
			}
		});
		load();

		return {
			update: (next) => {
				pane = next;
				load();
			},
			destroy: off
		};
	}
};
