#!/usr/bin/env node
// Claude Code channel for the mailab chat: a stdio MCP server that follows the
// lab chat over WebSocket and pushes each message into the Claude Code
// session as a <channel source="mailab"> event; `chat_send` replies.
//
// Claude Code delivers channel pushes over stdio only, so this bridge
// complements the HTTP MCP endpoint (which has the lab tools).
//
//   .mcp.json: {"mcpServers": {"mailab-chat": {"command": "node", "args": ["bin/channel.js"],
//               "env": {"MAILAB_URL": "http://127.0.0.1:3000", "MAILAB_NAME": "claude"}}}}
//   claude --dangerously-load-development-channels server:mailab-chat
//
// Started by Claude Code, not by forever: it lives as long as the session.

const Server = require("@modelcontextprotocol/sdk/server/index.js").Server;
const StdioServerTransport = require("@modelcontextprotocol/sdk/server/stdio.js").StdioServerTransport;
const types = require("@modelcontextprotocol/sdk/types.js");
const WsClient = require("ws");
const pkg = require("../package.json");

const URL_BASE = process.env.MAILAB_URL || "http://127.0.0.1:3000";
const NAME = process.env.MAILAB_NAME || "claude";
const TOKEN = process.env.MAILAB_TOKEN || "";
const RECONNECT_MS = 2000;

const headers = () => {
	const out = { "content-type": "application/json" };
	if (TOKEN) {
		out.authorization = "Bearer " + TOKEN;
	}
	return out;
};

const server = new Server({ name: "mailab-chat", version: pkg.version }, {
	capabilities: {
		experimental: { "claude/channel": {} },
		tools: {}
	},
	instructions: "Messages from the mailab lab chat (people at the bench and other AIs) arrive as <channel source=\"mailab\" from=\"...\">. "
		+ "Reply with the chat_send tool when a message is addressed to you or asks a question; use the mailab MCP tools to act on the lab."
});

server.setRequestHandler(types.ListToolsRequestSchema, () => {
	return Promise.resolve({
		tools: [{
			name: "chat_send",
			description: "Post a message to the mailab lab chat",
			inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }
		}]
	});
});

server.setRequestHandler(types.CallToolRequestSchema, (request) => {
	if (request.params.name !== "chat_send") {
		return Promise.reject(new Error("unknown tool: " + request.params.name));
	}
	return fetch(URL_BASE + "/api/chat", {
		method: "POST",
		headers: headers(),
		body: JSON.stringify({ from: NAME, kind: "ai", text: request.params.arguments.text })
	}).then((res) => {
		return res.json().then((json) => {
			if (!res.ok) {
				throw new Error(json.error || res.statusText);
			}
			return { content: [{ type: "text", text: "sent (#" + json.id + ")" }] };
		});
	});
});

const follow = () => {
	const wsUrl = URL_BASE.replace(/^http/, "ws") + "/ws";
	const socket = new WsClient(wsUrl, { headers: headers() });
	socket.on("message", (raw) => {
		const msg = JSON.parse(raw);
		if (msg.type !== "chat" || msg.message.from === NAME) {
			return;
		}
		const m = msg.message;
		server.notification({
			method: "notifications/claude/channel",
			params: { content: m.text, meta: { from: m.from, kind: m.kind, id: String(m.id) } }
		}).catch(() => {
			return null;
		});
	});
	socket.on("close", () => {
		setTimeout(follow, RECONNECT_MS);
	});
	socket.on("error", () => {
		// close follows; reconnect there
	});
};

server.connect(new StdioServerTransport()).then(follow);
