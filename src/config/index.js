// Runtime configuration from the environment, with defaults.

const fs = require("fs");
const path = require("path");
const os = require("os");

const DEFAULTS = {
	PORT: "3000",
	HOST: "127.0.0.1",
	DATA_DIR: path.join(__dirname, "..", "..", "data"),
	// samples kept per channel (ring buffer)
	CHANNEL_CAPACITY: "200000",
	// how often batched samples are pushed to web clients
	PUSH_INTERVAL_MS: "50",
	MDP_HOST_PATH: path.join(os.homedir(), "mdp-p906", "host"),
	SIGROK_CLI: "sigrok-cli",
	PYTHON: "python3",
	// RRG/Iceman client: a source checkout's build (e.g. ~/pm5-og, the PM5
	// tree) when there is one, else `proxmark3` from PATH
	PM3_CLIENT: [path.join(os.homedir(), "pm5-og", "client", "proxmark3"), path.join(os.homedir(), "proxmark3", "client", "proxmark3")]
		.find((file) => fs.existsSync(file)) || "proxmark3",
	CIV_PATH: path.join(os.homedir(), "ci-v"),
	// "name:token[:rw|ro],..." enables auth for collaboration (empty = open)
	MAILAB_TOKENS: "",
	// accept a non-loopback HOST without tokens (trusted networks only)
	MAILAB_ALLOW_OPEN: "",
	// extra Host names accepted without tokens, e.g. "lab.local"
	MAILAB_ALLOWED_HOSTS: "",
	// 0 = don't manage a python venv (use PYTHON as is)
	MAILAB_MANAGE_PYTHON: "1",
	// extra directories media tools and flowgraph file blocks may read/write (":"-separated); DATA_DIR/media always
	MAILAB_MEDIA_DIRS: "",
	// download caps for FCC exhibits / datasheet PDFs (bytes)
	FCCID_MAX_BYTES: String(30 * 1024 * 1024),
	DATASHEET_MAX_BYTES: String(50 * 1024 * 1024),
	// optional datasheet providers, disabled while unset
	MOUSER_API_KEY: "",
	NEXAR_CLIENT_ID: "",
	NEXAR_CLIENT_SECRET: "",
	DIGIKEY_CLIENT_ID: "",
	DIGIKEY_CLIENT_SECRET: "",
	// a SearXNG instance (JSON format enabled) for keyless web search
	SEARXNG_URL: "",
	// web lookups (datasheets, FCC ID) only reach public addresses; local mirrors allowed here: "host,10.0.5.0/24"
	MAILAB_HTTP_ALLOW: ""
};

// a DATA_DIR with control characters (e.g. ANSI colour codes from a
// coloured `ls`) becomes a junk relative directory: refuse it early
const checkPath = (key, value) => {
	const control = String(value).split("").some((c) => c.charCodeAt(0) < 32);
	if (/DIR$/.test(key) && control) {
		throw new Error(key + " contains control characters: " + JSON.stringify(value));
	}
	return value;
};

const config = {
	get: (key) => {
		if (process.env[key] !== undefined) {
			return checkPath(key, process.env[key]);
		}
		return DEFAULTS[key];
	},

	getNumber: (key) => {
		return Number(config.get(key));
	}
};

module.exports = config;
