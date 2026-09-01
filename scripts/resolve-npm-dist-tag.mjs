import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolveNpmDistTag(version, gitTag) {
	if (gitTag !== `v${version}`) {
		throw new Error(
			`Git tag ${gitTag || "<missing>"} does not match package version ${version}`,
		);
	}

	if (/^\d+\.\d+\.\d+$/u.test(version)) {
		return "latest";
	}
	if (/^\d+\.\d+\.\d+-beta(?:\.(?:0|[1-9]\d*))?$/u.test(version)) {
		return "beta";
	}

	throw new Error(`Unsupported release version: ${version}`);
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		process.stdout.write(
			`${resolveNpmDistTag(process.argv[2] ?? "", process.argv[3] ?? "")}\n`,
		);
	} catch (error) {
		process.stderr.write(
			`::error::${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
