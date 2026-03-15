import { defineConfig } from "tsdown";

export default defineConfig({
	entry: {
		cli: "src/cli.ts",
	},
	platform: "node",
	format: "esm",
	target: "node24",
	clean: true,
	sourcemap: true,
	dts: false,
	outExtensions() {
		return {
			js: ".js",
		};
	},
	banner: {
		js: "#!/usr/bin/env node",
	},
	deps: {
		alwaysBundle: ["@github/copilot-sdk"],
		onlyBundle: false,
	},
});
