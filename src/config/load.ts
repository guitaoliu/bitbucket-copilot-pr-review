import { accessSync, constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { BatchReviewConfig } from "../batch/types.ts";
import { omitUndefined } from "../shared/object.ts";
import type { CliOptions } from "./args.ts";
import { parseCliArgs } from "./args.ts";
import {
	resolveBitbucketAuth,
	resolveBitbucketConfig,
} from "./bitbucket-resolver.ts";
import { REVIEWER_CONFIG_DEFAULTS } from "./defaults.ts";
import {
	getEnvRepoOverrides,
	getRequiredEnvValue,
	parseEnvironment,
} from "./env.ts";
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

function parseRepoId(repoId: string): { projectKey: string; repoSlug: string } {
	const trimmed = repoId.trim();
	const segments = trimmed.split("/").map((segment) => segment.trim());
	if (
		segments.length !== 2 ||
		segments.some((segment) => segment.length === 0)
	) {
		throw new Error(
			`--repo-id must use the format <project/repo>, received ${JSON.stringify(repoId)}.`,
		);
	}

	const [projectKey, repoSlug] = segments;
	if (projectKey === undefined || repoSlug === undefined) {
		throw new Error(
			`--repo-id must use the format <project/repo>, received ${JSON.stringify(repoId)}.`,
		);
	}

	return { projectKey, repoSlug };
}

export function loadConfig(
	argv = process.argv.slice(2),
	env: NodeJS.ProcessEnv = process.env,
	cliOptions: CliOptions = parseCliArgs(argv),
): ReviewerConfig {
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
		bitbucket: resolveBitbucketConfig(
			parsedEnv,
			runtimeGroups.bitbucket,
			omitUndefined({
				caCertPath: bitbucketCaCertPath,
			}),
		),
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
	cliOptions: CliOptions = parseCliArgs(argv),
): BatchReviewConfig {
	if (!cliOptions.repoId) {
		throw new Error("--repo-id is required for batch repository review mode.");
	}

	if (cliOptions.repoRoot !== undefined) {
		throw new Error("--repo-root cannot be used together with --repo-id.");
	}

	if (cliOptions.confirmRerun) {
		throw new Error(
			"--confirm-rerun is not supported in batch repository review mode.",
		);
	}

	const parsedEnv = parseEnvironment(env);
	const bitbucketCaCertPath =
		parsedEnv.BITBUCKET_CA_CERT_PATH !== undefined
			? resolveReadableFilePath(
					parsedEnv.BITBUCKET_CA_CERT_PATH,
					"BITBUCKET_CA_CERT_PATH",
				)
			: undefined;
	const { projectKey, repoSlug } = parseRepoId(cliOptions.repoId);
	const tempRoot =
		cliOptions.tempRoot !== undefined
			? path.resolve(cliOptions.tempRoot)
			: path.join(tmpdir(), "bitbucket-copilot-pr-review");

	return {
		repoId: cliOptions.repoId,
		tempRoot,
		maxParallel: cliOptions.maxParallel ?? 2,
		keepWorkdirs: cliOptions.keepWorkdirs ?? false,
		gitRemoteName:
			parsedEnv.GIT_REMOTE_NAME ?? REVIEWER_CONFIG_DEFAULTS.gitRemoteName,
		logLevel: parsedEnv.LOG_LEVEL ?? REVIEWER_CONFIG_DEFAULTS.logLevel,
		bitbucket: {
			baseUrl: getRequiredEnvValue(parsedEnv, "BITBUCKET_BASE_URL"),
			projectKey,
			repoSlug,
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
