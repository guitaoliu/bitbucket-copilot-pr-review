import process from "node:process";

import { BitbucketApiError } from "./bitbucket/transport.ts";
import { getHelpText, parseCliArgs } from "./config/args.ts";
import { isCliUserError } from "./config/errors.ts";
import { loadConfig } from "./config/load.ts";
import type { ReviewRunOutput } from "./review/output-types.ts";
import { runReview } from "./review/runner.ts";
import { createLogger } from "./shared/logger.ts";

function shouldShowStacks(): boolean {
	return process.env.LOG_LEVEL === "debug";
}

function isOperatorFacingError(error: unknown): boolean {
	return isCliUserError(error) || error instanceof BitbucketApiError;
}

function formatCliError(error: unknown): string {
	if (error instanceof Error) {
		if (shouldShowStacks() || !isOperatorFacingError(error)) {
			return error.stack ?? error.message;
		}

		return `Error: ${error.message}`;
	}

	return String(error);
}

export function shouldExitNonZeroForReview(
	output: Pick<ReviewRunOutput, "skipped" | "publicationStatus">,
): boolean {
	if (output.skipped) {
		return false;
	}

	return (
		output.publicationStatus === "stale" ||
		output.publicationStatus === "partial" ||
		output.publicationStatus === "failed"
	);
}

async function main(): Promise<void> {
	const cliArgs = parseCliArgs(process.argv.slice(2));
	if (cliArgs.command === "help") {
		console.log(getHelpText(cliArgs.commandName));
		return;
	}

	const config = loadConfig(cliArgs, process.env);
	const logger = createLogger(config.logLevel);
	const output = await runReview(config, logger);
	logger.json(`${JSON.stringify(output, null, 2)}\n`);
	if (shouldExitNonZeroForReview(output)) {
		process.exitCode = 1;
	}
}

if (import.meta.main) {
	main().catch((error) => {
		process.stderr.write(`${formatCliError(error)}\n`);
		process.exitCode = 1;
	});
}
