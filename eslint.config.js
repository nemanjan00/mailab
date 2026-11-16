// ESLint 10 flat config (eslintrc is gone in v10); same rules as .eslintrc.json elsewhere.

const js = require("@eslint/js");
const globals = require("globals");
const babelParser = require("@babel/eslint-parser");

const RULES = {
	indent: ["error", "tab"],
	quotes: ["error", "double"],
	semi: ["error", "always"],
	"no-param-reassign": "error",
	"no-trailing-spaces": "error",
	"no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }]
};

module.exports = [
	{
		ignores: ["node_modules/", "data/"]
	},
	js.configs.recommended,
	{
		files: ["src/**/*.js", "bin/**/*.js", "eslint.config.js"],
		languageOptions: {
			parser: babelParser,
			parserOptions: { requireConfigFile: false },
			sourceType: "commonjs",
			globals: Object.assign({}, globals.node, globals.jest)
		},
		rules: RULES
	},
	{
		// browser ES modules; uPlot, katex, marked, GridStack come from <script> tags
		files: ["public/**/*.js"],
		languageOptions: {
			sourceType: "module",
			globals: Object.assign({}, globals.browser, { uPlot: "readonly", katex: "readonly", marked: "readonly", GridStack: "readonly" })
		},
		rules: RULES
	}
];
