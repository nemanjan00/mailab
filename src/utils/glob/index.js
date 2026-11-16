// Shell-style globs ("psu_*", "*_temp") for channel / trace / value names.

const toRegex = (glob) => new RegExp("^" + String(glob).split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");

/**
 * Matcher for a list of globs: true if any matches.
 * @param {string[]} globs
 * @returns {function(string): boolean}
 */
const matcher = (globs) => {
	const res = (globs || []).map(toRegex);
	return (name) => res.some((re) => re.test(name));
};

module.exports = {
	toRegex: toRegex,
	matcher: matcher
};
