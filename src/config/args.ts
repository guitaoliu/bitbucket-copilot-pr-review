import {
	BATCH_CLI_OPTION_METADATA,
	CLI_COMMAND_METADATA,
	type CliCommandMetadata,
	type CliOptionMetadata,
	REVIEW_CLI_OPTION_METADATA,
} from "./metadata.ts";

export interface CommonCliOptions {
	dryRun: boolean;
	forceReview: boolean;
	help: boolean;
}

export interface ReviewCliOptions extends CommonCliOptions {
	command: "review";
	pullRequestUrl: string;
	confirmRerun: boolean;
	repoRoot?: string;
}

export interface BatchCliOptions extends CommonCliOptions {
	command: "batch";
	repositoryUrl: string;
	tempRoot?: string;
	maxParallel?: number;
	keepWorkdirs: boolean;
}

export type CliOptions = ReviewCliOptions | BatchCliOptions;

export interface HelpCliResult {
	help: true;
}

export type ParsedCliArgs = CliOptions | HelpCliResult;

function parsePositiveIntegerOption(flag: string, value: string): number {
	if (!/^\d+$/.test(value)) {
		throw new Error(`${flag} must be a positive integer.`);
	}

	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`${flag} must be a positive integer.`);
	}

	return parsed;
}

function parseFlagOnlyOption(arg: string, option: CliOptionMetadata): boolean {
	return option.flags.includes(arg);
}

function parseValueOption(options: {
	argv: string[];
	index: number;
	flag: string;
}): { value: string; nextIndex: number } {
	const next = options.argv[options.index + 1];
	if (!next) {
		throw new Error(`${options.flag} requires a value.`);
	}

	return {
		value: next,
		nextIndex: options.index + 1,
	};
}

function parseReviewCommandArgs(argv: string[]): ReviewCliOptions {
	const options: ReviewCliOptions = {
		command: "review",
		pullRequestUrl: "",
		dryRun: false,
		forceReview: false,
		confirmRerun: false,
		help: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === undefined || arg === "--") {
			continue;
		}

		if (parseFlagOnlyOption(arg, REVIEW_CLI_OPTION_METADATA.dryRun)) {
			options.dryRun = true;
			continue;
		}

		if (parseFlagOnlyOption(arg, REVIEW_CLI_OPTION_METADATA.forceReview)) {
			options.forceReview = true;
			continue;
		}

		if (parseFlagOnlyOption(arg, REVIEW_CLI_OPTION_METADATA.confirmRerun)) {
			options.confirmRerun = true;
			continue;
		}

		if (parseFlagOnlyOption(arg, REVIEW_CLI_OPTION_METADATA.repoRoot)) {
			const parsed = parseValueOption({
				argv,
				index,
				flag: "--repo-root",
			});
			options.repoRoot = parsed.value;
			index = parsed.nextIndex;
			continue;
		}

		if (!arg.startsWith("-") && options.pullRequestUrl.length === 0) {
			options.pullRequestUrl = arg;
			continue;
		}

		throw new Error(`Unknown argument for review: ${arg}`);
	}

	if (options.pullRequestUrl.length === 0) {
		throw new Error("review requires <pull-request-url>.");
	}

	return options;
}

function parseBatchCommandArgs(argv: string[]): BatchCliOptions {
	const options: BatchCliOptions = {
		command: "batch",
		repositoryUrl: "",
		dryRun: false,
		forceReview: false,
		keepWorkdirs: false,
		help: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === undefined || arg === "--") {
			continue;
		}

		if (parseFlagOnlyOption(arg, BATCH_CLI_OPTION_METADATA.dryRun)) {
			options.dryRun = true;
			continue;
		}

		if (parseFlagOnlyOption(arg, BATCH_CLI_OPTION_METADATA.forceReview)) {
			options.forceReview = true;
			continue;
		}

		if (parseFlagOnlyOption(arg, BATCH_CLI_OPTION_METADATA.tempRoot)) {
			const parsed = parseValueOption({
				argv,
				index,
				flag: "--temp-root",
			});
			options.tempRoot = parsed.value;
			index = parsed.nextIndex;
			continue;
		}

		if (parseFlagOnlyOption(arg, BATCH_CLI_OPTION_METADATA.maxParallel)) {
			const parsed = parseValueOption({
				argv,
				index,
				flag: "--max-parallel",
			});
			options.maxParallel = parsePositiveIntegerOption(arg, parsed.value);
			index = parsed.nextIndex;
			continue;
		}

		if (parseFlagOnlyOption(arg, BATCH_CLI_OPTION_METADATA.keepWorkdirs)) {
			options.keepWorkdirs = true;
			continue;
		}

		if (!arg.startsWith("-") && options.repositoryUrl.length === 0) {
			options.repositoryUrl = arg;
			continue;
		}

		throw new Error(`Unknown argument for batch: ${arg}`);
	}

	if (options.repositoryUrl.length === 0) {
		throw new Error("batch requires <repository-url>.");
	}

	return options;
}

function isTopLevelHelp(argv: string[]): boolean {
	return (
		argv.length === 1 &&
		REVIEW_CLI_OPTION_METADATA.help.flags.includes(argv[0] ?? "")
	);
}

function isCommandHelp(argv: string[]): boolean {
	return isTopLevelHelp(argv);
}

function buildOptionLines(options: readonly CliOptionMetadata[]): string[] {
	return options.map((option) => {
		const flagText = option.flags.join(", ");
		const left = `${flagText}${option.valueLabel ? ` ${option.valueLabel}` : ""}`;
		return `  ${left.padEnd(24)} ${option.description}`;
	});
}

function buildCommandSummaryLines(): string[] {
	return Object.entries(CLI_COMMAND_METADATA).map(([_commandName, command]) => {
		const commandUsage = command.usage;
		return `  ${commandUsage.padEnd(34)} ${command.description}`;
	});
}

function buildCommandHelp(options: {
	commandName: keyof typeof CLI_COMMAND_METADATA;
	optionMetadata: readonly CliOptionMetadata[];
}): string[] {
	const command = CLI_COMMAND_METADATA[
		options.commandName
	] as CliCommandMetadata;
	return [
		`${options.commandName.toUpperCase()}`,
		`  ${command.description}`,
		`  Usage: bitbucket-copilot-pr-review ${command.usage}`,
		...(command.argumentDescription
			? [
					`  Argument: ${command.argumentLabel}`,
					`    ${command.argumentDescription}`,
				]
			: []),
		"  Options:",
		...buildOptionLines(options.optionMetadata),
	];
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
	if (argv.length === 0 || isTopLevelHelp(argv)) {
		return { help: true };
	}

	const [command, ...rest] = argv;
	if (isCommandHelp(rest)) {
		return { help: true };
	}

	if (command === "review") {
		return parseReviewCommandArgs(rest);
	}

	if (command === "batch") {
		return parseBatchCommandArgs(rest);
	}

	throw new Error(`Unknown command: ${command}. Expected 'review' or 'batch'.`);
}

export function isReviewCliOptions(
	options: ParsedCliArgs,
): options is ReviewCliOptions {
	return "command" in options && options.command === "review";
}

export function isBatchCliOptions(
	options: ParsedCliArgs,
): options is BatchCliOptions {
	return "command" in options && options.command === "batch";
}

export function getHelpText(): string {
	return [
		"Usage: bitbucket-copilot-pr-review <command> [options]",
		"",
		"Commands:",
		...buildCommandSummaryLines(),
		"",
		...buildCommandHelp({
			commandName: "review",
			optionMetadata: Object.values(REVIEW_CLI_OPTION_METADATA),
		}),
		"",
		...buildCommandHelp({
			commandName: "batch",
			optionMetadata: Object.values(BATCH_CLI_OPTION_METADATA),
		}),
	].join("\n");
}
