// Latest version of a lab image, e.g. a scope screenshot.

export default {
	mount: (body, initial, ctx) => {
		let pane = initial;
		body.innerHTML = "<div class=\"imgpane\"><img alt=\"\"></div>";
		const img = body.querySelector("img");

		const load = () => {
			if (!pane.config.image) {
				body.querySelector(".imgpane").innerHTML = "<div class=\"empty\">set config.image</div>";
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
