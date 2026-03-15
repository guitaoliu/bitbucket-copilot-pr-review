import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveBundledCopilotCliPath(
	resolveModule: (specifier: string) => string = (specifier) =>
		import.meta.resolve(specifier),
): string {
	let sdkUrl: string;

	try {
		sdkUrl = resolveModule("@github/copilot/sdk");
	} catch (error) {
		throw new Error(
			"Unable to resolve the bundled @github/copilot runtime. Ensure dependencies are installed before running the reviewer.",
			{ cause: error },
		);
	}

	const cliPath = join(dirname(dirname(fileURLToPath(sdkUrl))), "index.js");
	if (!existsSync(cliPath)) {
		throw new Error(
			`Resolved bundled @github/copilot CLI path does not exist: ${cliPath}`,
		);
	}

	return cliPath;
}
