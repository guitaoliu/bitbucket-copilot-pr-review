import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/**/*.test.ts"],
	platform: "node",
	format: "esm",
	target: "node24",
	outDir: ".test-dist",
	clean: true,
	loader: {
		".md": "text",
	},
	deps: {
		onlyBundle: false,
	},
});
