// SoapySDR receivers (bladeRF, HackRF, RTL-SDR, ...) as a live FFT spectrum.

const processDriver = require("../process");

module.exports = processDriver.pythonPreset({
	name: "soapy",
	description: "SoapySDR receiver (bladeRF, HackRF, RTL-SDR): live FFT trace \"spectrum\", peak_freq/peak_db channels",
	script: "soapy_bridge.py",
	options: {
		args: "Soapy device args, e.g. driver=bladerf or driver=hackrf",
		freq: "center frequency Hz (default 100e6)",
		rate: "sample rate (default 10e6)",
		gain: "dB (default 30)",
		fft: "FFT size (default 1024)",
		average: "frames averaged per update (default 16)",
		fps: "updates per second (default 5)"
	},
	commands: {
		tune: "{freq, rate, gain, fft, average}",
		capture: "{samples, path} save raw cf32 IQ"
	},
	args: (options) => {
		return processDriver.toFlags(options, ["args", "freq", "rate", "gain", "fft", "average", "fps"]);
	}
});
