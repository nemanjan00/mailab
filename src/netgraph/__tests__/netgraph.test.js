const netgraph = require("..");

// synthetic two-sided board:
//   J1.1 ─top─ R1.1   R1.2 ─top─ via ─bottom─ U1.3
//   R1.2 is also tapped mid-wire (T-junction) by a wire to C1.1
//   C1.2 and U1.4 both carry a "GND" label; U1.1 touches nothing
const sample = () => ({
	name: "demo",
	snap: 2,
	components: [
		{ id: "J1", side: null, pins: [{ name: "1", x: 0, y: 0 }] },
		{ id: "R1", side: "top", value: "10k", box: [9, -2, 12, 4], pins: [{ name: "1", x: 10, y: 0 }, { name: "2", x: 20, y: 0 }] },
		{ id: "C1", side: "top", value: "100n", pins: [{ name: "1", x: 30, y: 20 }, { name: "2", x: 30, y: 30 }] },
		{ id: "U1", side: null, pins: [{ name: "1", x: 80, y: 80 }, { name: "3", x: 60, y: 0 }, { name: "4", x: 60, y: 30 }] }
	],
	wires: [
		{ id: "w1", side: "top", points: [[0, 0], [10, 0]] },
		{ id: "w2", side: "top", points: [[20, 0], [50, 0]] },
		{ id: "w3", side: "bottom", points: [[50, 0], [60, 0]] },
		{ id: "w4", side: "top", points: [[30, 0.5], [30, 20]] },
		// bottom wire crossing a top wire: must NOT connect
		{ id: "w5", side: "bottom", points: [[5, -10], [5, 10]] }
	],
	vias: [{ id: "v1", x: 50, y: 0 }],
	labels: [{ id: "l1", x: 30, y: 30, name: "GND" }, { id: "l2", x: 60, y: 30, name: "GND" }],
	testpoints: [{ id: "TP1", x: 0, y: 0, channel: "dmm_v" }],
	nets: { GND: { color: "#00ff00" } }
});

describe("netgraph", () => {
	test("nets follow the drawn geometry", () => {
		const c = netgraph.connectivity(sample());
		const byPin = c.pinNet;
		expect(byPin["J1.1"]).toBe(byPin["R1.1"]);
		// T-junction + via joins top and bottom
		expect(byPin["R1.2"]).toBe(byPin["U1.3"]);
		expect(byPin["C1.1"]).toBe(byPin["R1.2"]);
		// labels with the same name join distant pins and name the net
		expect(byPin["C1.2"]).toBe("GND");
		expect(byPin["U1.4"]).toBe("GND");
		expect(c.nets.find((n) => n.name === "GND").color).toBe("#00ff00");
		// auto names after the first pin
		expect(byPin["J1.1"]).toBe("Net-(J1.1)");
		expect(c.nets.find((n) => n.name === "Net-(J1.1)").testpoints).toEqual(["TP1"]);
		expect(c.unconnected).toEqual(["U1.1"]);
		// the bottom wire w5 crosses w1 (top) without joining it
		expect(c.nets.find((n) => n.wires.indexOf("w5") !== -1).pins).toEqual([]);
	});

	test("a named wire names its net; conflicting names become aliases", () => {
		const b = sample();
		b.wires[1].net = "SIG";
		b.labels.push({ id: "l3", x: 40, y: 0, name: "ALSO" });
		const c = netgraph.connectivity(b);
		const net = c.nets.find((n) => n.name === "ALSO");
		expect(net.aliases).toEqual(["SIG"]);
		expect(net.pins).toEqual(["C1.1", "R1.2", "U1.3"]);
	});

	test("graph queries: pin, neighbours, path avoiding ground", () => {
		const b = sample();
		const g = netgraph.graph(b, netgraph.connectivity(b));
		expect(g.pin("R1.2").connected).toEqual(["C1.1", "U1.3"]);
		expect(g.pin("U1.1").net).toBe(null);
		expect(() => g.pin("R9.1")).toThrow(/unknown pin/);
		const n = g.neighbors("R1");
		expect(n.neighbors).toEqual(["C1", "J1", "U1"]);
		const direct = g.path("J1", "U1");
		expect(direct.found).toBe(true);
		expect(direct.steps.map((s) => s.node)).toEqual(["C:J1", "N:Net-(J1.1)", "C:R1", "N:Net-(C1.1)", "C:U1"]);
		// C1 and U1 share two nets; avoiding the signal net leaves GND
		expect(g.path("C1", "U1").steps.map((s) => s.node)).toEqual(["C:C1", "N:Net-(C1.1)", "C:U1"]);
		expect(g.path("C1", "U1", ["Net-(C1.1)"]).steps.map((s) => s.node)).toEqual(["C:C1", "N:GND", "C:U1"]);
		expect(g.path("C1.2", "U1.4").steps.map((s) => s.node)).toEqual(["N:GND"]);
		expect(g.path("J1", "U1", ["Net-(J1.1)"]).found).toBe(false);
		expect(g.search("10k").components).toEqual(["R1"]);
	});

	test("netlist exports", () => {
		const b = sample();
		const c = netgraph.connectivity(b);
		const csv = netgraph.netlist(b, c, "csv");
		expect(csv.split("\n")[0]).toBe("net,ref,pin");
		expect(csv).toContain("GND,C1,2\nGND,U1,4");
		const kicad = netgraph.netlist(b, c, "kicad");
		expect(kicad).toMatch(/^\(export \(version "E"\)/);
		expect(kicad).toContain("(comp (ref \"R1\") (value \"10k\")");
		expect(kicad).toContain("(net (code \"1\") (name \"GND\")");
		const json = netgraph.netlist(b, c, "json");
		expect(json.components.find((x) => x.ref === "R1").pins).toEqual([{ name: "1", net: "Net-(J1.1)" }, { name: "2", net: "Net-(C1.1)" }]);
		expect(json.unconnected).toEqual(["U1.1"]);
	});
});
