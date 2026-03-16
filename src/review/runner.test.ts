import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	InsightAnnotationPayload,
	PullRequestInfo,
} from "../bitbucket/types.ts";
import type { ReviewerConfig } from "../config/types.ts";
import type { GitRepository } from "../git/repo.ts";
import type { Logger } from "../shared/logger.ts";
import { buildReviewMetadataFields } from "./publication-state.ts";
import { runReview } from "./runner.ts";
import type { ReviewContext, ReviewOutcome } from "./types.ts";

const logger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
	trace() {},
	json() {},
};

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
		reviewedFiles: [
			{
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
			},
		],
		skippedFiles: [],
	};
}

function createReviewOutcome(): ReviewOutcome {
	return {
		summary: "No reportable issues found.",
		prSummary: "Confirms the reviewed change is safe to merge.",
		fileSummaries: [],
		findings: [],
		stale: false,
	};
}

type FakeBitbucketClient = {
	getPullRequest(): Promise<PullRequestInfo>;
	getCodeInsightsReport(
		commitId: string,
		reportKey: string,
	): Promise<{ data?: Array<{ title: string; value: unknown }> } | undefined>;
	listCodeInsightsAnnotations(
		commitId: string,
		reportKey: string,
	): Promise<InsightAnnotationPayload[]>;
	getCodeInsightsAnnotationCount(
		commitId: string,
		reportKey: string,
	): Promise<number>;
	findPullRequestCommentByTag(
		tag: string,
	): Promise<{ text: string; id?: number; version?: number } | undefined>;
	publishCodeInsights(
		commitId: string,
		reportKey: string,
		report: unknown,
		annotations: unknown[],
	): Promise<void>;
	upsertPullRequestComment(
		tag: string,
		text: string,
		options?: {
			strategy?: ReviewerConfig["report"]["commentStrategy"];
		},
	): Promise<void>;
};

describe("runReview", () => {
	it("logs reviewed and skipped counts after file filtering", async () => {
		const pr = createPullRequest();
		const baseContext = createReviewContext(pr);
		const context = {
			...baseContext,
			diffStats: { fileCount: 7, additions: 4, deletions: 1 },
			reviewedFiles: [
				...baseContext.reviewedFiles,
				{
					path: "src/second.ts",
					status: "modified" as const,
					patch: "diff --git a/src/second.ts b/src/second.ts",
					changedLines: [3],
					hunks: [
						{
							oldStart: 3,
							oldLines: 1,
							newStart: 3,
							newLines: 1,
							header: "",
							changedLines: [3],
						},
					],
					additions: 1,
					deletions: 0,
					isBinary: false,
				},
			],
			skippedFiles: [
				{
					path: "dist/a.js",
					status: "modified" as const,
					reason: "generated or vendored path",
				},
				{
					path: "dist/b.js",
					status: "modified" as const,
					reason: "generated or vendored path",
				},
				{
					path: "dist/c.js",
					status: "modified" as const,
					reason: "generated or vendored path",
				},
				{
					path: "dist/d.js",
					status: "modified" as const,
					reason: "generated or vendored path",
				},
				{
					path: "dist/e.js",
					status: "modified" as const,
					reason: "generated or vendored path",
				},
			],
		} satisfies ReviewContext;
		const infoMessages: string[] = [];
		const logSpy: Logger = {
			...logger,
			info(message) {
				infoMessages.push(message);
			},
		};
		const client: FakeBitbucketClient = {
			async getPullRequest() {
				return pr;
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
		};

		await runReview(baseConfig, logSpy, {
			createBitbucketClient: () => client as never,
			buildReviewContext: async () => ({
				config: baseConfig,
				context,
				git: {} as GitRepository,
			}),
			runCopilotReview: async () => createReviewOutcome(),
		});

		assert.ok(
			infoMessages.includes(
				"Review scope after file filtering: 2 reviewed, 5 skipped out of 7 changed files (REVIEW_MAX_FILES=100).",
			),
		);
	});

	it("skips when the publication is already complete", async () => {
		const pr = createPullRequest();
		const context = createReviewContext(pr);
		const client: FakeBitbucketClient = {
			async getPullRequest() {
				return pr;
			},
			async getCodeInsightsReport() {
				const metadata = buildReviewMetadataFields({
					revision: context.reviewRevision,
					reviewedCommit: context.headCommit,
				}).map(({ title, value }) => ({ title, value }));
				return {
					data: [{ title: "Findings", value: 0 }, ...metadata],
				};
			},
			async listCodeInsightsAnnotations() {
				return [];
			},
			async getCodeInsightsAnnotationCount() {
				return 0;
			},
			async findPullRequestCommentByTag() {
				return {
					text: [
						"<!-- copilot-pr-review -->",
						"<!-- copilot-pr-review:schema:2 -->",
						"<!-- copilot-pr-review:revision:review-rev-123 -->",
						"<!-- copilot-pr-review:reviewed-commit:head-123 -->",
						"<!-- copilot-pr-review:published-commit:head-123 -->",
					].join("\n"),
				};
			},
			async publishCodeInsights() {
				throw new Error("should not publish");
			},
			async upsertPullRequestComment() {
				throw new Error("should not update comment");
			},
		};

		const result = await runReview(baseConfig, logger, {
			createBitbucketClient: () => client as never,
			buildReviewContext: async () => ({
				config: baseConfig,
				context,
				git: {} as GitRepository,
			}),
		});

		assert.equal(result.skipped, true);
		assert.match(result.skipReason ?? "", /fully published report/);
	});

	it("marks the result stale when the PR head moves before publish", async () => {
		const firstPr = createPullRequest("head-123");
		const movedPr = createPullRequest("head-456");
		let pullRequestCalls = 0;
		let publishCalled = false;
		let commentCalled = false;

		const client: FakeBitbucketClient = {
			async getPullRequest() {
				pullRequestCalls += 1;
				return pullRequestCalls === 1 ? firstPr : movedPr;
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
			async publishCodeInsights() {
				publishCalled = true;
			},
			async upsertPullRequestComment() {
				commentCalled = true;
			},
		};

		const result = await runReview(baseConfig, logger, {
			createBitbucketClient: () => client as never,
			buildReviewContext: async () => ({
				config: baseConfig,
				context: createReviewContext(firstPr),
				git: {} as GitRepository,
			}),
			runCopilotReview: async () => createReviewOutcome(),
		});

		assert.equal(result.skipped, false);
		assert.equal(result.published, false);
		assert.equal(result.review.stale, true);
		assert.equal(publishCalled, false);
		assert.equal(commentCalled, false);
	});

	it("skips closed pull requests before building review context", async () => {
		const pr = {
			...createPullRequest(),
			state: "MERGED",
		};
		let buildContextCalled = false;

		const client: FakeBitbucketClient = {
			async getPullRequest() {
				return pr;
			},
			async getCodeInsightsReport() {
				throw new Error("should not read report state");
			},
			async listCodeInsightsAnnotations() {
				throw new Error("should not read annotations");
			},
			async getCodeInsightsAnnotationCount() {
				throw new Error("should not count annotations");
			},
			async findPullRequestCommentByTag() {
				throw new Error("should not read comments");
			},
			async publishCodeInsights() {
				throw new Error("should not publish");
			},
			async upsertPullRequestComment() {
				throw new Error("should not update comment");
			},
		};

		const result = await runReview(baseConfig, logger, {
			createBitbucketClient: () => client as never,
			buildReviewContext: async () => {
				buildContextCalled = true;
				return {
					config: baseConfig,
					context: createReviewContext(pr),
					git: {} as GitRepository,
				};
			},
		});

		assert.equal(buildContextCalled, false);
		assert.equal(result.skipped, true);
		assert.match(result.skipReason ?? "", /is MERGED/);
	});

	it("skips renovate pull requests before building review context", async () => {
		const basePr = createPullRequest();
		const pr = {
			...basePr,
			source: {
				...basePr.source,
				displayId: "renovate/typescript-5.x",
			},
		};
		let buildContextCalled = false;

		const client: FakeBitbucketClient = {
			async getPullRequest() {
				return pr;
			},
			async getCodeInsightsReport() {
				throw new Error("should not read report state");
			},
			async listCodeInsightsAnnotations() {
				throw new Error("should not read annotations");
			},
			async getCodeInsightsAnnotationCount() {
				throw new Error("should not count annotations");
			},
			async findPullRequestCommentByTag() {
				throw new Error("should not read comments");
			},
			async publishCodeInsights() {
				throw new Error("should not publish");
			},
			async upsertPullRequestComment() {
				throw new Error("should not update comment");
			},
		};

		const result = await runReview(baseConfig, logger, {
			createBitbucketClient: () => client as never,
			buildReviewContext: async () => {
				buildContextCalled = true;
				return {
					config: baseConfig,
					context: createReviewContext(pr),
					git: {} as GitRepository,
				};
			},
		});

		assert.equal(buildContextCalled, false);
		assert.equal(result.skipped, true);
		assert.match(result.skipReason ?? "", /matches skip prefix renovate\//);
	});

	it("skips draft pull requests before building review context", async () => {
		const pr = {
			...createPullRequest(),
			draft: true,
		};
		let buildContextCalled = false;

		const client: FakeBitbucketClient = {
			async getPullRequest() {
				return pr;
			},
			async getCodeInsightsReport() {
				throw new Error("should not read report state");
			},
			async listCodeInsightsAnnotations() {
				throw new Error("should not read annotations");
			},
			async getCodeInsightsAnnotationCount() {
				throw new Error("should not count annotations");
			},
			async findPullRequestCommentByTag() {
				throw new Error("should not read comments");
			},
			async publishCodeInsights() {
				throw new Error("should not publish");
			},
			async upsertPullRequestComment() {
				throw new Error("should not update comment");
			},
		};

		const result = await runReview(baseConfig, logger, {
			createBitbucketClient: () => client as never,
			buildReviewContext: async () => {
				buildContextCalled = true;
				return {
					config: baseConfig,
					context: createReviewContext(pr),
					git: {} as GitRepository,
				};
			},
		});

		assert.equal(buildContextCalled, false);
		assert.equal(result.skipped, true);
		assert.match(result.skipReason ?? "", /is a draft/);
	});

	it("uses repo-configured branch prefixes when deciding skips", async () => {
		const pr = {
			...createPullRequest(),
			source: {
				...createPullRequest().source,
				displayId: "deps/typescript-5.x",
			},
		};
		let copilotCalled = false;

		const client: FakeBitbucketClient = {
			async getPullRequest() {
				return pr;
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
			async publishCodeInsights() {
				throw new Error("should not publish");
			},
			async upsertPullRequestComment() {
				throw new Error("should not update comment");
			},
		};

		const result = await runReview(baseConfig, logger, {
			createBitbucketClient: () => client as never,
			buildReviewContext: async () => ({
				config: {
					...baseConfig,
					review: {
						...baseConfig.review,
						skipBranchPrefixes: ["deps/"],
					},
				},
				context: createReviewContext(pr),
				git: {} as GitRepository,
			}),
			runCopilotReview: async () => {
				copilotCalled = true;
				return createReviewOutcome();
			},
		});

		assert.equal(copilotCalled, false);
		assert.equal(result.skipped, true);
		assert.match(result.skipReason ?? "", /matches skip prefix deps\//);
	});

	it("skips before building context when config already matches the branch prefix", async () => {
		const basePr = createPullRequest();
		const pr = {
			...basePr,
			source: {
				...basePr.source,
				displayId: "deps/typescript-5.x",
			},
		};
		let buildContextCalled = false;

		const result = await runReview(
			{
				...baseConfig,
				review: {
					...baseConfig.review,
					skipBranchPrefixes: ["deps/"],
				},
			},
			logger,
			{
				createBitbucketClient: () =>
					({
						async getPullRequest() {
							return pr;
						},
						async getCodeInsightsReport() {
							throw new Error("should not read report state");
						},
						async listCodeInsightsAnnotations() {
							throw new Error("should not read annotations");
						},
						async getCodeInsightsAnnotationCount() {
							throw new Error("should not count annotations");
						},
						async findPullRequestCommentByTag() {
							throw new Error("should not read comments");
						},
						async publishCodeInsights() {
							throw new Error("should not publish");
						},
						async upsertPullRequestComment() {
							throw new Error("should not update comment");
						},
					}) as never,
				buildReviewContext: async () => {
					buildContextCalled = true;
					return {
						config: baseConfig,
						context: createReviewContext(pr),
						git: {} as GitRepository,
					};
				},
			},
		);

		assert.equal(buildContextCalled, false);
		assert.equal(result.skipped, true);
		assert.match(result.skipReason ?? "", /matches skip prefix deps\//);
	});

	it("skips rerun when confirm-rerun is enabled and the user declines", async () => {
		const pr = createPullRequest();
		const context = createReviewContext(pr);
		let copilotCalled = false;
		const sequence: string[] = [];
		const client: FakeBitbucketClient = {
			async getPullRequest() {
				return pr;
			},
			async getCodeInsightsReport() {
				const metadata = buildReviewMetadataFields({
					revision: context.reviewRevision,
					reviewedCommit: context.headCommit,
				}).map(({ title, value }) => ({ title, value }));
				return {
					data: [{ title: "Findings", value: 1 }, ...metadata],
				};
			},
			async listCodeInsightsAnnotations() {
				return [];
			},
			async getCodeInsightsAnnotationCount() {
				return 0;
			},
			async findPullRequestCommentByTag() {
				return {
					text: [
						"<!-- copilot-pr-review -->",
						"<!-- copilot-pr-review:schema:2 -->",
						"<!-- copilot-pr-review:revision:review-rev-123 -->",
						"<!-- copilot-pr-review:reviewed-commit:head-123 -->",
						"<!-- copilot-pr-review:published-commit:head-123 -->",
					].join("\n"),
				};
			},
			async publishCodeInsights() {
				throw new Error("should not publish");
			},
			async upsertPullRequestComment() {
				throw new Error("should not update comment");
			},
		};
		const logSpy: Logger = {
			...logger,
			warn(message) {
				sequence.push(`warn:${message}`);
			},
		};

		const result = await runReview(
			{
				...baseConfig,
				review: {
					...baseConfig.review,
					confirmRerun: true,
				},
			},
			logSpy,
			{
				createBitbucketClient: () => client as never,
				buildReviewContext: async () => ({
					config: baseConfig,
					context,
					git: {} as GitRepository,
				}),
				runCopilotReview: async () => {
					copilotCalled = true;
					return createReviewOutcome();
				},
				confirmRerun: async ({ message }) => {
					sequence.push(`confirm:${message}`);
					assert.match(message, /Existing cached artifacts/);
					return false;
				},
			},
		);

		assert.equal(copilotCalled, false);
		assert.equal(result.skipped, true);
		assert.match(result.skipReason ?? "", /manual confirmation declined/);
		assert.equal(sequence.length, 2);
		assert.match(
			sequence[0] ?? "",
			/^warn:Found an existing but unusable report copilot-review for revision review-rev-123; rerunning review to refresh the published output\./,
		);
		assert.match(
			sequence[1] ?? "",
			/^confirm:Existing cached artifacts for PR revision review-rev-123 look unusable\./,
		);
	});

	it("reruns automatically without prompting when the PR head changed", async () => {
		const pr = createPullRequest();
		const context = createReviewContext(pr);
		const oldHead = "head-old";
		let copilotCalled = false;
		let confirmCalled = false;
		const warnings: string[] = [];
		const client: FakeBitbucketClient = {
			async getPullRequest() {
				return pr;
			},
			async getCodeInsightsReport(commitId) {
				if (commitId === context.headCommit) {
					return undefined;
				}

				const metadata = buildReviewMetadataFields({
					revision: context.reviewRevision,
					reviewedCommit: oldHead,
				}).map(({ title, value }) => ({ title, value }));
				return {
					data: [{ title: "Findings", value: 1 }, ...metadata],
				};
			},
			async listCodeInsightsAnnotations() {
				return [];
			},
			async getCodeInsightsAnnotationCount() {
				return 0;
			},
			async findPullRequestCommentByTag() {
				return {
					text: [
						"<!-- copilot-pr-review -->",
						"<!-- copilot-pr-review:schema:2 -->",
						"<!-- copilot-pr-review:revision:review-rev-123 -->",
						`<!-- copilot-pr-review:reviewed-commit:${oldHead} -->`,
						`<!-- copilot-pr-review:published-commit:${oldHead} -->`,
					].join("\n"),
				};
			},
			async publishCodeInsights() {},
			async upsertPullRequestComment() {},
		};
		const logSpy: Logger = {
			...logger,
			warn(message) {
				warnings.push(message);
			},
		};

		const result = await runReview(
			{
				...baseConfig,
				review: {
					...baseConfig.review,
					confirmRerun: true,
				},
			},
			logSpy,
			{
				createBitbucketClient: () => client as never,
				buildReviewContext: async () => ({
					config: baseConfig,
					context,
					git: {} as GitRepository,
				}),
				runCopilotReview: async () => {
					copilotCalled = true;
					return createReviewOutcome();
				},
				confirmRerun: async () => {
					confirmCalled = true;
					return false;
				},
			},
		);

		assert.equal(confirmCalled, false);
		assert.equal(copilotCalled, true);
		assert.equal(result.skipped, false);
		assert.equal(warnings.length, 1);
		assert.match(
			warnings[0] ?? "",
			/rerunning review to refresh the published output/,
		);
	});
});
