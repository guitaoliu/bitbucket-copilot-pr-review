import { CLI_OPTION_METADATA } from "./metadata.ts";

export interface CliOptions {
	dryRun: boolean;
	forceReview: boolean;
	confirmRerun: boolean;
	repoRoot?: string;
	help: boolean;
}

export function parseCliArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		dryRun: false,
		forceReview: false,
		confirmRerun: false,
		help: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === undefined) {
			continue;
		}

		if (arg === "--") {
			continue;
		}

		if (CLI_OPTION_METADATA.dryRun.flags.includes(arg)) {
			options.dryRun = true;
			continue;
		}

		if (CLI_OPTION_METADATA.forceReview.flags.includes(arg)) {
			options.forceReview = true;
			continue;
		}

		if (CLI_OPTION_METADATA.confirmRerun.flags.includes(arg)) {
			options.confirmRerun = true;
			continue;
		}

		if (CLI_OPTION_METADATA.repoRoot.flags.includes(arg)) {
			const next = argv[index + 1];
			if (!next) {
				throw new Error("--repo-root requires a value.");
			}
			options.repoRoot = next;
			index += 1;
			continue;
		}

		if (CLI_OPTION_METADATA.help.flags.includes(arg)) {
			options.help = true;
			continue;
		}

		throw new Error(`Unknown argument: ${arg}`);
	}

	return options;
}

export function getHelpText(): string {
	const optionLines = Object.values(CLI_OPTION_METADATA).map((option) => {
		const flagText = option.flags.join(", ");
		const left = `${flagText}${option.valueLabel ? ` ${option.valueLabel}` : ""}`;
		return `  ${left.padEnd(16)} ${option.description}`;
	});

	return [
		"Usage: pnpm review -- [options]",
		"",
		"Options:",
		...optionLines,
	].join("\n");
}
