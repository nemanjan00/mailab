// Generate docs/blocks/README.md and docs/blocks/<block>/README.md from the
// live block catalog (python/flowgraph_bridge.py `blocks`) plus each block's
// about.md and example.json. `--check` only reports stale files (exit 1).

const fs = require("fs");
const path = require("path");
const blockDocs = require("../src/utils/block-docs");

const CHECK = process.argv.indexOf("--check") !== -1;

blockDocs.loadCatalog()
	.then((catalog) => {
		const missing = Object.keys(catalog).filter((name) => !fs.existsSync(path.join(blockDocs.DOCS_DIR, name, "about.md"))
			|| !fs.existsSync(path.join(blockDocs.DOCS_DIR, name, "example.json")));
		if (missing.length) {
			throw new Error("blocks without about.md / example.json: " + missing.join(", "));
		}
		const files = blockDocs.generate(catalog);
		const changed = blockDocs.stale(files);
		if (CHECK) {
			changed.forEach((rel) => console.log("stale: " + rel));
			process.exit(changed.length ? 1 : 0);
		}
		changed.forEach((rel) => {
			fs.writeFileSync(path.join(blockDocs.ROOT, rel), files[rel]);
			console.log("wrote " + rel);
		});
		console.log(Object.keys(files).length + " files, " + changed.length + " updated");
	})
	.catch((err) => {
		console.error(err.message);
		process.exit(1);
	});
