import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PullRequestInfo } from "../bitbucket/types.ts";
import type { ReviewerConfig } from "../config/types.ts";
import type { Logger } from "../shared/logger.ts";
import { publishReview } from "./publish.ts";
import type { ReviewArtifacts, ReviewBitbucketClient } from "./runner-types.ts";
import type { ReviewContext, ReviewOutcome } from "./types.ts";

const baseConfig: ReviewerConfig = {
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

function createPullRequest(commit = "head-123"): PullRequestInfo {
	return {
		id: 123,
		version: 1,
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

function createReviewContext(pr: PullRequestInfo): ReviewContext {
	return {
		repoRoot: "/tmp/repo",
		pr,
		headCommit: pr.source.latestCommit,
		baseCommit: pr.target.latestCommit,
		mergeBaseCommit: pr.target.latestCommit,
		reviewRevision: "review-rev-123",
		rawDiff: "",
		diffStats: { fileCount: 1, additions: 1, deletions: 0 },
		reviewedFiles: [],
		skippedFiles: [],
	};
}

function createReviewOutcome(): ReviewOutcome {
	return {
		summary: "No reportable issues found.",
		prSummary: "Confirms the lightweight PR update is safe to merge.",
		fileSummaries: [],
		findings: [],
		stale: false,
	};
}

function createReviewArtifacts(): ReviewArtifacts {
	return {
		report: {
			title: baseConfig.report.title,
			result: "PASS",
			reporter: baseConfig.report.reporter,
		},
		annotations: [],
		commentBody: "review comment",
	};
}

function createBitbucketClient(
	overrides: Partial<ReviewBitbucketClient> = {},
): ReviewBitbucketClient {
	return {
		async getPullRequest() {
			return createPullRequest();
		},
		async getCodeInsightsReport() {
			return undefined;
		},
		async listCodeInsightsAnnotations() {
			return [];
		},
		async getCodeInsightsAnnotationCount() {
			return 0;
		},
		async findPullRequestCommentByTag() {
			return undefined;
		},
		async publishCodeInsights() {},
		async upsertPullRequestComment() {},
		...overrides,
	};
}

function createLoggerSpy(): {
	logger: Logger;
	infoMessages: string[];
	warnMessages: string[];
} {
	const infoMessages: string[] = [];
	const warnMessages: string[] = [];

	return {
		logger: {
			debug() {},
			info(message) {
				infoMessages.push(message);
			},
			warn(message) {
				warnMessages.push(message);
			},
			error() {},
			trace() {},
			json() {},
		},
		infoMessages,
		warnMessages,
	};
}

describe("publishReview", () => {
	it("returns early without touching Bitbucket when dry run is enabled", async () => {
		const config: ReviewerConfig = {
			...baseConfig,
			review: {
				...baseConfig.review,
				dryRun: true,
			},
		};
		let pullRequestCalls = 0;
		const { logger, infoMessages, warnMessages } = createLoggerSpy();
		const result = await publishReview(
			createBitbucketClient({
				async getPullRequest() {
					pullRequestCalls += 1;
					return createPullRequest();
				},
			}),
			config,
			createReviewContext(createPullRequest()),
			createReviewOutcome(),
			createReviewArtifacts(),
			logger,
		);

		assert.deepEqual(result, {
			published: false,
			review: createReviewOutcome(),
		});
		assert.equal(pullRequestCalls, 0);
		assert.deepEqual(infoMessages, [
			"Dry run enabled, skipping Bitbucket Code Insights publish.",
		]);
		assert.deepEqual(warnMessages, []);
	});

	it("marks the review stale when the pull request head moves before publish", async () => {
		const pr = createPullRequest("head-123");
		const context = createReviewContext(pr);
		const review = createReviewOutcome();
		const { logger, warnMessages } = createLoggerSpy();
		let publishCalled = false;
		let commentCalled = false;
		const result = await publishReview(
			createBitbucketClient({
				async getPullRequest() {
					return createPullRequest("head-456");
				},
				async publishCodeInsights() {
					publishCalled = true;
				},
				async upsertPullRequestComment() {
					commentCalled = true;
				},
			}),
			baseConfig,
			context,
			review,
			createReviewArtifacts(),
			logger,
		);

		assert.deepEqual(result, {
			published: false,
			review: {
				...review,
				stale: true,
			},
		});
		assert.equal(publishCalled, false);
		assert.equal(commentCalled, false);
		assert.match(
			warnMessages[0] ?? "",
			/Skipping publish because the PR head moved from head-123 to head-456/,
		);
	});

	it("publishes insights and updates the tagged comment for the current head", async () => {
		const pr = createPullRequest();
		const context = createReviewContext(pr);
		const review = createReviewOutcome();
		const artifacts = createReviewArtifacts();
		const publishCalls: Array<{
			commitId: string;
			reportKey: string;
			report: ReviewArtifacts["report"];
			annotations: ReviewArtifacts["annotations"];
		}> = [];
		const commentCalls: Array<{
			tag: string;
			text: string;
			strategy: ReviewerConfig["report"]["commentStrategy"] | undefined;
		}> = [];
		const { logger, warnMessages } = createLoggerSpy();
		const result = await publishReview(
			createBitbucketClient({
				async getPullRequest() {
					return pr;
				},
				async publishCodeInsights(commitId, reportKey, report, annotations) {
					publishCalls.push({ commitId, reportKey, report, annotations });
				},
				async upsertPullRequestComment(tag, text, options) {
					commentCalls.push({ tag, text, strategy: options?.strategy });
				},
			}),
			baseConfig,
			context,
			review,
			artifacts,
			logger,
		);

		assert.deepEqual(result, { published: true, review });
		assert.deepEqual(publishCalls, [
			{
				commitId: context.headCommit,
				reportKey: baseConfig.report.key,
				report: artifacts.report,
				annotations: artifacts.annotations,
			},
		]);
		assert.deepEqual(commentCalls, [
			{
				tag: baseConfig.report.commentTag,
				text: artifacts.commentBody,
				strategy: baseConfig.report.commentStrategy,
			},
		]);
		assert.deepEqual(warnMessages, []);
	});
});
