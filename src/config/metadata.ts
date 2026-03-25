import type {
	Confidence,
	LogLevel,
	PullRequestCommentStrategy,
	ReasoningEffort,
} from "./types.ts";

export const CONFIDENCE_VALUES = [
	"low",
	"medium",
	"high",
] as const satisfies readonly Confidence[];

export const LOG_LEVEL_VALUES = [
	"debug",
	"info",
	"warn",
	"error",
] as const satisfies readonly LogLevel[];

export const BITBUCKET_AUTH_TYPE_VALUES = ["basic", "bearer"] as const;

export const REASONING_EFFORT_VALUES = [
	"low",
	"medium",
	"high",
	"xhigh",
] as const satisfies readonly ReasoningEffort[];

export const REPORT_COMMENT_STRATEGY_VALUES = [
	"update",
	"recreate",
] as const satisfies readonly PullRequestCommentStrategy[];

export interface ConfigFieldMetadata {
	path: string;
	env?: string;
	description: string;
	envParser?: ConfigFieldEnvParser;
	repoOverride?: true;
	docs?: {
		order: number;
		defaultValuePath?: readonly string[];
		defaultText?: string;
	};
}

export type ConfigFieldEnvParser =
	| {
			kind: "string";
	  }
	| {
			kind: "enum";
			values: readonly [string, ...string[]];
	  }
	| {
			kind: "positiveInteger";
	  }
	| {
			kind: "boolean";
	  }
	| {
			kind: "stringArray";
	  };

export type ConfigFieldEnvValue<TParser extends ConfigFieldEnvParser> =
	TParser extends { kind: "string" }
		? string | undefined
		: TParser extends {
					kind: "enum";
					values: readonly [string, ...string[]];
				}
			? TParser["values"][number] | undefined
			: TParser extends { kind: "positiveInteger" }
				? number | undefined
				: TParser extends { kind: "boolean" }
					? boolean | undefined
					: TParser extends { kind: "stringArray" }
						? string[] | undefined
						: never;

export type EnvConfigFieldMetadata<
	TParser extends ConfigFieldEnvParser = ConfigFieldEnvParser,
> = ConfigFieldMetadata & {
	env: string;
	envParser: TParser;
};

export type RepoOverrideFieldMetadata = ConfigFieldMetadata & {
	repoOverride: true;
};

export type EnvRepoOverrideFieldMetadata = EnvConfigFieldMetadata & {
	repoOverride: true;
};

export interface CliOptionMetadata {
	flags: readonly [string, ...string[]];
	description: string;
	valueLabel?: string;
}

export interface CliCommandMetadata {
	usage: string;
	description: string;
	argumentLabel?: string;
	argumentDescription?: string;
}

export interface ReviewCliOptionMetadataMap {
	dryRun: CliOptionMetadata;
	forceReview: CliOptionMetadata;
	confirmRerun: CliOptionMetadata;
	repoRoot: CliOptionMetadata;
	help: CliOptionMetadata;
}

export interface BatchCliOptionMetadataMap {
	dryRun: CliOptionMetadata;
	forceReview: CliOptionMetadata;
	tempRoot: CliOptionMetadata;
	maxParallel: CliOptionMetadata;
	keepWorkdirs: CliOptionMetadata;
	help: CliOptionMetadata;
}

export function isEnvConfigField(
	field: ConfigFieldMetadata,
): field is EnvConfigFieldMetadata {
	return field.env !== undefined && field.envParser !== undefined;
}

export function isRepoOverrideField(
	field: ConfigFieldMetadata,
): field is RepoOverrideFieldMetadata {
	return field.repoOverride === true;
}

export function isEnvRepoOverrideField(
	field: ConfigFieldMetadata,
): field is EnvRepoOverrideFieldMetadata {
	return isEnvConfigField(field) && isRepoOverrideField(field);
}

function envDoc(
	order: number,
	options: {
		defaultValuePath?: readonly string[];
		defaultText?: string;
	} = {},
) {
	return {
		docs: {
			order,
			...options,
		},
	};
}

function envParser<TParser extends ConfigFieldEnvParser>(parser: TParser) {
	return {
		envParser: parser,
	};
}

function repoOverride() {
	return {
		repoOverride: true as const,
	};
}

export const CONFIG_FIELD_METADATA = {
	repoRoot: {
		path: "repoRoot",
		env: "REPO_ROOT",
		description: "Path to the repository under review.",
		...envParser({ kind: "string" }),
		...envDoc(9, { defaultText: "current working directory" }),
	},
	gitRemoteName: {
		path: "gitRemoteName",
		env: "GIT_REMOTE_NAME",
		description: "Git remote name used to fetch PR commits.",
		...envParser({ kind: "string" }),
		...envDoc(10, { defaultValuePath: ["gitRemoteName"] }),
	},
	logLevel: {
		path: "logLevel",
		env: "LOG_LEVEL",
		description: "Logger verbosity.",
		...envParser({ kind: "enum", values: LOG_LEVEL_VALUES }),
		...envDoc(11, { defaultValuePath: ["logLevel"] }),
	},
	bitbucketAuthType: {
		path: "bitbucket.auth.type",
		env: "BITBUCKET_AUTH_TYPE",
		description: "Bitbucket authentication strategy.",
		...envParser({ kind: "enum", values: BITBUCKET_AUTH_TYPE_VALUES }),
		...envDoc(12, { defaultText: "auto-detected from provided credentials" }),
	},
	bitbucketToken: {
		path: "bitbucket.auth.token",
		env: "BITBUCKET_TOKEN",
		description: "Bitbucket bearer token.",
		...envParser({ kind: "string" }),
		...envDoc(6, { defaultText: "required unless basic auth vars are used" }),
	},
	bitbucketUsername: {
		path: "bitbucket.auth.username",
		env: "BITBUCKET_USERNAME",
		description: "Bitbucket basic auth username.",
		...envParser({ kind: "string" }),
		...envDoc(7, {
			defaultText: "required with `BITBUCKET_PASSWORD` for basic auth",
		}),
	},
	bitbucketPassword: {
		path: "bitbucket.auth.password",
		env: "BITBUCKET_PASSWORD",
		description: "Bitbucket basic auth password.",
		...envParser({ kind: "string" }),
		...envDoc(8, {
			defaultText: "required with `BITBUCKET_USERNAME` for basic auth",
		}),
	},
	bitbucketCaCertPath: {
		path: "bitbucket.tls.caCertPath",
		env: "BITBUCKET_CA_CERT_PATH",
		description: "PEM CA bundle path for Bitbucket TLS.",
		...envParser({ kind: "string" }),
		...envDoc(13, { defaultText: "-" }),
	},
	bitbucketInsecureTls: {
		path: "bitbucket.tls.insecureSkipVerify",
		env: "BITBUCKET_INSECURE_TLS",
		description: "Skip strict TLS verification for Bitbucket.",
		...envParser({ kind: "boolean" }),
		...envDoc(14, {
			defaultValuePath: ["bitbucket", "tls", "insecureSkipVerify"],
		}),
	},
	copilotModel: {
		path: "copilot.model",
		env: "COPILOT_MODEL",
		description: "Copilot model override.",
		...envParser({ kind: "string" }),
		...repoOverride(),
		...envDoc(15, { defaultValuePath: ["copilot", "model"] }),
	},
	copilotReasoningEffort: {
		path: "copilot.reasoningEffort",
		env: "COPILOT_REASONING_EFFORT",
		description: "Copilot reasoning effort.",
		...envParser({ kind: "enum", values: REASONING_EFFORT_VALUES }),
		...repoOverride(),
		...envDoc(16, { defaultValuePath: ["copilot", "reasoningEffort"] }),
	},
	copilotTimeoutMs: {
		path: "copilot.timeoutMs",
		env: "COPILOT_TIMEOUT_MS",
		description: "Copilot timeout in milliseconds.",
		...envParser({ kind: "positiveInteger" }),
		...repoOverride(),
		...envDoc(17, { defaultValuePath: ["copilot", "timeoutMs"] }),
	},
	reportKey: {
		path: "report.key",
		env: "REPORT_KEY",
		description: "Code Insights report key.",
		...envParser({ kind: "string" }),
		...envDoc(19, { defaultValuePath: ["report", "key"] }),
	},
	reportTitle: {
		path: "report.title",
		env: "REPORT_TITLE",
		description: "Code Insights report title.",
		...envParser({ kind: "string" }),
		...repoOverride(),
		...envDoc(20, { defaultValuePath: ["report", "title"] }),
	},
	reporterName: {
		path: "report.reporter",
		env: "REPORTER_NAME",
		description: "Displayed report publisher name.",
		...envParser({ kind: "string" }),
		...envDoc(21, { defaultValuePath: ["report", "reporter"] }),
	},
	reportCommentTag: {
		path: "report.commentTag",
		env: "REPORT_COMMENT_TAG",
		description: "Tag used to locate the PR summary comment.",
		...envParser({ kind: "string" }),
		...envDoc(22, { defaultValuePath: ["report", "commentTag"] }),
	},
	reportCommentStrategy: {
		path: "report.commentStrategy",
		env: "REPORT_COMMENT_STRATEGY",
		description: "How the tagged PR summary comment is updated.",
		...envParser({ kind: "enum", values: REPORT_COMMENT_STRATEGY_VALUES }),
		...repoOverride(),
		...envDoc(23, { defaultValuePath: ["report", "commentStrategy"] }),
	},
	reportLink: {
		path: "report.link",
		env: "REPORT_LINK",
		description: "Code Insights report link.",
		...envParser({ kind: "string" }),
		...envDoc(24, { defaultText: "falls back to `BUILD_URL` when present" }),
	},
	buildUrl: {
		path: "report.link",
		env: "BUILD_URL",
		description: "Fallback report link from CI build URL.",
		...envParser({ kind: "string" }),
		...envDoc(24.1, { defaultText: "used when `REPORT_LINK` is unset" }),
	},
	reviewDryRun: {
		path: "review.dryRun",
		description: "Run without publishing results to Bitbucket.",
	},
	reviewForce: {
		path: "review.forceReview",
		env: "REVIEW_FORCE",
		description: "Force review even when the revision was already published.",
		...envParser({ kind: "boolean" }),
		...envDoc(25, { defaultValuePath: ["review", "forceReview"] }),
	},
	reviewConfirmRerun: {
		path: "review.confirmRerun",
		description: "Prompt before rerunning unusable cached artifacts.",
	},
	reviewMaxFiles: {
		path: "review.maxFiles",
		env: "REVIEW_MAX_FILES",
		description: "Maximum number of changed files to review.",
		...envParser({ kind: "positiveInteger" }),
		...repoOverride(),
		...envDoc(26, { defaultValuePath: ["review", "maxFiles"] }),
	},
	reviewMaxFindings: {
		path: "review.maxFindings",
		env: "REVIEW_MAX_FINDINGS",
		description: "Maximum number of findings to publish.",
		...envParser({ kind: "positiveInteger" }),
		...repoOverride(),
		...envDoc(27, { defaultValuePath: ["review", "maxFindings"] }),
	},
	reviewMinConfidence: {
		path: "review.minConfidence",
		env: "REVIEW_MIN_CONFIDENCE",
		description: "Minimum confidence threshold for findings.",
		...envParser({ kind: "enum", values: CONFIDENCE_VALUES }),
		...repoOverride(),
		...envDoc(28, { defaultValuePath: ["review", "minConfidence"] }),
	},
	reviewMaxPatchChars: {
		path: "review.maxPatchChars",
		env: "REVIEW_MAX_PATCH_CHARS",
		description: "Maximum diff size sent to Copilot per file.",
		...envParser({ kind: "positiveInteger" }),
		...repoOverride(),
		...envDoc(29, { defaultValuePath: ["review", "maxPatchChars"] }),
	},
	reviewDefaultFileSliceLines: {
		path: "review.defaultFileSliceLines",
		env: "REVIEW_DEFAULT_FILE_SLICE_LINES",
		description: "Default line window when reading file slices.",
		...envParser({ kind: "positiveInteger" }),
		...repoOverride(),
		...envDoc(30, { defaultValuePath: ["review", "defaultFileSliceLines"] }),
	},
	reviewMaxFileSliceLines: {
		path: "review.maxFileSliceLines",
		env: "REVIEW_MAX_FILE_SLICE_LINES",
		description: "Maximum line window for file slices.",
		...envParser({ kind: "positiveInteger" }),
		...repoOverride(),
		...envDoc(31, { defaultValuePath: ["review", "maxFileSliceLines"] }),
	},
	reviewIgnorePaths: {
		path: "review.ignorePaths",
		env: "REVIEW_IGNORE_PATHS",
		description: "Comma-separated repo-relative glob patterns to skip.",
		...envParser({ kind: "stringArray" }),
		...repoOverride(),
		...envDoc(32, { defaultValuePath: ["review", "ignorePaths"] }),
	},
	reviewSkipBranchPrefixes: {
		path: "review.skipBranchPrefixes",
		env: "REVIEW_SKIP_BRANCH_PREFIXES",
		description:
			"Comma-separated source branch prefixes that should be skipped.",
		...envParser({ kind: "stringArray" }),
		...repoOverride(),
		...envDoc(33, { defaultValuePath: ["review", "skipBranchPrefixes"] }),
	},
	ciSummaryPath: {
		path: "ciSummaryPath",
		env: "CI_SUMMARY_PATH",
		description: "Path to a CI summary file included in review context.",
		...envParser({ kind: "string" }),
		...envDoc(18, { defaultText: "-" }),
	},
} as const satisfies Record<string, ConfigFieldMetadata>;

const HELP_CLI_OPTION_METADATA = {
	flags: ["-h", "--help"],
	description: "Show this help text",
} as const satisfies CliOptionMetadata;

export const CLI_COMMAND_METADATA = {
	review: {
		usage: "review <pull-request-url> [options]",
		description: "Review one pull request from an explicit Bitbucket URL",
		argumentLabel: "<pull-request-url>",
		argumentDescription:
			"Bitbucket pull request URL, for example https://host/projects/PROJ/repos/repo/pull-requests/123.",
	},
	batch: {
		usage: "batch <repository-url> [options]",
		description:
			"Review all open pull requests for one Bitbucket repository URL",
		argumentLabel: "<repository-url>",
		argumentDescription:
			"Bitbucket repository URL, for example https://host/projects/PROJ/repos/my-repo.",
	},
} as const satisfies Record<string, CliCommandMetadata>;

export const REVIEW_CLI_OPTION_METADATA: ReviewCliOptionMetadataMap = {
	dryRun: {
		flags: ["--dry-run"],
		description: "Run without publishing results to Bitbucket",
	},
	forceReview: {
		flags: ["--force-review"],
		description:
			"Re-run even if the current PR revision already has published results",
	},
	confirmRerun: {
		flags: ["--confirm-rerun"],
		description:
			"Ask before rerunning unusable cached artifacts for an unchanged PR revision",
	},
	repoRoot: {
		flags: ["--repo-root"],
		description: "Use a different local checkout as the repository root",
		valueLabel: "<path>",
	},
	help: HELP_CLI_OPTION_METADATA,
};

export const BATCH_CLI_OPTION_METADATA: BatchCliOptionMetadataMap = {
	dryRun: {
		flags: ["--dry-run"],
		description: "Run without publishing results to Bitbucket",
	},
	forceReview: {
		flags: ["--force-review"],
		description:
			"Re-run even if the current PR revision already has published results",
	},
	tempRoot: {
		flags: ["--temp-root"],
		description: "Parent directory for mirror and workspace clones",
		valueLabel: "<path>",
	},
	maxParallel: {
		flags: ["--max-parallel"],
		description: "Maximum concurrent review workers",
		valueLabel: "<count>",
	},
	keepWorkdirs: {
		flags: ["--keep-workdirs"],
		description: "Keep per-PR workdirs after the run completes",
	},
	help: HELP_CLI_OPTION_METADATA,
};
