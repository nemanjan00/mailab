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
		load();

		return {
			update: (next) => {
				pane = next;
				load();
			},
			destroy: off
		};
	}
};
