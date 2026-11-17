// ThunderScope (open-source 4-ch 1 GS/s scope) via TS.NET: SCPI control
// plane + the binary waveform data plane, as implemented by
// libscopehal's ThunderScopeOscilloscope (SCPITwinLanTransport) and
// TS.NET's ScpiServer.
//
// Control plane: plain SCPI over TCP. Data plane: a second TCP socket
// streaming, per waveform (all little-endian):
//   u8 version, u32 seq, u16 numChannels, u64 fs_per_sample,
//   i64 trigger_fs, f64 wfms_s, then per channel:
//   u8 chnum, u32 memdepth, [analog: f32 scale, f32 offset, f32 trigphase,
//   u8 clipping, u8 dataType (2=i8, 4=i16), then memdepth samples]
// The client acks each waveform by sending the 4-byte seq on the CONTROL
// socket, and requests credit-based flow control by sending 'C' there.
// Hardware-untested: derived from libscopehal sources [HW].

const net = require("net");

// buffered exact-length reads on a raw socket
const createReader = (socket) => {
	let buf = Buffer.alloc(0);
	const waiters = [];
	socket.on("data", (d) => {
		buf = Buffer.concat([buf, d]);
		while (waiters.length && buf.length >= waiters[0].n) {
			const w = waiters.shift();
			const out = buf.slice(0, w.n);
			buf = buf.slice(w.n);
			w.resolve(out);
		}
	});
	socket.on("error", (err) => {
		waiters.splice(0).forEach((w) => w.reject(err));
	});
	return (n) => {
		if (buf.length >= n) {
			const out = buf.slice(0, n);
			buf = buf.slice(n);
			return Promise.resolve(out);
		}
		return new Promise((resolve, reject) => waiters.push({ n: n, resolve: resolve, reject: reject }));
	};
};

const create = (options, io) => {
	const settings = {
		host: options.host || "127.0.0.1",
		port: Number(options.port) || 5025,
		dataPort: Number(options.dataPort) || 5026
	};
	let ctrlSock = null;
	let ctrlRead = null;
	let dataSock = null;
	let read = null;
	let chain = Promise.resolve();
	const exclusive = (fn) => {
		const job = chain.then(fn);
		chain = job.catch(() => null);
		return job;
	};
	let seq = 0;

	const connectSocket = (port) => {
		return new Promise((resolve, reject) => {
			const s = net.connect(port, settings.host, () => resolve(s));
			s.on("error", reject);
		});
	};

	const connect = () => {
		return connectSocket(settings.port).then((s) => {
			ctrlSock = s;
			ctrlRead = createReader(s);
			io.log("control plane connected " + settings.host + ":" + settings.port, "info");
			// credit-based flow control mode, raw 'C' (libscopehal SendRawData)
			ctrlSock.write(Buffer.from("C"));
			return connectSocket(settings.dataPort);
		}).then((s) => {
			dataSock = s;
			read = createReader(s);
			io.log("data plane connected " + settings.host + ":" + settings.dataPort, "info");
		});
	};

	// SCPI on the raw control socket: "CMD\n" out, one line back
	const scpiQuery = (cmd) => {
		ctrlSock.write(Buffer.from(cmd + "\n", "latin1"));
		let buf = Buffer.alloc(0);
		const collect = () => {
			return ctrlRead(1).then((b) => {
				if (b[0] === 0x0a) {
					return buf.toString("latin1").trim();
				}
				buf = Buffer.concat([buf, b]);
				return collect();
			});
		};
		return collect();
	};

	// read one waveform frame from the data plane -> {header, channels:[{...}]}
	const readWaveform = () => {
		const rd = read;
		return rd(1).then((b) => {
			const version = b[0];
			return rd(4).then((b2) => {
				const wseq = b2.readUInt32LE(0);
				return rd(2).then((b3) => {
					const numChannels = b3.readUInt16LE(0);
					return rd(8).then((b4) => {
						const fsPerSample = b4.readBigUInt64LE(0);
						return rd(8).then((b5) => {
							const triggerFs = b5.readBigInt64LE(0);
							return rd(8).then((b6) => {
								const wfms = b6.readDoubleLE(0);
								const chans = [];
								const readChan = (i) => {
									if (i >= numChannels) {
										return chans;
									}
									return rd(1).then((cn) => {
										return rd(4).then((md) => {
											const chnum = cn[0];
											const memdepth = md.readUInt32LE(0);
											const meta = { chnum: chnum, memdepth: memdepth };
											if (chnum < 4) {
												return rd(12).then((cfg) => {
													meta.scale = cfg.readFloatLE(0);
													meta.offset = cfg.readFloatLE(4);
													meta.trigphase = cfg.readFloatLE(8);
													return rd(1).then((cl) => {
														meta.clipping = cl[0] === 1;
														return rd(1).then((dt) => {
															meta.dataType = dt[0];
															const bytes = meta.dataType === 4 ? memdepth * 2 : memdepth;
															return rd(bytes).then((raw) => {
																meta.raw = raw;
																chans.push(meta);
																return readChan(i + 1);
															});
														});
													});
												});
											}
											chans.push(meta);
											return readChan(i + 1);
										});
									});
								};
								return readChan(0).then((channels) => {
									return { version: version, seq: wseq, fsPerSample: fsPerSample, triggerFs: triggerFs, wfms: wfms, channels: channels };
								});
							});
						});
					});
				});
			});
		}).then((wf) => {
			// ack the waveform: 4-byte seq on the control plane
			const ack = Buffer.alloc(4);
			ack.writeUInt32LE(wf.seq, 0);
			seq = wf.seq;
			ctrlSock.write(ack);
			return wf;
		});
	};

	const toSeries = (wf) => {
		const dt = Number(wf.fsPerSample) / 1e15; // fs -> seconds
		const trig = Number(wf.triggerFs) / 1e15;
		return wf.channels.filter((c) => c.raw).map((c) => {
			const n = c.memdepth;
			const y = new Array(n);
			if (c.dataType === 4) {
				for (let i = 0; i < n; i++) {
					y[i] = c.raw.readInt16LE(i * 2) * c.scale + c.offset;
				}
			} else {
				for (let i = 0; i < n; i++) {
					y[i] = c.raw.readInt8(i) * c.scale + c.offset;
				}
			}
			const x = new Array(n);
			for (let i = 0; i < n; i++) {
				x[i] = i * dt - trig;
			}
			return { label: "CHAN" + (c.chnum + 1), x: x, y: y };
		});
	};

	const commands = {
		query: (args) => exclusive(() => scpiQuery(args.command).then((reply) => ({ reply: reply }))),
		write: (args) => exclusive(() => {
			ctrlSock.write(Buffer.from(args.command + "\n", "latin1"));
			return Promise.resolve({ ok: true });
		}),

		run: () => exclusive(() => {
			ctrlSock.write(Buffer.from("NORMAL\n", "latin1"));
			return Promise.resolve({ ok: true });
		}),
		stop: () => exclusive(() => {
			ctrlSock.write(Buffer.from("STOP\n", "latin1"));
			return Promise.resolve({ ok: true });
		}),

		// pull one waveform from the data plane -> trace
		capture: (args) => exclusive(() => {
			return readWaveform().then((wf) => {
				const series = toSeries(wf);
				const name = args.name || "thunderscope";
				io.trace(name, {
					x: series.length ? series[0].x : [],
					xUnit: "s",
					yUnit: "V",
					series: series
				});
				return { trace: name, seq: wf.seq, channels: series.length, points: series.length ? series[0].x.length : 0, fsPerSample: wf.fsPerSample.toString() };
			});
		}),

		status: () => ({ connected: Boolean(ctrlSock && dataSock), settings: settings, lastSeq: seq })
	};

	return {
		start: () => connect().then(() => {
			io.status("running", settings.host + ":" + settings.port);
		}).catch((err) => {
			io.status("error", err.message);
			throw err;
		}),
		stop: () => {
			if (dataSock) {
				dataSock.destroy();
				dataSock = null;
			}
			if (ctrlSock) {
				ctrlSock.destroy();
				ctrlSock = null;
			}
			return Promise.resolve();
		},
		command: (name, args) => {
			if (!commands[name]) {
				return Promise.reject(new Error("unknown command: " + name));
			}
			return Promise.resolve().then(() => commands[name](args || {}));
		}
	};
};

module.exports = {
	name: "thunderscope",
	description: "ThunderScope open-source scope via TS.NET: SCPI control plane + binary waveform data plane (libscopehal/SCPITwinLanTransport framing) -> traces; SCPI passthrough, run/stop",
	options: {
		host: "TS.NET host (default 127.0.0.1)",
		port: "SCPI control port (default 5025)",
		dataPort: "waveform data port (default 5026)"
	},
	commands: {
		query: "{command} raw SCPI query",
		write: "{command} raw SCPI write",
		run: "{} arm (NORMAL)", stop: "{} stop",
		capture: "{name?} pull one waveform -> trace (x = seconds rel. to trigger)",
		status: "{} connection state"
	},
	create: create
};
