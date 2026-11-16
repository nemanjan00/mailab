// Lab chat: people (here) and AIs (MCP chat_send / chat_read) in one thread.

import { escapeHtml, time } from "./util.js";
import { renderMarkdown } from "./markdown.js";

const line = (m) => {
	return "<div class=\"chat-msg " + escapeHtml(m.kind) + "\"><span class=\"t\">" + time(m.t) + "</span> "
		+ "<b>" + escapeHtml(m.from) + "</b><div class=\"chat-text md\">" + renderMarkdown(m.text) + "</div></div>";
};

const storedName = () => {
	try {
		return localStorage.getItem("mailab-name") || "";
	} catch (_err) {
		return "";
	}
};

export default {
	mount: (body, _initial, ctx) => {
		body.innerHTML = "<div class=\"console\"><div class=\"feed chat\"></div>"
			+ "<form><input class=\"chat-name\" placeholder=\"name\" size=\"8\"><input class=\"chat-input\" placeholder=\"message (markdown, $math$)\"><button>send</button></form></div>";
		const feed = body.querySelector(".feed");
		const form = body.querySelector("form");
		const nameInput = body.querySelector(".chat-name");
		const input = body.querySelector(".chat-input");
		nameInput.value = storedName();

		// with auth on, the server knows who we are
		ctx.api("GET", "/whoami").then((who) => {
			if (who.name !== "local") {
				nameInput.value = who.name;
				nameInput.disabled = true;
			}
		}, () => null);

		const scroll = () => {
			feed.scrollTop = feed.scrollHeight;
		};

		ctx.api("GET", "/chat").then((messages) => {
			feed.innerHTML = messages.map(line).join("") || "<div class=\"muted\">no messages yet: say hi, AIs read this via chat_read</div>";
			scroll();
		});

		form.addEventListener("submit", (event) => {
			event.preventDefault();
			const text = input.value.trim();
			if (!text) {
				return;
			}
			try {
				localStorage.setItem("mailab-name", nameInput.value);
			} catch (_err) {
				// name just won't be remembered
			}
			input.value = "";
			ctx.api("POST", "/chat", { from: nameInput.value || "anonymous", text: text }).catch((err) => {
				feed.insertAdjacentHTML("beforeend", "<div class=\"error\">" + escapeHtml(err.message) + "</div>");
			});
		});

		const off = ctx.on("chat", (msg) => {
			const empty = feed.querySelector(".muted");
			if (empty) {
				empty.remove();
			}
			feed.insertAdjacentHTML("beforeend", line(msg.message));
			scroll();
		});

		return { destroy: off };
	}
};
