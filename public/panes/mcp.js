// MCP connection card: endpoint URL + the tokens an MCP client can use
// (rw-gated: an ro viewer must not be able to escalate by reading the admin
// token). One-click copy per token.

import { el } from "@nemanjan00/qrp";

const copyRow = (label, value, mono) => {
	const input = el("input", { type: "text", readonly: true, value: value, class: mono ? "mono" : "" });
	const btn = el("button", { title: "copy" }, "⧉");
	btn.onclick = () => {
		navigator.clipboard.writeText(value).then(() => {
			btn.textContent = "✓";
			setTimeout(() => {
				btn.textContent = "⧉";
			}, 1200);
		});
	};
	return el("div", { class: "mcp-row" },
		el("span", { class: "k" }, label),
		el("div", { class: "c" }, input, btn));
};

export default {
	mount: (body, initial, ctx) => {
		body.classList.add("mcp-pane");
		const render = (info, err) => {
			body.innerHTML = "";
			if (err) {
				body.append(el("div", { class: "empty" }, err));
				return;
			}
			if (!info) {
				body.append(el("div", { class: "empty" }, "loading…"));
				return;
			}
			body.append(el("h3", {}, "MCP"));
			body.append(copyRow("endpoint", info.url, true));
			const box = el("div", { class: "mcp-tokens" });
			info.tokens.forEach((t) => {
				box.append(copyRow(t.name + " (" + t.role + ")", t.token, true));
			});
			body.append(box);
			body.append(el("p", { class: "muted" },
				"Use the endpoint with Authorization: Bearer <token>. rw tokens are for AIs; ro for watch-only clients."));
		};
		ctx.api("GET", "/mcp/info").then((info) => render(info), (err) => render(null, err.message || String(err)));
		return { update: () => {}, destroy: () => {} };
	}
};
