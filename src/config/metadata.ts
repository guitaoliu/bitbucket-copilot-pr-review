import { CONFIDENCE_VALUES } from "../policy/types.ts";
import { LOG_LEVEL_VALUES } from "../shared/types.ts";
import {
	BITBUCKET_AUTH_TYPE_VALUES,
	REASONING_EFFORT_VALUES,
	REPORT_COMMENT_STRATEGY_VALUES,
} from "./types.ts";

export type EnvParser =
	| { kind: "string" }
	| { kind: "host" }
	| { kind: "enum"; values: readonly [string, ...string[]] }
	| { kind: "positiveInteger" }
	| { kind: "boolean" }
	| { kind: "stringArray" };

export type EnvDefaultValue = string | number | boolean | readonly string[];

/**
 * `default` is the built-in value used when neither the operator nor the
 * trusted repo config sets the field; `docsDefault` documents variables
 * without a static default.
 */
export type EnvVariableMetadata = {
	parser: EnvParser;
	description: string;
} & ({ default: EnvDefaultValue } | { docsDefault: string });

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

type CliCommandName = "review";

type ReviewCliOptionName =
	| "dryRun"
	| "forceReview"
	| "confirmRerun"
	| "repoRoot"
	| "help";

const STRING_PARSER = { kind: "string" } as const;

/** Declaration order is the order of the generated docs table. */
export const ENV_VARIABLES = {
	BITBUCKET_TOKEN: {
		parser: STRING_PARSER,
		description: "Bitbucket bearer token.",
		docsDefault: "required unless basic auth vars are used",
	},
	BITBUCKET_USERNAME: {
		parser: STRING_PARSER,
		description: "Bitbucket basic auth username.",
		docsDefault: "required with `BITBUCKET_PASSWORD` for basic auth",
	},
	BITBUCKET_PASSWORD: {
		parser: STRING_PARSER,
		description: "Bitbucket basic auth password.",
		docsDefault: "required with `BITBUCKET_USERNAME` for basic auth",
	},
	REPO_ROOT: {
		parser: STRING_PARSER,
		description: "Path to the repository under review.",
		docsDefault: "current working directory",
	},
	GIT_REMOTE_NAME: {
		parser: STRING_PARSER,
		description: "Git remote name used to fetch PR commits.",
		default: "origin",
	},
	LOG_LEVEL: {
		parser: { kind: "enum", values: LOG_LEVEL_VALUES },
		description: "Logger verbosity.",
		default: "info",
	},
	GH_HOST: {
		parser: { kind: "host" },
		description:
			"GitHub host used for Copilot authentication and API requests, for example `mycompany.ghe.com`.",
		docsDefault: "`github.com`",
	},
	BITBUCKET_AUTH_TYPE: {
		parser: { kind: "enum", values: BITBUCKET_AUTH_TYPE_VALUES },
		description: "Bitbucket authentication strategy.",
		docsDefault: "auto-detected from provided credentials",
	},
	BITBUCKET_CA_CERT_PATH: {
		parser: STRING_PARSER,
		description: "PEM CA bundle path for Bitbucket TLS.",
		docsDefault: "-",
	},
	BITBUCKET_INSECURE_TLS: {
		parser: { kind: "boolean" },
		description:
			"Disable TLS certificate verification for Bitbucket (not recommended).",
		default: false,
	},
	COPILOT_MODEL: {
		parser: STRING_PARSER,
		description: "Copilot model override.",
		default: "gpt-5.6-sol",
	},
	COPILOT_REASONING_EFFORT: {
		parser: { kind: "enum", values: REASONING_EFFORT_VALUES },
		description: "Copilot reasoning effort.",
		default: "medium",
	},
	COPILOT_TIMEOUT_MS: {
		parser: { kind: "positiveInteger" },
		description: "Copilot timeout in milliseconds.",
		default: 1_800_000,
	},
	CI_SUMMARY_PATH: {
		parser: STRING_PARSER,
		description: "Path to a CI summary file included in review context.",
		docsDefault: "-",
	},
	REPORT_KEY: {
		parser: STRING_PARSER,
		description: "Code Insights report key.",
		default: "copilot-pr-review",
	},
	REPORT_TITLE: {
		parser: STRING_PARSER,
		description: "Code Insights report title.",
		default: "Copilot PR Review",
	},
	REPORTER_NAME: {
		parser: STRING_PARSER,
		description: "Displayed report publisher name.",
		default: "GitHub Copilot",
	},
	REPORT_COMMENT_TAG: {
		parser: STRING_PARSER,
		description: "Tag used to locate the PR summary comment.",
		default: "copilot-pr-review",
	},
	REPORT_COMMENT_STRATEGY: {
		parser: { kind: "enum", values: REPORT_COMMENT_STRATEGY_VALUES },
		description: "How the tagged PR summary comment is updated.",
		default: "recreate",
	},
	REPORT_LINK: {
		parser: STRING_PARSER,
		description: "Code Insights report link.",
		docsDefault: "falls back to `BUILD_URL` when present",
	},
	BUILD_URL: {
		parser: STRING_PARSER,
		description: "Fallback report link from CI build URL.",
		docsDefault: "used when `REPORT_LINK` is unset",
	},
	REVIEW_FORCE: {
		parser: { kind: "boolean" },
		description: "Force review even when the revision was already published.",
		default: false,
	},
	REVIEW_MIN_CONFIDENCE: {
		parser: { kind: "enum", values: CONFIDENCE_VALUES },
		description: "Minimum confidence threshold for findings.",
		default: "medium",
	},
	REVIEW_IGNORE_PATHS: {
		parser: { kind: "stringArray" },
		description:
			"Comma-separated repo-relative glob patterns excluded from reportable finding scope.",
		default: [],
	},
	REVIEW_SKIP_BRANCH_PREFIXES: {
		parser: { kind: "stringArray" },
		description:
			"Comma-separated source branch prefixes that should be skipped.",
		default: ["renovate/"],
	},
} as const satisfies Record<string, EnvVariableMetadata>;

export const CLI_COMMAND_METADATA: Record<CliCommandName, CliCommandMetadata> =
	{
		review: {
			usage: "review <pull-request-url> [options]",
			description: "Review one pull request from an explicit Bitbucket URL",
			argumentLabel: "<pull-request-url>",
			argumentDescription:
				"Bitbucket pull request URL, for example https://host/projects/PROJ/repos/repo/pull-requests/123 or a PR tab URL like /overview, /diff, /commits, or /builds.",
		},
	};

export const REVIEW_CLI_OPTION_METADATA: Record<
	ReviewCliOptionName,
	CliOptionMetadata
> = {
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
	help: {
		flags: ["-h", "--help"],
		description: "Show this help text",
	},
};
