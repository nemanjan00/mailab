// Runs one bytesearch in a worker thread, so a pathological regex (catastrophic
// backtracking) can be stopped by terminating the thread instead of freezing
// the lab's event loop.

const workerData = require("worker_threads").workerData;
const parentPort = require("worker_threads").parentPort;
const bytesearch = require(".");

try {
	const data = Buffer.from(workerData.data.buffer, workerData.data.byteOffset, workerData.data.byteLength);
	parentPort.postMessage({ result: bytesearch.search(data, workerData.spec, workerData.opts) });
} catch (err) {
	parentPort.postMessage({ error: err.message });
}
