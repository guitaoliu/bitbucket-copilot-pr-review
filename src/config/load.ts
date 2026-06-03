import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";

import { omitUndefined } from "../shared/object.ts";
import type { ReviewCliOptions } from "./args.ts";
import { isReviewCliOptions, parseCliArgs } from "./args.ts";
import {
	parseBitbucketPullRequestUrl,
	resolveBitbucketConfig,
} from "./bitbucket-resolver.ts";
import { getEnvRepoOverrides, parseEnvironment } from "./env.ts";
import { CliUserError } from "./errors.ts";
import {
	cloneRepoOverrides,
	validateReviewerConfig,
} from "./reviewer-config.ts";
import { resolveRuntimeConfigGroups } from "./runtime-resolver.ts";
import type { ReviewerConfig } from "./types.ts";

function resolveReadableFilePath(filePath: string, label: string): string {
	const resolvedPath = path.resolve(filePath);

	try {
		accessSync(resolvedPath, fsConstants.R_OK);
	} catch {
		throw new CliUserError(`${label} is not readable: ${resolvedPath}`);
	}

	return resolvedPath;
}

export function loadConfig(
	argv = process.argv.slice(2),
	env: NodeJS.ProcessEnv = process.env,
	cliOptions: ReviewCliOptions = (() => {
		const parsed = parseCliArgs(
			argv[0] === "review" ? argv : ["review", ...argv],
		);
		if (!isReviewCliOptions(parsed)) {
			throw new CliUserError("review command options are required.");
		}

		return parsed;
	})(),
): ReviewerConfig {
	const pullRequestLocation = parseBitbucketPullRequestUrl(
		cliOptions.pullRequestUrl,
	);
	const parsedEnv = parseEnvironment(env);
	const envRepoOverrides = getEnvRepoOverrides(parsedEnv);
	const runtimeGroups = resolveRuntimeConfigGroups(parsedEnv, cliOptions);
	const bitbucketCaCertPath =
		parsedEnv.BITBUCKET_CA_CERT_PATH !== undefined
			? resolveReadableFilePath(
					parsedEnv.BITBUCKET_CA_CERT_PATH,
					"BITBUCKET_CA_CERT_PATH",
				)
			: undefined;

	return validateReviewerConfig({
		repoRoot: runtimeGroups.repoRoot,
		gitRemoteName: runtimeGroups.gitRemoteName,
		logLevel: runtimeGroups.logLevel,
		...(runtimeGroups.githubHost !== undefined
			? { githubHost: runtimeGroups.githubHost }
			: {}),
		bitbucket: resolveBitbucketConfig({
			location: pullRequestLocation,
			env: parsedEnv,
			runtimeConfig: runtimeGroups.bitbucket,
			...(bitbucketCaCertPath !== undefined
				? { caCertPath: bitbucketCaCertPath }
				: {}),
		}),
		copilot: omitUndefined(runtimeGroups.copilot),
		report: omitUndefined(runtimeGroups.report),
		review: runtimeGroups.review,
		...(runtimeGroups.ciSummaryPath !== undefined
			? { ciSummaryPath: runtimeGroups.ciSummaryPath }
			: {}),
		internal: {
			envRepoOverrides: cloneRepoOverrides(envRepoOverrides),
		},
	});
}
