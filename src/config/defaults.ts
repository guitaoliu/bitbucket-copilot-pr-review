import type {
	Confidence,
	LogLevel,
	PullRequestCommentStrategy,
	ReasoningEffort,
} from "./types.ts";

const DEFAULT_LOG_LEVEL: LogLevel = "info";
const DEFAULT_REASONING_EFFORT: ReasoningEffort = "max";
const DEFAULT_COMMENT_STRATEGY: PullRequestCommentStrategy = "recreate";
const DEFAULT_MIN_CONFIDENCE: Confidence = "medium";
const DEFAULT_IGNORE_PATHS: string[] = [];
const DEFAULT_SKIP_BRANCH_PREFIXES: string[] = ["renovate/"];

export const REVIEWER_CONFIG_DEFAULTS = {
	gitRemoteName: "origin",
	logLevel: DEFAULT_LOG_LEVEL,
	bitbucket: {
		tls: {
			insecureSkipVerify: false,
		},
	},
	copilot: {
		model: "gpt-5.6-luna",
		reasoningEffort: DEFAULT_REASONING_EFFORT,
		timeoutMs: 1_800_000,
	},
	report: {
		key: "copilot-pr-review",
		title: "Copilot PR Review",
		reporter: "GitHub Copilot",
		commentTag: "copilot-pr-review",
		commentStrategy: DEFAULT_COMMENT_STRATEGY,
	},
	review: {
		dryRun: false,
		forceReview: false,
		confirmRerun: false,
		maxFindings: 25,
		minConfidence: DEFAULT_MIN_CONFIDENCE,
		maxPatchChars: 12_000,
		defaultFileSliceLines: 250,
		maxFileSliceLines: 400,
		ignorePaths: DEFAULT_IGNORE_PATHS,
		skipBranchPrefixes: DEFAULT_SKIP_BRANCH_PREFIXES,
	},
};
