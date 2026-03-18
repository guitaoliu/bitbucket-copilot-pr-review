import { accessSync, constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { BatchReviewConfig } from "../batch/types.ts";
import { omitUndefined } from "../shared/object.ts";
import type { BatchCliOptions, ReviewCliOptions } from "./args.ts";
import { isBatchCliOptions, isReviewCliOptions, parseCliArgs } from "./args.ts";
import {
	parseBitbucketPullRequestUrl,
	parseBitbucketRepositoryUrl,
	resolveBitbucketAuth,
	resolveBitbucketConfig,
} from "./bitbucket-resolver.ts";
import { REVIEWER_CONFIG_DEFAULTS } from "./defaults.ts";
import { getEnvRepoOverrides, parseEnvironment } from "./env.ts";
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
		throw new Error(`${label} is not readable: ${resolvedPath}`);
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
			throw new Error("review command options are required.");
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

export function loadBatchConfig(
	argv = process.argv.slice(2),
	env: NodeJS.ProcessEnv = process.env,
	cliOptions: BatchCliOptions = (() => {
		const parsed = parseCliArgs(
			argv[0] === "batch" ? argv : ["batch", ...argv],
		);
		if (!isBatchCliOptions(parsed)) {
			throw new Error("batch command options are required.");
		}

		return parsed;
	})(),
): BatchReviewConfig {
	const parsedEnv = parseEnvironment(env);
	const repositoryLocation = parseBitbucketRepositoryUrl(
		cliOptions.repositoryUrl,
	);
	const bitbucketCaCertPath =
		parsedEnv.BITBUCKET_CA_CERT_PATH !== undefined
			? resolveReadableFilePath(
					parsedEnv.BITBUCKET_CA_CERT_PATH,
					"BITBUCKET_CA_CERT_PATH",
				)
			: undefined;
	const tempRoot =
		cliOptions.tempRoot !== undefined
			? path.resolve(cliOptions.tempRoot)
			: path.join(tmpdir(), "bitbucket-copilot-pr-review");

	return {
		repoId: `${repositoryLocation.projectKey}/${repositoryLocation.repoSlug}`,
		repositoryUrl: repositoryLocation.repositoryUrl,
		tempRoot,
		maxParallel: cliOptions.maxParallel ?? 2,
		keepWorkdirs: cliOptions.keepWorkdirs ?? false,
		gitRemoteName:
			parsedEnv.GIT_REMOTE_NAME ?? REVIEWER_CONFIG_DEFAULTS.gitRemoteName,
		logLevel: parsedEnv.LOG_LEVEL ?? REVIEWER_CONFIG_DEFAULTS.logLevel,
		bitbucket: {
			baseUrl: repositoryLocation.baseUrl,
			projectKey: repositoryLocation.projectKey,
			repoSlug: repositoryLocation.repoSlug,
			auth: resolveBitbucketAuth(parsedEnv),
			tls: omitUndefined({
				caCertPath: bitbucketCaCertPath,
				insecureSkipVerify:
					parsedEnv.BITBUCKET_INSECURE_TLS ??
					REVIEWER_CONFIG_DEFAULTS.bitbucket.tls.insecureSkipVerify,
			}),
		},
		review: {
			dryRun: cliOptions.dryRun,
			forceReview:
				cliOptions.forceReview ||
				parsedEnv.REVIEW_FORCE ||
				REVIEWER_CONFIG_DEFAULTS.review.forceReview,
			confirmRerun: REVIEWER_CONFIG_DEFAULTS.review.confirmRerun,
			skipBranchPrefixes:
				parsedEnv.REVIEW_SKIP_BRANCH_PREFIXES ??
				REVIEWER_CONFIG_DEFAULTS.review.skipBranchPrefixes,
		},
		internal: {
			envRepoOverrides: cloneRepoOverrides(getEnvRepoOverrides(parsedEnv)),
		},
	};
}
