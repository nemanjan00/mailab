// {{channel}} / {{channel|precision}} placeholders in markdown text, filled
// with live values by the web UI (markdown panes, custom pane text).

// channel names are mathjs symbols; precision is a digit count
const PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\|\s*(\d{1,2})\s*)?\}\}/g;

/**
 * Channel names referenced by a text, without duplicates.
 * @param {string} text
 */
const names = (text) => {
	const found = [];
	String(text || "").replace(PATTERN, (_m, name) => {
		if (!found.includes(name)) {
			found.push(name);
		}
		return "";
	});
	return found;
};

/**
 * Replace every placeholder with format(name, precision).
 * @param {string} text
 * @param {function(string, (number|undefined)): string} format precision is
 *   undefined when the placeholder has none
 */
const fill = (text, format) => String(text || "").replace(PATTERN, (_m, name, precision) => {
	return format(name, precision === undefined ? undefined : Number(precision));
});

module.exports = {
	names: names,
	fill: fill
};
