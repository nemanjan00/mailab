// Runtime configuration from the environment, with defaults.

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
	PM3_CLIENT: "proxmark3",
	CIV_PATH: path.join(os.homedir(), "ci-v"),
	// "name:token[:rw|ro],..." enables auth for collaboration (empty = open)
	MAILAB_TOKENS: ""
};

const config = {
	get: (key) => {
		if (process.env[key] !== undefined) {
			return process.env[key];
		}
		return DEFAULTS[key];
	},

	getNumber: (key) => {
		return Number(config.get(key));
	}
};

module.exports = config;
