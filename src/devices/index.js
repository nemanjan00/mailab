// Driver registry. Each driver: {name, description, options, commands, create(options, io)}
// where create returns {start(), stop(), command(name, args)}, all promise-based.

const DRIVERS = [
	require("./sim"),
	require("./serial"),
	require("./uart"),
	require("./process"),
	require("./scpi"),
	require("./dm858"),
	require("./mho900"),
	require("./mdp"),
	require("./mp305"),
	require("./sigrok"),
	require("./kc9531b"),
	require("./civ"),
	require("./tinysa"),
	require("./litevna"),
	require("./hackrf"),
	require("./soapy"),
	require("./rfcat"),
	require("./proxmark3"),
	require("./picoglitcher"),
	require("./flowgraph"),
	require("./camera"),
	require("./browser"),
	require("./harogic"),
	require("./replay"),
	require("./sysmon"),
	require("./rtl_power"),
	require("./flashrom"),
	require("./minipro"),
	require("./cynthion"),
	require("./vnc"),
	require("./nanokvm")
];

const devices = {
	list: () => {
		return DRIVERS.map((driver) => {
			return {
				name: driver.name,
				description: driver.description,
				options: driver.options,
				commands: driver.commands
			};
		});
	},

	listMap: () => {
		const map = {};
		DRIVERS.forEach((driver) => {
			map[driver.name] = driver;
		});
		return map;
	},

	get: (name) => {
		const driver = devices.listMap()[name];
		if (!driver) {
			throw new Error("unknown driver: " + name + " (available: " + DRIVERS.map((d) => {
				return d.name;
			}).join(", ") + ")");
		}
		return driver;
	}
};

module.exports = devices;
