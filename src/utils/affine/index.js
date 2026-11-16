// 2-D affine transforms as canvas-style matrices [a, b, c, d, e, f]:
//   x' = a*x + c*y + e
//   y' = b*x + d*y + f
// Used to place layers (PDF pages, photos) on a board and to align a photo
// to a drawing from 2 (similarity) or 3 (full affine) point pairs. Plain
// CommonJS with no dependencies, so the browser bundle can use it too.

const IDENTITY = [1, 0, 0, 1, 0, 0];
const DEG = Math.PI / 180;

const apply = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];

// m1 after m2: apply(multiply(m1, m2), p) === apply(m1, apply(m2, p))
const multiply = (m1, m2) => [
	m1[0] * m2[0] + m1[2] * m2[1],
	m1[1] * m2[0] + m1[3] * m2[1],
	m1[0] * m2[2] + m1[2] * m2[3],
	m1[1] * m2[2] + m1[3] * m2[3],
	m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
	m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
];

const invert = (m) => {
	const det = m[0] * m[3] - m[1] * m[2];
	if (!det) {
		throw new Error("transform is not invertible");
	}
	return [
		m[3] / det,
		-m[1] / det,
		-m[2] / det,
		m[0] / det,
		(m[2] * m[5] - m[3] * m[4]) / det,
		(m[1] * m[4] - m[0] * m[5]) / det
	];
};

/**
 * Build a matrix from parameters: flip (mirror x, for bottom-side photos),
 * then scale, rotate (degrees) and offset.
 * @param {{x: number, y: number, scale: number, rotate: number, flip: boolean}} params
 */
const fromParams = (params) => {
	const s = params.scale === undefined ? 1 : params.scale;
	const r = (params.rotate || 0) * DEG;
	const fx = params.flip ? -1 : 1;
	const cos = Math.cos(r) * s;
	const sin = Math.sin(r) * s;
	return [cos * fx, sin * fx, -sin, cos, params.x || 0, params.y || 0];
};

/**
 * Inverse of fromParams for display (exact when the matrix is a similarity).
 */
const toParams = (m) => {
	const det = m[0] * m[3] - m[1] * m[2];
	const flip = det < 0;
	// column 2 (c, d) is never mirrored by fromParams
	const scale = Math.hypot(m[2], m[3]);
	const rotate = Math.atan2(-m[2], m[3]) / DEG;
	return { x: m[4], y: m[5], scale: scale, rotate: rotate, flip: flip };
};

/**
 * Similarity transform (scale, rotation, offset; no shear) mapping 2 source
 * points onto 2 destination points. With `flip`, the source is mirrored first.
 */
const fromTwoPoints = (src, dst, flip) => {
	const fx = flip ? -1 : 1;
	const s0 = [src[0][0] * fx, src[0][1]];
	const s1 = [src[1][0] * fx, src[1][1]];
	const vs = [s1[0] - s0[0], s1[1] - s0[1]];
	const vd = [dst[1][0] - dst[0][0], dst[1][1] - dst[0][1]];
	const ls = Math.hypot(vs[0], vs[1]);
	if (!ls) {
		throw new Error("alignment points must differ");
	}
	const scale = Math.hypot(vd[0], vd[1]) / ls;
	const angle = Math.atan2(vd[1], vd[0]) - Math.atan2(vs[1], vs[0]);
	const cos = Math.cos(angle) * scale;
	const sin = Math.sin(angle) * scale;
	// rotation+scale R, then offset so R*s0 lands on d0
	const e = dst[0][0] - (cos * s0[0] - sin * s0[1]);
	const f = dst[0][1] - (sin * s0[0] + cos * s0[1]);
	return multiply([cos, sin, -sin, cos, e, f], [fx, 0, 0, 1, 0, 0]);
};

/**
 * Full affine transform mapping 3 source points onto 3 destination points
 * (handles skewed photos and independent x/y scale).
 */
const fromThreePoints = (src, dst) => {
	// rows [x y 1]; Cramer's rule for [x y 1] . [p q r] = v, once for x' and once for y'
	const det3 = (r) => r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1])
		- r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0])
		+ r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
	const rows = src.map((p) => [p[0], p[1], 1]);
	const det = det3(rows);
	if (Math.abs(det) < 1e-9) {
		throw new Error("alignment points must not be collinear");
	}
	const solve = (k) => [0, 1, 2].map((col) => det3(rows.map((row, i) => row.map((v, j) => (j === col ? dst[i][k] : v)))) / det);
	const xs = solve(0);
	const ys = solve(1);
	return [xs[0], ys[0], xs[1], ys[1], xs[2], ys[2]];
};

/**
 * Axis-aligned bounding box {x, y, w, h} of a rectangle after a transform.
 */
const boundsOf = (m, rect) => {
	const pts = [[rect.x, rect.y], [rect.x + rect.w, rect.y], [rect.x, rect.y + rect.h], [rect.x + rect.w, rect.y + rect.h]].map((p) => apply(m, p));
	const xs = pts.map((p) => p[0]);
	const ys = pts.map((p) => p[1]);
	const x = Math.min.apply(null, xs);
	const y = Math.min.apply(null, ys);
	return { x: x, y: y, w: Math.max.apply(null, xs) - x, h: Math.max.apply(null, ys) - y };
};

module.exports = {
	IDENTITY: IDENTITY,
	apply: apply,
	multiply: multiply,
	invert: invert,
	fromParams: fromParams,
	toParams: toParams,
	fromTwoPoints: fromTwoPoints,
	fromThreePoints: fromThreePoints,
	boundsOf: boundsOf
};
