// Latest version of a lab image, e.g. a scope screenshot.

export default {
	mount: (body, initial, ctx) => {
		let pane = initial;
		body.innerHTML = "<div class=\"imgpane\"><div class=\"empty\">set config.image</div><img alt=\"\"><button class=\"snap\" title=\"snapshot\">📷 snapshot</button></div>";
		const img = body.querySelector("img");
		const snap = body.querySelector(".snap");
		const empty = body.querySelector(".empty");
		// with config.device set (a camera), offer a snapshot button
		snap.addEventListener("click", () => {
			ctx.api("POST", "/devices/" + pane.config.device + "/command", { command: "snapshot", args: {} }).then((res) => {
				snap.textContent = "📷 saved";
				snap.title = res.path || "";
				setTimeout(() => {
					snap.textContent = "📷 snapshot";
				}, 1500);
			}, (err) => {
				snap.textContent = "⚠ " + err.message;
			});
		});

		const load = () => {
			snap.style.display = pane.config.device ? "" : "none";
			empty.style.display = pane.config.image ? "none" : "";
			img.style.display = pane.config.image ? "" : "none";
			if (!pane.config.image) {
				return;
			}
			const known = ctx.state.images.some((i) => i.name === pane.config.image);
			if (known) {
				img.src = "/api/images/" + encodeURIComponent(pane.config.image) + "?t=" + Date.now();
			}
		};

		const off = ctx.on("image", (msg) => {
			if (msg.name === pane.config.image) {
				load();
			}
		});
		// config.interval (seconds, > 0): auto-refresh by asking the device for
		// a fresh snapshot — the screen pane tracks the instrument live
		let timer = null;
		const setupTimer = () => {
			clearInterval(timer);
			timer = null;
			const iv = Number(pane.config.interval);
			if (pane.config.device && iv > 0) {
				timer = setInterval(() => {
					ctx.api("POST", "/devices/" + pane.config.device + "/command", { command: "snapshot", args: {} }).catch(() => null);
				}, Math.max(1, iv) * 1000);
			}
		};
		setupTimer();
		load();

		return {
			update: (next) => {
				const ivChanged = next.config.interval !== pane.config.interval;
				const devChanged = next.config.device !== pane.config.device;
				pane = next;
				if (ivChanged || devChanged) {
					setupTimer();
				}
				load();
			},
			destroy: () => {
				off();
				clearInterval(timer);
			}
		};
	}
};
