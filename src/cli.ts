import process from "node:process";

import { getHelpText, parseCliArgs } from "./config/args.ts";
import { loadConfig } from "./config/load.ts";
import { runReview } from "./review/runner.ts";
import { createLogger } from "./shared/logger.ts";

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const cliOptions = parseCliArgs(argv);
	if (cliOptions.help) {
		console.log(getHelpText());
		return;
	}

	const config = loadConfig(argv, process.env, cliOptions);
	const logger = createLogger(config.logLevel);
	const output = await runReview(config, logger);
	delete config.internal;
	logger.json(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
	process.stderr.write(
		`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
	);
	process.exitCode = 1;
});
