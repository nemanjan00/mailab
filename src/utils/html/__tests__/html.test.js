const html = require("..");

describe("html helpers", () => {
	test("decode entities", () => {
		expect(html.decode("Wi-Fi &amp; BT &#x28;x&#x29; &#39;q&#39; &nbsp;&mdash; &bogus;")).toBe("Wi-Fi & BT (x) 'q'  — &bogus;");
	});

	test("text strips tags, scripts and collapses whitespace", () => {
		expect(html.text("<p>a<br>b <script>x()</script> <b>c</b>\n\n d</p>")).toBe("a b c d");
	});

	test("rows with headers, links and data-labels", () => {
		const rows = html.rows("<table><tr><th>A</th><th>B</th></tr><tr><td data-label=\"A\"><a href=\"/x?a=1&amp;b=2\">one</a></td><td>two</td></tr></table>");
		expect(rows.length).toBe(2);
		expect(rows[0].map((c) => c.header)).toEqual([true, true]);
		expect(rows[1][0]).toMatchObject({ text: "one", href: "/x?a=1&b=2", label: "A", header: false });
	});

	test("metaTable and section", () => {
		const page = "<h2 class=\"panel-title\">One</h2><table><tr><th>K</th><td>V</td></tr></table><h2 class=\"panel-title\">Two</h2><table><tr><th>K</th><td>W</td></tr></table>";
		expect(html.metaTable(html.section(page, "One"))).toEqual({ K: "V" });
		expect(html.metaTable(html.section(page, "Two"))).toEqual({ K: "W" });
		expect(html.section(page, "Three")).toBe("");
	});
});
