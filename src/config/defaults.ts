import type {
	Confidence,
	LogLevel,
	PullRequestCommentStrategy,
	ReasoningEffort,
} from "./types.ts";

export const REVIEWER_CONFIG_DEFAULTS = {
	gitRemoteName: "origin",
	logLevel: "info" as LogLevel,
	bitbucket: {
		tls: {
			insecureSkipVerify: false,
		},
	},
	copilot: {
		model: "gpt-5.4",
		reasoningEffort: "xhigh" as ReasoningEffort,
		timeoutMs: 1_800_000,
	},
	report: {
		key: "copilot-pr-review",
		title: "Copilot PR Review",
		reporter: "GitHub Copilot",
		commentTag: "copilot-pr-review",
		commentStrategy: "recreate" as PullRequestCommentStrategy,
	},
	review: {
		dryRun: false,
		forceReview: false,
		confirmRerun: false,
		maxFiles: 300,
		maxFindings: 25,
		minConfidence: "medium" as Confidence,
		maxPatchChars: 12_000,
		defaultFileSliceLines: 250,
		maxFileSliceLines: 400,
		ignorePaths: [] as string[],
		skipBranchPrefixes: ["renovate/"] as string[],
	},
};
