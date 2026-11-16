const affine = require("..");

const close = (a, b) => {
	expect(a.length).toBe(b.length);
	a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));
};

describe("affine", () => {
	test("params round-trip, including mirror", () => {
		const params = { x: 10, y: -4, scale: 2.5, rotate: 30, flip: true };
		const back = affine.toParams(affine.fromParams(params));
		expect(back.flip).toBe(true);
		expect(back.scale).toBeCloseTo(2.5);
		expect(back.rotate).toBeCloseTo(30);
		expect(back.x).toBe(10);
	});

	test("invert and multiply", () => {
		const m = affine.fromParams({ x: 3, y: 7, scale: 1.7, rotate: -50 });
		close(affine.multiply(m, affine.invert(m)), affine.IDENTITY);
		close(affine.apply(affine.invert(m), affine.apply(m, [12, -3])), [12, -3]);
	});

	test("2 point pairs give a similarity transform (with optional mirror)", () => {
		const truth = affine.fromParams({ x: 100, y: 50, scale: 0.5, rotate: 90, flip: true });
		const src = [[0, 0], [200, 40]];
		const dst = src.map((p) => affine.apply(truth, p));
		const fit = affine.fromTwoPoints(src, dst, true);
		close(affine.apply(fit, [77, 13]), affine.apply(truth, [77, 13]));
		expect(() => affine.fromTwoPoints([[1, 1], [1, 1]], dst)).toThrow(/differ/);
	});

	test("3 point pairs give a full affine (shear, independent scales)", () => {
		const truth = [1.2, 0.1, -0.3, 0.8, 5, 9];
		const src = [[0, 0], [100, 0], [0, 50]];
		const fit = affine.fromThreePoints(src, src.map((p) => affine.apply(truth, p)));
		close(fit, truth);
		expect(() => affine.fromThreePoints([[0, 0], [1, 1], [2, 2]], src)).toThrow(/collinear/);
	});

	test("bounds of a rotated rectangle", () => {
		const b = affine.boundsOf(affine.fromParams({ rotate: 90 }), { x: 0, y: 0, w: 10, h: 4 });
		expect(b.x).toBeCloseTo(-4);
		expect(b.w).toBeCloseTo(4);
		expect(b.h).toBeCloseTo(10);
	});
});
