// Shared PTY sessions (bash, gdb, openocd, serial consoles, one-off commands)
// as a lab device. Both the person and the AI drive the same sessions: the
// terminal pane attaches to any of them (raw xterm.js keystrokes, full-screen
// TUIs work) while the AI uses write / the rx log / scrollback.
//
// No native deps: the child runs under a real PTY via util-linux `script
// -qfc <cmd> /dev/null` (pipes on our side, pty on the child's side). Pass
// pty:false for a plain pipe child (no echo, no CRLF translation).
//
// Every session gets:
//   - raw bytes -> io.term (terminal pane, per-session scrollback)
//   - ANSI-stripped lines -> the lab log as "rx" (classifier, notifications)
//   - a notification on start / exit

const { spawn } = require("child_process");

const MAX_SESSIONS = 8;
const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const LOG_LINES_PER_CHUNK = 5;
const EXITED_KEEP_MS = 5000;

// CSI / OSC escape sequences from colored consoles (built from char codes:
// no-control-regex forbids literal ESC / BEL in patterns)
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CSI = new RegExp(ESC + "\\[[0-9;?]*[ -/]*[@-~]", "g");
const OSC = new RegExp(ESC + "\\][^" + BEL + "]*(" + BEL + "|" + ESC + "\\\\)", "g");
const stripAnsi = (text) => text.replace(CSI, "").replace(OSC, "");

/**
 * Split incoming text into complete lines; returns {lines, rest}.
 */
const splitLines = (text) => {
	const parts = text.split(/\r\n|\n|\r/);
	return { lines: parts.slice(0, -1), rest: parts[parts.length - 1] };
};

const create = (options, io) => {
	const sessions = new Map();
	let counter = 0;
	let stopping = false;

	const summary = () => {
		const list = Array.from(sessions.values());
		const running = list.filter((s) => s.running).length;
		return running + (running === 1 ? " session" : " sessions");
	};

	const publish = () => {
		io.status("running", summary());
	};

	const forgetTimer = (session) => {
		if (session.goneTimer) {
			clearTimeout(session.goneTimer);
			session.goneTimer = null;
		}
	};

	const ended = (session, reason, code) => {
		if (!session.running) {
			return;
		}
		session.running = false;
		forgetTimer(session);
		// prompts never end in a newline
		if (session.pending) {
			const line = stripAnsi(session.pending);
			session.pending = "";
			if (line.trim()) {
				io.log("[" + session.name + "] " + line, "rx");
			}
		}
		io.log("[" + session.name + "] exited (" + reason + (code === undefined ? "" : " " + code) + ")", "info");
		io.notify({ type: "shell", event: "exit", session: session.name, reason: reason, code: code });
		if (stopping) {
			sessions.delete(session.name);
		} else {
			// keep the session (and its scrollback) visible for a moment
			session.goneTimer = setTimeout(() => {
				sessions.delete(session.name);
				publish();
			}, EXITED_KEEP_MS);
			session.goneTimer.unref();
		}
		publish();
	};

	const onData = (session, data) => {
		if (!session.running) {
			return;
		}
		io.term(data, session.name);
		const split = splitLines(session.pending + data.toString("latin1"));
		session.pending = split.rest;
		if (split.lines.length > LOG_LINES_PER_CHUNK) {
			split.lines.slice(0, LOG_LINES_PER_CHUNK).forEach((line) => {
				const clean = stripAnsi(line);
				if (clean.trim()) {
					io.log("[" + session.name + "] " + clean, "rx");
				}
			});
			io.log("[" + session.name + "] … " + (split.lines.length - LOG_LINES_PER_CHUNK) + " more lines …", "info");
		} else {
			split.lines.forEach((line) => {
				const clean = stripAnsi(line);
				if (clean.trim()) {
					io.log("[" + session.name + "] " + clean, "rx");
				}
			});
		}
	};

	const lookup = (name) => {
		const session = sessions.get(String(name || ""));
		if (!session) {
			throw new Error("no session \"" + name + "\" (session_list to see them)");
		}
		return session;
	};

	// one session when unambiguous, otherwise the arg is required
	const resolve = (args) => {
		if (args.session) {
			return lookup(args.session);
		}
		if (sessions.size === 1) {
			return Array.from(sessions.values())[0];
		}
		throw new Error("which session? pass {session} (session_list to see them)");
	};

	const commands = {
		session_start: (args) => {
			const cmd = String(args.cmd || "").trim();
			if (!cmd) {
				throw new Error("session_start needs {cmd}, e.g. \"bash\", \"gdb firmware.elf\", \"openocd -f board.cfg\"");
			}
			if (sessions.size >= MAX_SESSIONS) {
				throw new Error("session cap " + MAX_SESSIONS + " reached (kill one first)");
			}
			const name = args.name ? String(args.name) : "s" + (++counter);
			if (!NAME_RE.test(name)) {
				throw new Error("session name must match " + NAME_RE);
			}
			if (sessions.has(name)) {
				throw new Error("session \"" + name + "\" already exists");
			}
			const usePty = args.pty !== false;
			// util-linux script: -q quiet, -f flush, -c command; the transcript
			// goes to /dev/null (the lab keeps its own scrollback)
			const child = usePty
				? spawn("script", ["-qfc", cmd, "/dev/null"], { stdio: ["pipe", "pipe", "pipe"] })
				: spawn("bash", ["-c", cmd], { stdio: ["pipe", "pipe", "pipe"] });
			const session = { name: name, cmd: cmd, pid: child.pid, pty: usePty, running: true, pending: "", child: child, goneTimer: null };
			sessions.set(name, session);
			child.stdout.on("data", (data) => onData(session, data));
			child.stderr.on("data", (data) => onData(session, data));
			child.on("error", (err) => {
				sessions.delete(name);
				publish();
				io.log("[" + name + "] spawn failed: " + err.message, "error");
			});
			child.on("exit", (code, signal) => {
				ended(session, signal ? "signal " + signal : "code", code === null ? undefined : code);
			});
			io.log("[" + name + "] $ " + cmd + " (pid " + child.pid + (usePty ? ", pty" : ", pipes") + ")", "info");
			io.notify({ type: "shell", event: "start", session: name, cmd: cmd, pid: child.pid });
			publish();
			return { ok: true, name: name, pid: child.pid, pty: usePty };
		},

		session_list: () => ({
			sessions: Array.from(sessions.values()).map((s) => ({
				name: s.name, cmd: s.cmd, pid: s.pid, pty: s.pty, running: s.running
			}))
		}),

		session_kill: (args) => {
			const session = lookup(args.session);
			if (session.running) {
				session.child.kill("SIGTERM");
			}
			return { ok: true, name: session.name };
		},

		// keystrokes from a web terminal: sent as is, not logged per key
		write_raw: (args) => {
			const session = resolve(args);
			const buf = Buffer.from(String(args.data || ""), "base64");
			if (!session.running) {
				throw new Error("session \"" + session.name + "\" has exited");
			}
			session.child.stdin.write(buf);
			return { ok: true, bytes: buf.length };
		},

		write: (args) => {
			const session = resolve(args);
			if (!session.running) {
				throw new Error("session \"" + session.name + "\" has exited");
			}
			const text = args.text === undefined ? "" : String(args.text);
			const eol = args.eol === undefined ? "\n" : String(args.eol);
			io.log("[" + session.name + "] > " + text, "tx");
			session.child.stdin.write(text + eol);
			return { ok: true };
		},

		// resize the pty window; reaches whatever has the tty foreground
		session_resize: (args) => {
			const session = resolve(args);
			const cols = Math.max(1, Math.min(512, Number(args.cols) || 80));
			const rows = Math.max(1, Math.min(256, Number(args.rows) || 24));
			if (!session.pty) {
				throw new Error("session \"" + session.name + "\" is not a pty session");
			}
			if (session.running) {
				session.child.stdin.write("stty cols " + cols + " rows " + rows + "\n");
			}
			return { ok: true, cols: cols, rows: rows };
		},

		status: () => Object.assign({
			path: "shell",
			connected: true,
			display: "text",
			sessions: Array.from(sessions.values()).map((s) => ({
				name: s.name, cmd: s.cmd, pid: s.pid, pty: s.pty, running: s.running
			}))
		})
	};

	return {
		start: () => {
			stopping = false;
			publish();
			return Promise.resolve();
		},
		stop: () => {
			stopping = true;
			Array.from(sessions.values()).forEach((session) => {
				forgetTimer(session);
				if (session.running) {
					session.child.kill("SIGTERM");
				}
			});
			sessions.clear();
			return Promise.resolve();
		},
		command: (name, args) => {
			if (!commands[name]) {
				throw new Error("unknown command \"" + name + "\"");
			}
			return commands[name](args || {});
		}
	};
};

module.exports = {
	name: "shell",
	description: "shared PTY sessions (bash, gdb, openocd, serial consoles, one-off commands) both the person and the AI can drive: terminal pane per session, output to the log and the notification stream",
	options: {},
	commands: {
		session_start: "{cmd, name?, pty?} start a session (pty via `script` unless pty:false); auto-named s1, s2, ...",
		session_list: "{} running and recently-exited sessions",
		session_kill: "{session} SIGTERM it",
		write: "{session?, text, eol?} send a line (logged as tx; session optional when only one)",
		write_raw: "{session?, data} base64 keystrokes as typed (terminal pane; not logged)",
		session_resize: "{session?, cols, rows} pty window size (reaches the tty foreground)",
		status: "{} sessions with pid / pty / running"
	},
	create: create,
	_test: { stripAnsi: stripAnsi, splitLines: splitLines }
};
