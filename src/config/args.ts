import { CliUserError } from "./errors.ts";
import {
	CLI_COMMAND_METADATA,
	type CliCommandMetadata,
	type CliOptionMetadata,
	REVIEW_CLI_OPTION_METADATA,
} from "./metadata.ts";

interface CommonCliOptions {
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

type CliOptions = ReviewCliOptions;

interface HelpCliResult {
	help: true;
	commandName?: keyof typeof CLI_COMMAND_METADATA;
}

export type ParsedCliArgs = CliOptions | HelpCliResult;

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

		throw new CliUserError(`Unknown argument for review: ${arg}`);
	}

	if (options.pullRequestUrl.length === 0) {
		throw new CliUserError("review requires <pull-request-url>.");
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

	if (command === "review") {
		return parseReviewCommandArgs(rest);
	}

	throw new CliUserError(`Unknown command: ${command}. Expected 'review'.`);
}

export function isReviewCliOptions(
	options: ParsedCliArgs,
): options is ReviewCliOptions {
	return "command" in options && options.command === "review";
}

export function getHelpText(
	commandName?: keyof typeof CLI_COMMAND_METADATA,
): string {
	if (commandName) {
		return buildCommandHelp({
			commandName,
			optionMetadata: Object.values(REVIEW_CLI_OPTION_METADATA),
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
	].join("\n");
}
