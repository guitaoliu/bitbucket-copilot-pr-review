import { CliUserError } from "./errors.ts";
import {
	CLI_COMMAND_METADATA,
	type CliOptionMetadata,
	REVIEW_CLI_OPTION_METADATA,
} from "./metadata.ts";

export interface ReviewCliOptions {
	command: "review";
	pullRequestUrl: string;
	dryRun: boolean;
	forceReview: boolean;
	confirmRerun: boolean;
	repoRoot?: string;
}

interface HelpCliResult {
	command: "help";
	commandName?: keyof typeof CLI_COMMAND_METADATA;
}

type ParsedCliArgs = ReviewCliOptions | HelpCliResult;

const HELP_FLAGS = REVIEW_CLI_OPTION_METADATA.help.flags;

function parseReviewCommandArgs(argv: string[]): ReviewCliOptions {
	const options: ReviewCliOptions = {
		command: "review",
		pullRequestUrl: "",
		dryRun: false,
		forceReview: false,
		confirmRerun: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === undefined || arg === "--") {
			continue;
		}

		if (REVIEW_CLI_OPTION_METADATA.dryRun.flags.includes(arg)) {
			options.dryRun = true;
			continue;
		}

		if (REVIEW_CLI_OPTION_METADATA.forceReview.flags.includes(arg)) {
			options.forceReview = true;
			continue;
		}

		if (REVIEW_CLI_OPTION_METADATA.confirmRerun.flags.includes(arg)) {
			options.confirmRerun = true;
			continue;
		}

		if (REVIEW_CLI_OPTION_METADATA.repoRoot.flags.includes(arg)) {
			const value = argv[index + 1];
			if (!value || value.startsWith("-")) {
				throw new CliUserError(`${arg} requires a value.`);
			}

			options.repoRoot = value;
			index += 1;
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

function isCommandHelp(argv: string[]): boolean {
	for (const arg of argv) {
		if (arg === "--") {
			return false;
		}

		if (HELP_FLAGS.includes(arg)) {
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

function buildCommandHelp(
	commandName: keyof typeof CLI_COMMAND_METADATA,
): string[] {
	const command = CLI_COMMAND_METADATA[commandName];
	return [
		commandName.toUpperCase(),
		`  ${command.description}`,
		`  Usage: bitbucket-copilot-pr-review ${command.usage}`,
		...(command.argumentDescription
			? [
					`  Argument: ${command.argumentLabel}`,
					`    ${command.argumentDescription}`,
				]
			: []),
		"  Options:",
		...buildOptionLines(Object.values(REVIEW_CLI_OPTION_METADATA)),
	];
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
	const [command, ...rest] = argv;
	if (
		command === undefined ||
		(argv.length === 1 && HELP_FLAGS.includes(command))
	) {
		return { command: "help" };
	}

	if (command === "review") {
		return isCommandHelp(rest)
			? { command: "help", commandName: "review" }
			: parseReviewCommandArgs(rest);
	}

	throw new CliUserError(`Unknown command: ${command}. Expected 'review'.`);
}

export function getHelpText(
	commandName?: keyof typeof CLI_COMMAND_METADATA,
): string {
	if (commandName) {
		return buildCommandHelp(commandName).join("\n");
	}

	return [
		"Usage: bitbucket-copilot-pr-review <command> [options]",
		"",
		"Commands:",
		...Object.values(CLI_COMMAND_METADATA).map(
			(command) => `  ${command.usage.padEnd(34)} ${command.description}`,
		),
		"",
		...buildCommandHelp("review"),
	].join("\n");
}
