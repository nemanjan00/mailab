// What the AI did through MCP, newest at the bottom.

import { escapeHtml, time } from "./util.js";

const line = (entry) => {
	let detail = entry.args;
	if (!entry.ok) {
		detail = detail + "  ✗ " + entry.error;
	}
	return "<div class=\"" + (entry.ok ? "" : "fail") + "\"><span class=\"t\">" + time(entry.t) + "</span> "
		+ (entry.who ? "<span class=\"muted\">" + escapeHtml(entry.who) + "</span> " : "")
		+ "<span class=\"tool\">" + escapeHtml(entry.tool) + "</span> " + escapeHtml(detail) + "</div>";
};

export default {
	mount: (body, _initial, ctx) => {
		body.innerHTML = "<div class=\"feed activity\"></div>";
		const feed = body.querySelector(".feed");

		ctx.api("GET", "/activity").then((entries) => {
			if (!entries.length) {
				feed.innerHTML = "<div class=\"muted\">no AI activity yet — connect an MCP client to /mcp</div>";
				return;
			}
			feed.innerHTML = entries.map(line).join("");
			body.scrollTop = body.scrollHeight;
		});

		const off = ctx.on("activity", (msg) => {
			const empty = feed.querySelector(".muted");
			if (empty) {
				empty.remove();
			}
			feed.insertAdjacentHTML("beforeend", line(msg.entry));
			body.scrollTop = body.scrollHeight;
		});

		return { destroy: off };
	}
};
