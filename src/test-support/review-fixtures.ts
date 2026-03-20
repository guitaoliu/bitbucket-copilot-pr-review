import type { PullRequestInfo } from "../bitbucket/types.ts";
import type { ReviewerConfig } from "../config/types.ts";
import type { ChangedFile } from "../git/types.ts";
import type { ReviewArtifacts } from "../review/runner-types.ts";
import type { ReviewContext, ReviewOutcome } from "../review/types.ts";
import type { Logger } from "../shared/logger.ts";

export const baseReviewerConfig: ReviewerConfig = {
	repoRoot: "/tmp/repo",
	gitRemoteName: "origin",
	logLevel: "info",
	bitbucket: {
		baseUrl: "https://bitbucket.example.com",
		projectKey: "PROJ",
		repoSlug: "repo",
		prId: 123,
		auth: {
			type: "bearer",
			token: "token",
		},
		tls: {
			insecureSkipVerify: false,
		},
	},
	copilot: {
		model: "gpt-5.4",
		reasoningEffort: "xhigh",
		timeoutMs: 1800000,
	},
	report: {
		key: "copilot-review",
		title: "Copilot PR Review",
		reporter: "GitHub Copilot via Jenkins",
		commentTag: "copilot-pr-review",
		commentStrategy: "recreate",
	},
	review: {
		dryRun: false,
		forceReview: false,
		confirmRerun: false,
		maxFiles: 100,
		maxFindings: 10,
		minConfidence: "high",
		maxPatchChars: 12000,
		defaultFileSliceLines: 250,
		maxFileSliceLines: 400,
		ignorePaths: [],
		skipBranchPrefixes: ["renovate/"],
	},
};

export function createPullRequest(commit = "head-123"): PullRequestInfo {
	return {
		id: 123,
		version: 1,
		state: "OPEN",
		title: "Test PR",
		description: "",
		source: {
			repositoryId: 1,
			projectKey: "PROJ",
			repoSlug: "repo",
			refId: "refs/heads/feature",
			displayId: "feature",
			latestCommit: commit,
		},
		target: {
			repositoryId: 1,
			projectKey: "PROJ",
			repoSlug: "repo",
			refId: "refs/heads/main",
			displayId: "main",
			latestCommit: "base-123",
		},
	};
}

export function createChangedFile(
	overrides: Partial<ChangedFile> = {},
): ChangedFile {
	return {
		path: "src/example.ts",
		status: "modified",
		patch: "diff --git a/src/example.ts b/src/example.ts",
		changedLines: [10],
		hunks: [
			{
				oldStart: 10,
				oldLines: 1,
				newStart: 10,
				newLines: 1,
				header: "",
				changedLines: [10],
			},
		],
		additions: 1,
		deletions: 0,
		isBinary: false,
		...overrides,
	};
}

export function createReviewContext(
	pr: PullRequestInfo = createPullRequest(),
	overrides: Partial<ReviewContext> = {},
): ReviewContext {
	return {
		repoRoot: "/tmp/repo",
		pr,
		headCommit: pr.source.latestCommit,
		baseCommit: pr.target.latestCommit,
		mergeBaseCommit: pr.target.latestCommit,
		reviewRevision: "review-rev-123",
		rawDiff: "",
		diffStats: { fileCount: 1, additions: 1, deletions: 0 },
		reviewedFiles: [createChangedFile()],
		skippedFiles: [],
		...overrides,
	};
}

export function createReviewOutcome(
	overrides: Partial<ReviewOutcome> = {},
): ReviewOutcome {
	return {
		summary: "No reportable issues found.",
		prSummary: "Confirms the reviewed change is safe to merge.",
		fileSummaries: [],
		findings: [],
		stale: false,
		...overrides,
	};
}

export function createReviewArtifacts(
	config: ReviewerConfig = baseReviewerConfig,
	overrides: Partial<ReviewArtifacts> = {},
): ReviewArtifacts {
	return {
		report: {
			title: config.report.title,
			result: "PASS",
			reporter: config.report.reporter,
		},
		annotations: [],
		commentBody: "review comment",
		...overrides,
	};
}

export function createLoggerSpy(): {
	logger: Logger;
	infoMessages: string[];
	warnMessages: string[];
	errorMessages: string[];
} {
	const infoMessages: string[] = [];
	const warnMessages: string[] = [];
	const errorMessages: string[] = [];

	return {
		logger: {
			debug() {},
			info(message) {
				infoMessages.push(message);
			},
			warn(message) {
				warnMessages.push(message);
			},
			error(message) {
				errorMessages.push(message);
			},
			trace() {},
			json() {},
		},
		infoMessages,
		warnMessages,
		errorMessages,
	};
}
