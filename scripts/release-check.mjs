import { execFileSync } from "node:child_process";
import { accessSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function runStep(command, args, label, options = {}) {
	process.stdout.write(`\n==> ${label}\n`);
	execFileSync(command, args, {
		stdio: "inherit",
		encoding: "utf8",
		...options,
	});
}

function parsePackJson(text) {
	const match = text.match(/(\[\s*\{[\s\S]*\}\s*\])\s*$/u);
	if (!match) {
		throw new Error("npm pack --json did not return a trailing JSON array.");
	}

	return JSON.parse(match[1]);
}

runStep("pnpm", ["check"], "Biome check");
runStep("pnpm", ["typecheck"], "TypeScript typecheck");
runStep("pnpm", ["test"], "Test suite");
runStep("pnpm", ["build"], "Production build");
runStep("node", ["dist/cli.js", "--help"], "Built CLI top-level help");
runStep("node", ["dist/cli.js", "review", "--help"], "Built CLI review help");

const smokeRoot = mkdtempSync(path.join(tmpdir(), "copilot-review-package-"));
try {
	process.stdout.write("\n==> npm pack\n");
	const packOutput = execFileSync(
		"npm",
		["pack", "--json", "--ignore-scripts", "--pack-destination", smokeRoot],
		{ encoding: "utf8" },
	);
	process.stdout.write(packOutput);

	const packEntries = parsePackJson(packOutput);
	const packEntry = Array.isArray(packEntries) ? packEntries[0] : undefined;
	if (
		!packEntry ||
		typeof packEntry.name !== "string" ||
		typeof packEntry.filename !== "string" ||
		!Array.isArray(packEntry.files)
	) {
		throw new Error("npm pack --json did not return package metadata.");
	}

	const packedPaths = new Set(
		packEntry.files
			.map((entry) => entry?.path)
			.filter((entryPath) => typeof entryPath === "string"),
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

	const tarballPath = path.join(smokeRoot, packEntry.filename);
	writeFileSync(
		path.join(smokeRoot, "package.json"),
		JSON.stringify({ private: true }),
	);
	runStep(
		"pnpm",
		["add", "--ignore-scripts", `file:${tarballPath}`],
		"Install packed CLI with pnpm",
		{ cwd: smokeRoot },
	);

	const consumerRequire = createRequire(path.join(smokeRoot, "package.json"));
	const installedPackageJson = consumerRequire.resolve(
		`${packEntry.name}/package.json`,
	);
	const installedPackageRequire = createRequire(installedPackageJson);
	const copilotPackage = installedPackageRequire(
		"@github/copilot/package.json",
	);
	const copilotLoaderPath = installedPackageRequire.resolve(
		"@github/copilot/npm-loader.js",
	);
	accessSync(copilotLoaderPath);

	const copilotSdkPath = installedPackageRequire.resolve("@github/copilot-sdk");
	const { CopilotClient, RuntimeConnection } = await import(
		pathToFileURL(copilotSdkPath).href
	);
	const client = new CopilotClient({
		connection: RuntimeConnection.forStdio({
			path: copilotLoaderPath,
			args: ["--no-auto-update", `--log-dir=${path.join(smokeRoot, "logs")}`],
		}),
		useLoggedInUser: false,
	});
	await client.start();
	await client.stop();
	process.stdout.write("Copilot SDK client startup: passed\n");

	const copilotVersion = execFileSync(
		process.execPath,
		[copilotLoaderPath, "--version"],
		{
			cwd: smokeRoot,
			encoding: "utf8",
		},
	).trim();
	if (!copilotVersion) {
		throw new Error("Installed Copilot CLI loader returned an empty version.");
	}
	if (!copilotVersion.includes(copilotPackage.version)) {
		throw new Error(
			`Installed Copilot CLI loader reported ${copilotVersion}, expected ${copilotPackage.version}.`,
		);
	}
	process.stdout.write(`Copilot CLI loader version: ${copilotVersion}\n`);
} finally {
	rmSync(smokeRoot, { recursive: true, force: true });
}

process.stdout.write("\nRelease verification passed.\n");
