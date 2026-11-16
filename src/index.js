// mailab web entry point: lab + web UI + MCP endpoint on one port.

const config = require("./config");
const labModule = require("./lab");
const web = require("./web");

const lab = labModule.create({
	dataDir: config.get("DATA_DIR"),
	channelCapacity: config.getNumber("CHANNEL_CAPACITY")
});

const server = web.create(lab, { pushIntervalMs: config.getNumber("PUSH_INTERVAL_MS") }).server;

const shutdown = () => {
	lab.shutdown().then(() => {
		process.exit(0);
	}, () => {
		process.exit(1);
	});
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

lab.restore()
	.then(() => {
		server.listen(config.getNumber("PORT"), config.get("HOST"), () => {
			const url = "http://" + config.get("HOST") + ":" + config.get("PORT");
			console.log("mailab on " + url + " (MCP: " + url + "/mcp)");
		});
	})
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
