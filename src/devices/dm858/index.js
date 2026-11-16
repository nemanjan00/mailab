// Rigol DM858/DM858E bench multimeter (SCPI). Polls READ? into channel "value"
// and tracks the unit of the active function.

const scpiDriver = require("../scpi");

const UNITS = {
	VOLT: "V",
	"VOLT:AC": "V AC",
	CURR: "A",
	"CURR:AC": "A AC",
	RES: "Ω",
	FRES: "Ω",
	FREQ: "Hz",
	PER: "s",
	CAP: "F",
	TEMP: "°C",
	DIOD: "V",
	CONT: "Ω"
};

// CONFigure? -> "VOLT +1.000000E+01,+3.000000E-06" (quotes optional)
const parseFunction = (reply) => {
	return reply.replace(/"/g, "").trim().split(/\s+/)[0].toUpperCase();
};

module.exports = scpiDriver.preset({
	name: "dm858",
	description: "Rigol DM858/DM858E multimeter (SCPI). Channel: value",
	poll: [{ field: "value", query: "READ?" }],
	commandDocs: {
		configure: "{function: VOLT:DC|VOLT:AC|CURR:DC|CURR:AC|RES|FRES|FREQ|CAP|TEMP|DIOD|CONT, range} switch function",
		function: "current function and unit"
	},
	commands: (client, io) => {
		const readFunction = () => {
			return client.query("CONFigure?").then((reply) => {
				const fn = parseFunction(reply);
				const unit = UNITS[fn] || "";
				// TODO: unit is only refreshed on configure/function; front-panel
				// changes are not tracked
				io.meta("value", { unit: unit });
				return { function: fn, unit: unit, raw: reply };
			});
		};
		setTimeout(() => {
			readFunction().catch(() => {
				return null;
			});
		}, 0);
		return {
			function: readFunction,
			configure: (args) => {
				let command = "CONFigure:" + args.function;
				if (args.range !== undefined) {
					command = command + " " + args.range;
				}
				return client.write(command).then(readFunction);
			}
		};
	}
});
