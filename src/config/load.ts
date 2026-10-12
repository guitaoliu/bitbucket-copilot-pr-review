import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";

import type { ReviewCliOptions } from "./args.ts";
import { parseEnvironment } from "./env.ts";
import { CliUserError } from "./errors.ts";
import { ENV_VARIABLES } from "./metadata.ts";
import { parseBitbucketPullRequestUrl } from "./pull-request-url.ts";
import type { RepoReviewConfig } from "./repo-config.ts";
import type { OperatorConfig, ReviewerConfig } from "./types.ts";

const MAX_REPORT_KEY_LENGTH = 50;

function resolveReadablePath(filePath: string, label: string): string {
	const resolvedPath = path.resolve(filePath);
	try {
		accessSync(resolvedPath, fsConstants.R_OK);
	} catch {
		throw new CliUserError(`${label} is not readable: ${resolvedPath}`);
	}

	return resolvedPath;
}

/** Bitbucket Data Center rejects report keys that are long or contain unsafe characters. */
function normalizeReportKey(reportKey: string): string {
	const sanitized = reportKey
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "");
	if (sanitized.length === 0) {
		return ENV_VARIABLES.REPORT_KEY.default;
	}

	if (sanitized.length <= MAX_REPORT_KEY_LENGTH) {
		return sanitized;
	}

	const suffix = `-${createHash("sha1").update(sanitized).digest("hex").slice(0, 10)}`;
	return `${sanitized.slice(0, MAX_REPORT_KEY_LENGTH - suffix.length)}${suffix}`;
}

/**
 * Resolves everything the operator controls through CLI flags and environment
 * variables. Repo-overridable fields stay unset unless the operator set them;
 * `resolveReviewerConfig` fills them from the trusted repo config or defaults.
 */
export function loadConfig(
	cliOptions: ReviewCliOptions,
	env: NodeJS.ProcessEnv,
): OperatorConfig {
	const location = parseBitbucketPullRequestUrl(cliOptions.pullRequestUrl);
	const settings = parseEnvironment(env);

	return {
		repoRoot: resolveReadablePath(
			cliOptions.repoRoot ?? settings.REPO_ROOT ?? process.cwd(),
			"Repository root",
		),
		gitRemoteName:
			settings.GIT_REMOTE_NAME ?? ENV_VARIABLES.GIT_REMOTE_NAME.default,
		logLevel: settings.LOG_LEVEL ?? ENV_VARIABLES.LOG_LEVEL.default,
		githubHost: settings.GH_HOST,
		bitbucket: {
			...location,
			auth: settings.auth,
			tls: {
				caCertPath:
					settings.BITBUCKET_CA_CERT_PATH === undefined
						? undefined
						: resolveReadablePath(
								settings.BITBUCKET_CA_CERT_PATH,
								"BITBUCKET_CA_CERT_PATH",
							),
				insecureSkipVerify:
					settings.BITBUCKET_INSECURE_TLS ??
					ENV_VARIABLES.BITBUCKET_INSECURE_TLS.default,
			},
		},
		copilot: {
			model: settings.COPILOT_MODEL,
			reasoningEffort: settings.COPILOT_REASONING_EFFORT,
			timeoutMs: settings.COPILOT_TIMEOUT_MS,
			runtimeLogDir:
				settings.COPILOT_RUNTIME_LOG_DIR === undefined
					? undefined
					: path.resolve(settings.COPILOT_RUNTIME_LOG_DIR),
		},
		report: {
			key: normalizeReportKey(
				settings.REPORT_KEY ?? ENV_VARIABLES.REPORT_KEY.default,
			),
			title: settings.REPORT_TITLE,
			reporter: settings.REPORTER_NAME ?? ENV_VARIABLES.REPORTER_NAME.default,
			link: settings.REPORT_LINK ?? settings.BUILD_URL,
			commentTag:
				settings.REPORT_COMMENT_TAG ?? ENV_VARIABLES.REPORT_COMMENT_TAG.default,
			commentStrategy: settings.REPORT_COMMENT_STRATEGY,
		},
		review: {
			dryRun: cliOptions.dryRun,
			forceReview:
				cliOptions.forceReview ||
				(settings.REVIEW_FORCE ?? ENV_VARIABLES.REVIEW_FORCE.default),
			confirmRerun: cliOptions.confirmRerun,
			minConfidence: settings.REVIEW_MIN_CONFIDENCE,
			ignorePaths: settings.REVIEW_IGNORE_PATHS,
			skipBranchPrefixes: settings.REVIEW_SKIP_BRANCH_PREFIXES,
		},
		ciSummaryPath: settings.CI_SUMMARY_PATH,
	};
}

/** Precedence for repo-overridable fields: operator (CLI/env) > trusted repo config > default. */
export function resolveReviewerConfig(
	operator: OperatorConfig,
	repoConfig?: RepoReviewConfig,
): ReviewerConfig {
	const { copilot, report, review } = operator;
	return {
		...operator,
		copilot: {
			...copilot,
			model:
				copilot.model ??
				repoConfig?.copilot?.model ??
				ENV_VARIABLES.COPILOT_MODEL.default,
			reasoningEffort:
				copilot.reasoningEffort ??
				repoConfig?.copilot?.reasoningEffort ??
				ENV_VARIABLES.COPILOT_REASONING_EFFORT.default,
			timeoutMs:
				copilot.timeoutMs ??
				repoConfig?.copilot?.timeoutMs ??
				ENV_VARIABLES.COPILOT_TIMEOUT_MS.default,
		},
		report: {
			...report,
			title:
				report.title ??
				repoConfig?.report?.title ??
				ENV_VARIABLES.REPORT_TITLE.default,
			commentStrategy:
				report.commentStrategy ??
				repoConfig?.report?.commentStrategy ??
				ENV_VARIABLES.REPORT_COMMENT_STRATEGY.default,
		},
		review: {
			...review,
			minConfidence:
				review.minConfidence ??
				repoConfig?.review?.minConfidence ??
				ENV_VARIABLES.REVIEW_MIN_CONFIDENCE.default,
			ignorePaths: review.ignorePaths ??
				repoConfig?.review?.ignorePaths ?? [
					...ENV_VARIABLES.REVIEW_IGNORE_PATHS.default,
				],
			skipBranchPrefixes: review.skipBranchPrefixes ??
				repoConfig?.review?.skipBranchPrefixes ?? [
					...ENV_VARIABLES.REVIEW_SKIP_BRANCH_PREFIXES.default,
				],
		},
	};
}
