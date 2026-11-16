// Rigol MHO900 oscilloscope (SCPI): waveform capture -> trace, measurements,
// screenshots -> image (also returned to the AI).

const scpiDriver = require("../scpi");

// :WAV:PRE? -> format,type,points,count,xinc,xorigin,xref,yinc,yorigin,yref
const parsePreamble = (reply) => {
	const f = reply.split(",").map(Number);
	return {
		points: f[2],
		xincrement: f[4],
		xorigin: f[5],
		xreference: f[6],
		yincrement: f[7],
		yorigin: f[8],
		yreference: f[9]
	};
};

module.exports = scpiDriver.preset({
	name: "mho900",
	description: "Rigol MHO900 oscilloscope (SCPI): capture -> trace, measure, screenshot",
	commandDocs: {
		capture: "{sources: [\"CHAN1\", \"CHAN2\"], name} screen waveform -> trace (x = seconds)",
		measure: "{item: VPP|VMAX|VMIN|VAVG|VRMS|FREQ|PER|RTIM|FTIM|PDUT, source: CHAN1}",
		screenshot: "PNG of the screen (shown in image pane \"<device>_screen\" and returned)",
		run: "", stop: "", single: "", autoscale: ""
	},
	commands: (client, io) => {
		const waveform = (source) => {
			return client.write(":WAV:SOUR " + source)
				.then(() => {
					return client.write(":WAV:MODE NORM");
				})
				.then(() => {
					return client.write(":WAV:FORM BYTE");
				})
				.then(() => {
					return client.query(":WAV:PRE?");
				})
				.then((reply) => {
					const pre = parsePreamble(reply);
					return client.queryBinary(":WAV:DATA?").then((data) => {
						// TODO: verify BYTE scaling on MHO900 (12-bit ADC; WORD may be better)
						const y = Array.from(data).map((b) => {
							return (b - pre.yorigin - pre.yreference) * pre.yincrement;
						});
						const x = y.map((_, i) => {
							return (i - pre.xreference) * pre.xincrement + pre.xorigin;
						});
						return { source: source, x: x, y: y, pre: pre };
					});
				});
		};

		const simple = (command) => {
			return () => {
				return client.write(command).then(() => {
					return { ok: true };
				});
			};
		};

		return {
			capture: (args) => {
				const sources = args.sources || ["CHAN1"];
				return sources.reduce((chain, source) => {
					return chain.then((acc) => {
						return waveform(source).then((wave) => {
							return acc.concat([wave]);
						});
					});
				}, Promise.resolve([])).then((waves) => {
					const name = args.name || "scope";
					io.trace(name, {
						x: waves[0].x,
						xUnit: "s",
						yUnit: "V",
						series: waves.map((wave) => {
							return { label: wave.source, y: wave.y };
						})
					});
					return {
						trace: name,
						points: waves[0].x.length,
						sources: sources,
						xincrement: waves[0].pre.xincrement
					};
				});
			},
			measure: (args) => {
				return client.query(":MEASure:ITEM? " + args.item + "," + (args.source || "CHAN1")).then((reply) => {
					return { item: args.item, source: args.source || "CHAN1", value: Number(reply) };
				});
			},
			screenshot: () => {
				return client.queryBinary(":DISPlay:DATA? PNG").then((png) => {
					io.image("screen", png, "image/png");
					return { _image: { data: png.toString("base64"), mime: "image/png" } };
				});
			},
			run: simple(":RUN"),
			stop: simple(":STOP"),
			single: simple(":SINGle"),
			autoscale: simple(":AUToscale")
		};
	}
});
