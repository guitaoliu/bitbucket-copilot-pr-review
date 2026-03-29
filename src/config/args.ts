import { CliUserError } from "./errors.ts";
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
	commandName?: keyof typeof CLI_COMMAND_METADATA;
}

export type ParsedCliArgs = CliOptions | HelpCliResult;

function parsePositiveIntegerOption(flag: string, value: string): number {
	if (!/^\d+$/.test(value)) {
		throw new CliUserError(`${flag} must be a positive integer.`);
	}

	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new CliUserError(`${flag} must be a positive integer.`);
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
	if (!next || next.startsWith("-")) {
		throw new CliUserError(`${options.flag} requires a value.`);
	}

	return {
		value: next,
		nextIndex: options.index + 1,
	};
}

function isHelpFlag(arg: string | undefined): boolean {
	return REVIEW_CLI_OPTION_METADATA.help.flags.includes(arg ?? "");
}

function parseCommandArgs<TOptions extends CommonCliOptions>(options: {
	argv: string[];
	initial: TOptions;
	parseArgument: (
		arg: string,
		index: number,
		current: TOptions,
	) => number | true | void;
	setPositional: (arg: string, current: TOptions) => boolean;
	missingArgumentMessage: string;
}): TOptions {
	let stopParsingOptions = false;

	for (let index = 0; index < options.argv.length; index += 1) {
		const arg = options.argv[index];
		if (arg === undefined) {
			continue;
		}

		if (!stopParsingOptions && arg === "--") {
			stopParsingOptions = true;
			continue;
		}

		if (!stopParsingOptions && isHelpFlag(arg)) {
			options.initial.help = true;
			continue;
		}

		if (!stopParsingOptions) {
			const parseResult = options.parseArgument(arg, index, options.initial);
			if (typeof parseResult === "number") {
				index = parseResult;
				continue;
			}

			if (parseResult === true) {
				continue;
			}
		}

		if (options.setPositional(arg, options.initial)) {
			continue;
		}

		throw new CliUserError(options.missingArgumentMessage.replace("{arg}", arg));
	}

	return options.initial;
}

function parseReviewCommandArgs(argv: string[]): ReviewCliOptions {
	const initial: ReviewCliOptions = {
		command: "review",
		pullRequestUrl: "",
		dryRun: false,
		forceReview: false,
		confirmRerun: false,
		help: false,
	};
	const options = parseCommandArgs<ReviewCliOptions>({
		argv,
		initial,
		parseArgument: (arg, index, current) => {
			if (parseFlagOnlyOption(arg, REVIEW_CLI_OPTION_METADATA.dryRun)) {
				current.dryRun = true;
				return true;
			}

			if (parseFlagOnlyOption(arg, REVIEW_CLI_OPTION_METADATA.forceReview)) {
				current.forceReview = true;
				return true;
			}

			if (parseFlagOnlyOption(arg, REVIEW_CLI_OPTION_METADATA.confirmRerun)) {
				current.confirmRerun = true;
				return true;
			}

			if (parseFlagOnlyOption(arg, REVIEW_CLI_OPTION_METADATA.repoRoot)) {
				const parsed = parseValueOption({
					argv,
					index,
					flag: "--repo-root",
				});
				current.repoRoot = parsed.value;
				return parsed.nextIndex;
			}

			return;
		},
		setPositional: (arg, current) => {
			if (current.pullRequestUrl.length === 0) {
				current.pullRequestUrl = arg;
				return true;
			}

			return false;
		},
		missingArgumentMessage: "Unknown argument for review: {arg}",
	});

	if (options.help) {
		return options;
	}

	if (options.pullRequestUrl.length === 0) {
		throw new CliUserError("review requires <pull-request-url>.");
	}

	return options;
}

function parseBatchCommandArgs(argv: string[]): BatchCliOptions {
	const initial: BatchCliOptions = {
		command: "batch",
		repositoryUrl: "",
		dryRun: false,
		forceReview: false,
		keepWorkdirs: false,
		help: false,
	};
	const options = parseCommandArgs<BatchCliOptions>({
		argv,
		initial,
		parseArgument: (arg, index, current) => {
			if (parseFlagOnlyOption(arg, BATCH_CLI_OPTION_METADATA.dryRun)) {
				current.dryRun = true;
				return true;
			}

			if (parseFlagOnlyOption(arg, BATCH_CLI_OPTION_METADATA.forceReview)) {
				current.forceReview = true;
				return true;
			}

			if (parseFlagOnlyOption(arg, BATCH_CLI_OPTION_METADATA.tempRoot)) {
				const parsed = parseValueOption({
					argv,
					index,
					flag: "--temp-root",
				});
				current.tempRoot = parsed.value;
				return parsed.nextIndex;
			}

			if (parseFlagOnlyOption(arg, BATCH_CLI_OPTION_METADATA.maxParallel)) {
				const parsed = parseValueOption({
					argv,
					index,
					flag: "--max-parallel",
				});
				current.maxParallel = parsePositiveIntegerOption(arg, parsed.value);
				return parsed.nextIndex;
			}

			if (parseFlagOnlyOption(arg, BATCH_CLI_OPTION_METADATA.keepWorkdirs)) {
				current.keepWorkdirs = true;
				return true;
			}

			return;
		},
		setPositional: (arg, current) => {
			if (current.repositoryUrl.length === 0) {
				current.repositoryUrl = arg;
				return true;
			}

			return false;
		},
		missingArgumentMessage: "Unknown argument for batch: {arg}",
	});

	if (options.help) {
		return options;
	}

	if (options.repositoryUrl.length === 0) {
		throw new CliUserError("batch requires <repository-url>.");
	}

	return options;
}

function isTopLevelHelp(argv: string[]): boolean {
	return argv.length === 1 && isHelpFlag(argv[0]);
}

function isCommandHelp(argv: string[]): boolean {
	for (const arg of argv) {
		if (arg === "--") {
			return false;
		}

		if (isHelpFlag(arg)) {
			return true;
		}
	}

	return false;
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
	if (command === "review" && isCommandHelp(rest)) {
		return { help: true, commandName: "review" };
	}

	if (command === "batch" && isCommandHelp(rest)) {
		return { help: true, commandName: "batch" };
	}

	if (command === "review") {
		return parseReviewCommandArgs(rest);
	}

	if (command === "batch") {
		return parseBatchCommandArgs(rest);
	}

	throw new CliUserError(
		`Unknown command: ${command}. Expected 'review' or 'batch'.`,
	);
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

export function getHelpText(
	commandName?: keyof typeof CLI_COMMAND_METADATA,
): string {
	if (commandName) {
		return buildCommandHelp({
			commandName,
			optionMetadata: Object.values(
				commandName === "review"
					? REVIEW_CLI_OPTION_METADATA
					: BATCH_CLI_OPTION_METADATA,
			),
		}).join("\n");
	}

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
