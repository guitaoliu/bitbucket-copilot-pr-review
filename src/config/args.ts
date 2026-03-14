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

		if (arg === "--") {
			continue;
		}

		if (arg === "--dry-run" || arg === "--no-publish") {
			options.dryRun = true;
			continue;
		}

		if (arg === "--force-review") {
			options.forceReview = true;
			continue;
		}

		if (arg === "--confirm-rerun") {
			options.confirmRerun = true;
			continue;
		}

		if (arg === "--repo-root") {
			const next = argv[index + 1];
			if (!next) {
				throw new Error("--repo-root requires a value.");
			}
			options.repoRoot = next;
			index += 1;
			continue;
		}

		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}

		throw new Error(`Unknown argument: ${arg}`);
	}

	return options;
}

export function getHelpText(): string {
	return [
		"Usage: pnpm review -- [options]",
		"",
		"Options:",
		"  --dry-run       Run the review but skip Bitbucket publishing",
		"  --force-review  Run even if the current PR revision already has a fully published result",
		"  --confirm-rerun Prompt before rerunning an unchanged PR revision with unusable cached artifacts",
		"  --repo-root     Path to the repository under review",
		"  -h, --help      Show this help text",
	].join("\n");
}
