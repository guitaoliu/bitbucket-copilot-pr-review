import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";

import { omitUndefined } from "../shared/object.ts";
import { parseCliArgs } from "./args.ts";
import {
	getExplicitEnvOverrides,
	normalizeReportKey,
	parseEnvironment,
} from "./env.ts";
import type { ReviewerConfig } from "./types.ts";

function resolveRepoRoot(
	cliRepoRoot: string | undefined,
	envRepoRoot: string | undefined,
): string {
	const candidate = cliRepoRoot ?? envRepoRoot ?? process.cwd();
	const repoRoot = path.resolve(candidate);

	try {
		accessSync(repoRoot, fsConstants.R_OK);
	} catch {
		throw new Error(`Repository root is not readable: ${repoRoot}`);
	}

	return repoRoot;
}

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
): ReviewerConfig {
	const cli = parseCliArgs(argv);
	const parsedEnv = parseEnvironment(env);
	const explicitEnvOverrides = getExplicitEnvOverrides(env);
	const repoRoot = resolveRepoRoot(cli.repoRoot, parsedEnv.REPO_ROOT);
	const githubToken =
		parsedEnv.COPILOT_GITHUB_TOKEN ??
		parsedEnv.GH_TOKEN ??
		parsedEnv.GITHUB_TOKEN;
	const reportLink = parsedEnv.REPORT_LINK ?? parsedEnv.BUILD_URL;
	const reportKey = normalizeReportKey(parsedEnv.REPORT_KEY);
	const bitbucketCaCertPath =
		parsedEnv.BITBUCKET_CA_CERT_PATH !== undefined
			? resolveReadableFilePath(
					parsedEnv.BITBUCKET_CA_CERT_PATH,
					"BITBUCKET_CA_CERT_PATH",
				)
			: undefined;

	const auth =
		parsedEnv.BITBUCKET_AUTH_TYPE === "basic" ||
		(parsedEnv.BITBUCKET_TOKEN === undefined &&
			parsedEnv.BITBUCKET_USERNAME !== undefined &&
			parsedEnv.BITBUCKET_PASSWORD !== undefined)
			? {
					type: "basic" as const,
					username: parsedEnv.BITBUCKET_USERNAME as string,
					password: parsedEnv.BITBUCKET_PASSWORD as string,
				}
			: {
					type: "bearer" as const,
					token: parsedEnv.BITBUCKET_TOKEN as string,
				};

	const copilot = omitUndefined({
		model: parsedEnv.COPILOT_MODEL,
		githubToken,
		reasoningEffort: parsedEnv.COPILOT_REASONING_EFFORT,
		timeoutMs: parsedEnv.COPILOT_TIMEOUT_MS,
	}) satisfies ReviewerConfig["copilot"];

	const report = omitUndefined({
		key: reportKey,
		title: parsedEnv.REPORT_TITLE,
		reporter: parsedEnv.REPORTER_NAME,
		commentTag: parsedEnv.REPORT_COMMENT_TAG,
		commentStrategy: parsedEnv.REPORT_COMMENT_STRATEGY,
		link: reportLink,
	}) satisfies ReviewerConfig["report"];

	return omitUndefined({
		repoRoot,
		gitRemoteName: parsedEnv.GIT_REMOTE_NAME,
		logLevel: parsedEnv.LOG_LEVEL,
		bitbucket: {
			baseUrl: parsedEnv.BITBUCKET_BASE_URL,
			projectKey: parsedEnv.BITBUCKET_PROJECT_KEY,
			repoSlug: parsedEnv.BITBUCKET_REPO_SLUG,
			prId: parsedEnv.BITBUCKET_PR_ID,
			auth,
			tls: omitUndefined({
				caCertPath: bitbucketCaCertPath,
				insecureSkipVerify: parsedEnv.BITBUCKET_INSECURE_TLS,
			}),
		},
		copilot,
		report,
		review: {
			dryRun: cli.dryRun,
			forceReview: cli.forceReview || parsedEnv.REVIEW_FORCE,
			confirmRerun: cli.confirmRerun,
			maxFiles: parsedEnv.REVIEW_MAX_FILES,
			maxFindings: parsedEnv.REVIEW_MAX_FINDINGS,
			minConfidence: parsedEnv.REVIEW_MIN_CONFIDENCE,
			maxPatchChars: parsedEnv.REVIEW_MAX_PATCH_CHARS,
			defaultFileSliceLines: parsedEnv.REVIEW_DEFAULT_FILE_SLICE_LINES,
			maxFileSliceLines: parsedEnv.REVIEW_MAX_FILE_SLICE_LINES,
			ignorePaths: parsedEnv.REVIEW_IGNORE_PATHS ?? [],
		},
		ciSummaryPath: parsedEnv.CI_SUMMARY_PATH,
		internal: {
			explicitEnvOverrides,
		},
	}) satisfies ReviewerConfig;
}
