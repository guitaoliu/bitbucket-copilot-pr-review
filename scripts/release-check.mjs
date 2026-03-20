import { execFileSync } from "node:child_process";

function runStep(command, args, label, options = {}) {
	process.stdout.write(`\n==> ${label}\n`);
	execFileSync(command, args, {
		stdio: "inherit",
		encoding: "utf8",
		...options,
	});
}

function parseTrailingJsonArray(text) {
	const match = text.match(/(\[\s*\{[\s\S]*\}\s*\])\s*$/u);
	if (!match) {
		throw new Error(
			"npm pack --dry-run --json did not return a trailing JSON array.",
		);
	}

	return JSON.parse(match[1]);
}

runStep("pnpm", ["check"], "Biome check");
runStep("pnpm", ["typecheck"], "TypeScript typecheck");
runStep("pnpm", ["test"], "Test suite");
runStep("pnpm", ["build"], "Production build");
runStep("node", ["dist/cli.js", "--help"], "Built CLI top-level help");
runStep("node", ["dist/cli.js", "review", "--help"], "Built CLI review help");
runStep("node", ["dist/cli.js", "batch", "--help"], "Built CLI batch help");

process.stdout.write("\n==> npm pack --dry-run\n");
const packOutput = execFileSync("npm", ["pack", "--dry-run", "--json"], {
	encoding: "utf8",
});
process.stdout.write(packOutput);

const packEntries = parseTrailingJsonArray(packOutput);
const packEntry = Array.isArray(packEntries) ? packEntries[0] : undefined;
if (!packEntry || !Array.isArray(packEntry.files)) {
	throw new Error("npm pack --dry-run --json did not return file metadata.");
}

const packedPaths = new Set(
	packEntry.files
		.map((entry) => entry?.path)
		.filter((path) => typeof path === "string"),
);

for (const requiredPath of [
	"dist/cli.js",
	"README.md",
	"schemas/copilot-code-review.schema.json",
]) {
	if (!packedPaths.has(requiredPath)) {
		throw new Error(`Expected ${requiredPath} to be included by npm pack.`);
	}
}

process.stdout.write("\nRelease verification passed.\n");
