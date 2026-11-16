// Lab chat: people (here) and AIs (MCP chat_send / chat_read) in one thread.

import { el, state, when } from "@nemanjan00/qrp";
import { feed, field, pane } from "../sdk/index.js";
import { time } from "./util.js";
import { renderMarkdown } from "./markdown.js";

const savedName = () => {
	try {
		return localStorage.getItem("mailab-name") || "";
	} catch (_err) {
		return "";
	}
};

const message = (m) => {
	// messages never change: render the markdown once
	const text = el("div", { class: "chat-text md" });
	text.innerHTML = renderMarkdown(m.text);
	return el("div", { class: "chat-msg " + m.kind }, el("span", { class: "t" }, time(m.t)), " ", el("b", {}, m.from), text);
};

export default pane((ctx) => {
	const form = state({ name: savedName(), text: "", locked: false, error: "" });

	// with auth on, the server decides who we are
	ctx.api("GET", "/whoami").then((who) => {
		if (who.name !== "local") {
			form.name = who.name;
			form.locked = true;
		}
	}, () => null);

	const send = (event) => {
		event.preventDefault();
		const text = form.text.trim();
		if (!text) {
			return;
		}
		try {
			localStorage.setItem("mailab-name", form.name);
		} catch (_err) {
			// the name just won't be remembered
		}
		form.text = "";
		form.error = "";
		ctx.api("POST", "/chat", { from: form.name || "anonymous", text: text }).catch((err) => {
			form.error = err.message;
		});
	};

	return el("div", { class: "console" },
		feed({
			items: () => ctx.store.chat,
			key: (m) => m.id,
			render: message,
			className: "chat",
			empty: "no messages yet: say hi, AIs read this via chat_read"
		}),
		when(() => form.error, () => el("div", { class: "error" }, () => form.error)),
		el("form", { onsubmit: send },
			field(form, "name", { class: "chat-name", placeholder: "name", size: 8, disabled: () => form.locked }),
			field(form, "text", { class: "chat-input", placeholder: "message (markdown, $math$)" }),
			el("button", {}, "send")));
});
