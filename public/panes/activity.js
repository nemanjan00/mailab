// What the AIs did through MCP (who, tool, args), newest at the bottom.

import { el } from "@nemanjan00/qrp";
import { feed, pane } from "../sdk/index.js";
import { time } from "./util.js";

const entry = (e) => el("div", { class: e.ok ? "" : "fail" },
	el("span", { class: "t" }, time(e.t)), " ",
	e.who ? el("span", { class: "muted" }, e.who + " ") : "",
	el("span", { class: "tool" }, e.tool), " ",
	e.ok ? e.args : e.args + "  ✗ " + e.error);

export default pane((ctx) => feed({
	items: () => ctx.store.activity,
	key: (e) => e.id,
	render: entry,
	className: "activity",
	empty: "no AI activity yet — connect an MCP client to /mcp"
}));
