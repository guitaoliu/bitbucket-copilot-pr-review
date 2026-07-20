import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PullRequestInfo } from "../bitbucket/types.ts";
import type { ReviewerConfig } from "../config/types.ts";
import type { GitRepository } from "../git/repo.ts";
import type { Logger } from "../shared/logger.ts";
import {
	baseReviewerConfig as baseConfig,
	createPullRequest,
	createReviewContext,
	createReviewOutcome,
} from "../test-support/review-fixtures.ts";
import { buildFindingThreadKey } from "./finding-identity.ts";
import {
	buildPullRequestCommentMetadataMarkers,
	buildReviewMetadataFields,
} from "./publication-state.ts";
import { runReview } from "./runner.ts";
import type { ReviewContext } from "./types.ts";

const logger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
	trace() {},
	json() {},
};

function createGitStub(): GitRepository {
	return {
		getTelemetrySnapshot() {
			return { byOperation: {} };
		},
	} as GitRepository;
}

type FakeBitbucketClient = {
	getPullRequest(): Promise<PullRequestInfo>;
	getCodeInsightsReport(
		commitId: string,
		reportKey: string,
	): Promise<{ data?: Array<{ title: string; value: unknown }> } | undefined>;
	findPullRequestCommentByTag(
		tag: string,
	): Promise<{ text: string; id?: number; version?: number } | undefined>;
	publishCodeInsights(
		commitId: string,
		reportKey: string,
		report: unknown,
	): Promise<void>;
	reconcilePullRequestFindingComments(
		tag: string,
		findings: unknown[],
		metadata: { revision: string; reviewedCommit: string },
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
	it("logs the reviewable file count after filtering", async () => {
		const pr = createPullRequest();
		const baseContext = createReviewContext(pr);
		const context = {
			...baseContext,
			diffStats: { fileCount: 7, additions: 4, deletions: 1 },
			reviewableFiles: [
				...baseContext.reviewableFiles,
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
			async findPullRequestCommentByTag() {
				return undefined;
			},
			async publishCodeInsights() {},
			async reconcilePullRequestFindingComments() {},
			async upsertPullRequestComment() {},
		};

		await runReview(baseConfig, logSpy, {
			createBitbucketClient: () => client as never,
			prepareReviewContext: async () => ({
				config: baseConfig,
				git: createGitStub(),
				mergeBaseCommit: context.mergeBaseCommit,
			}),
			buildReviewContext: async () => context,
			runCopilotReview: async () => createReviewOutcome(),
		});

		assert.ok(
			infoMessages.includes(
				"Review scope after file filtering: 2 reviewable out of 7 changed files.",
			),
		);
		assert.ok(infoMessages.includes("Starting review run"));
		assert.ok(infoMessages.includes("Completed review run"));
	});

	it("runs Copilot in a detached trusted base workspace while preserving head review context", async () => {
		const pr = createPullRequest();
		const context = createReviewContext(pr);
		let workspaceCommit: string | undefined;
		let cleanupCalled = false;
		let reviewConfig: ReviewerConfig | undefined;
		let reviewContext: ReviewContext | undefined;
		const client: FakeBitbucketClient = {
			async getPullRequest() {
				return pr;
			},
			async getCodeInsightsReport() {
				return undefined;
			},
			async findPullRequestCommentByTag() {
				return undefined;
			},
			async publishCodeInsights() {},
			async reconcilePullRequestFindingComments() {},
			async upsertPullRequestComment() {},
		};

		const result = await runReview(baseConfig, logger, {
			createBitbucketClient: () => client as never,
			prepareReviewContext: async () => ({
				config: baseConfig,
				git: createGitStub(),
				mergeBaseCommit: context.mergeBaseCommit,
			}),
			buildReviewContext: async () => context,
			createDetachedReviewWorkspace: async ({ commit }) => {
				workspaceCommit = commit;
				return {
					workspaceRoot: "/tmp/base-worktree",
					async cleanup() {
						cleanupCalled = true;
					},
				};
			},
			runCopilotReview: async (config, passedContext) => {
				reviewConfig = config;
				reviewContext = passedContext;
				return createReviewOutcome();
			},
		});

		assert.equal(result.skipped, false);
		assert.equal(workspaceCommit, context.baseCommit);
		assert.equal(cleanupCalled, true);
		assert.equal(reviewConfig?.repoRoot, "/tmp/base-worktree");
		assert.equal(reviewContext?.repoRoot, "/tmp/base-worktree");
		assert.equal(reviewContext?.headCommit, context.headCommit);
		assert.equal(reviewContext?.baseCommit, context.baseCommit);
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
			async reconcilePullRequestFindingComments() {},
			async upsertPullRequestComment() {
				throw new Error("should not update comment");
			},
		};

		const result = await runReview(baseConfig, logger, {
			createBitbucketClient: () => client as never,
			prepareReviewContext: async () => ({
				config: baseConfig,
				git: createGitStub(),
				mergeBaseCommit: context.mergeBaseCommit,
			}),
			buildReviewContext: async () => context,
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
			async findPullRequestCommentByTag() {
				return undefined;
			},
			async publishCodeInsights() {
				publishCalled = true;
			},
			async reconcilePullRequestFindingComments() {},
			async upsertPullRequestComment() {
				commentCalled = true;
			},
		};

		const result = await runReview(baseConfig, logger, {
			createBitbucketClient: () => client as never,
			prepareReviewContext: async () => ({
				config: baseConfig,
				git: createGitStub(),
				mergeBaseCommit: firstPr.target.latestCommit,
			}),
			buildReviewContext: async () => createReviewContext(firstPr),
			runCopilotReview: async () => createReviewOutcome(),
		});

		assert.equal(result.skipped, false);
		assert.equal(result.published, false);
		assert.equal(result.publicationStatus, "stale");
		assert.equal(result.review.stale, true);
		assert.equal(publishCalled, false);
		assert.equal(commentCalled, false);
	});

	it("returns partial publication metadata when the PR comment update fails", async () => {
		let commentAttempts = 0;
		const pr = createPullRequest();
		const client: FakeBitbucketClient = {
			async getPullRequest() {
				return pr;
			},
			async getCodeInsightsReport() {
				return undefined;
			},
			async findPullRequestCommentByTag() {
				return undefined;
			},
			async publishCodeInsights() {},
			async reconcilePullRequestFindingComments() {},
			async upsertPullRequestComment() {
				commentAttempts += 1;
				throw new Error(`comment failure ${commentAttempts}`);
			},
		};

		const result = await runReview(baseConfig, logger, {
			createBitbucketClient: () => client as never,
			prepareReviewContext: async () => ({
				config: baseConfig,
				git: createGitStub(),
				mergeBaseCommit: pr.target.latestCommit,
			}),
			buildReviewContext: async () => createReviewContext(pr),
			runCopilotReview: async () => createReviewOutcome(),
		});

		assert.equal(commentAttempts, 2);
		assert.equal(result.skipped, false);
		assert.equal(result.published, false);
		assert.equal(result.publicationStatus, "partial");
		assert.deepEqual(result.publication, {
			status: "partial",
			attempted: true,
			codeInsightsPublished: true,
			findingCommentsUpdated: true,
			pullRequestCommentUpdated: false,
			error: {
				stage: "pull_request_comment",
				message: "comment failure 2",
			},
		});
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
			async findPullRequestCommentByTag() {
				throw new Error("should not read comments");
			},
			async publishCodeInsights() {
				throw new Error("should not publish");
			},
			async reconcilePullRequestFindingComments() {},
			async upsertPullRequestComment() {
				throw new Error("should not update comment");
			},
		};

		const result = await runReview(baseConfig, logger, {
			createBitbucketClient: () => client as never,
			prepareReviewContext: async () => ({
				config: baseConfig,
				git: createGitStub(),
				mergeBaseCommit: pr.target.latestCommit,
			}),
			buildReviewContext: async () => {
				buildContextCalled = true;
				return createReviewContext(pr);
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
			async findPullRequestCommentByTag() {
				throw new Error("should not read comments");
			},
			async publishCodeInsights() {
				throw new Error("should not publish");
			},
			async reconcilePullRequestFindingComments() {},
			async upsertPullRequestComment() {
				throw new Error("should not update comment");
			},
		};

		const result = await runReview(baseConfig, logger, {
			createBitbucketClient: () => client as never,
			prepareReviewContext: async () => ({
				config: baseConfig,
				git: createGitStub(),
				mergeBaseCommit: pr.target.latestCommit,
			}),
			buildReviewContext: async () => {
				buildContextCalled = true;
				return createReviewContext(pr);
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
			async findPullRequestCommentByTag() {
				throw new Error("should not read comments");
			},
			async publishCodeInsights() {
				throw new Error("should not publish");
			},
			async reconcilePullRequestFindingComments() {},
			async upsertPullRequestComment() {
				throw new Error("should not update comment");
			},
		};

		const result = await runReview(baseConfig, logger, {
			createBitbucketClient: () => client as never,
			prepareReviewContext: async () => ({
				config: baseConfig,
				git: createGitStub(),
				mergeBaseCommit: pr.target.latestCommit,
			}),
			buildReviewContext: async () => {
				buildContextCalled = true;
				return createReviewContext(pr);
			},
		});

		assert.equal(buildContextCalled, false);
		assert.equal(result.skipped, true);
		assert.match(result.skipReason ?? "", /is a draft/);
	});

	it("uses trusted repo config before applying branch-prefix skips", async () => {
		const basePr = createPullRequest();
		const pr = {
			...basePr,
			source: {
				...basePr.source,
				displayId: "renovate/typescript-5.x",
			},
		};
		let buildContextCalled = false;
		let copilotCalled = false;

		const client: FakeBitbucketClient = {
			async getPullRequest() {
				return pr;
			},
			async getCodeInsightsReport() {
				return undefined;
			},
			async findPullRequestCommentByTag() {
				return undefined;
			},
			async publishCodeInsights() {},
			async reconcilePullRequestFindingComments() {},
			async upsertPullRequestComment() {},
		};

		const result = await runReview(baseConfig, logger, {
			createBitbucketClient: () => client as never,
			prepareReviewContext: async () => ({
				config: {
					...baseConfig,
					review: {
						...baseConfig.review,
						skipBranchPrefixes: [],
					},
				},
				git: createGitStub(),
				mergeBaseCommit: pr.target.latestCommit,
			}),
			buildReviewContext: async () => {
				buildContextCalled = true;
				return createReviewContext(pr);
			},
			runCopilotReview: async () => {
				copilotCalled = true;
				return createReviewOutcome();
			},
		});

		assert.equal(buildContextCalled, true);
		assert.equal(copilotCalled, true);
		assert.equal(result.skipped, false);
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
			async findPullRequestCommentByTag() {
				return undefined;
			},
			async publishCodeInsights() {
				throw new Error("should not publish");
			},
			async reconcilePullRequestFindingComments() {},
			async upsertPullRequestComment() {
				throw new Error("should not update comment");
			},
		};

		const result = await runReview(baseConfig, logger, {
			createBitbucketClient: () => client as never,
			prepareReviewContext: async () => ({
				config: {
					...baseConfig,
					review: {
						...baseConfig.review,
						skipBranchPrefixes: ["deps/"],
					},
				},
				git: createGitStub(),
				mergeBaseCommit: pr.target.latestCommit,
			}),
			buildReviewContext: async () => createReviewContext(pr),
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
						async findPullRequestCommentByTag() {
							throw new Error("should not read comments");
						},
						async publishCodeInsights() {
							throw new Error("should not publish");
						},
						async reconcilePullRequestFindingComments() {},
						async upsertPullRequestComment() {
							throw new Error("should not update comment");
						},
					}) as never,
				prepareReviewContext: async () => ({
					config: {
						...baseConfig,
						review: {
							...baseConfig.review,
							skipBranchPrefixes: ["deps/"],
						},
					},
					git: createGitStub(),
					mergeBaseCommit: pr.target.latestCommit,
				}),
				buildReviewContext: async () => {
					buildContextCalled = true;
					return createReviewContext(pr);
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
			async reconcilePullRequestFindingComments() {},
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
				prepareReviewContext: async () => ({
					config: baseConfig,
					git: createGitStub(),
					mergeBaseCommit: context.mergeBaseCommit,
				}),
				buildReviewContext: async () => context,
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
			async reconcilePullRequestFindingComments() {},
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
				prepareReviewContext: async () => ({
					config: baseConfig,
					git: createGitStub(),
					mergeBaseCommit: context.mergeBaseCommit,
				}),
				buildReviewContext: async () => context,
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

	it("passes prior stored findings into a fresh review as reference context", async () => {
		const pr = createPullRequest();
		const context = createReviewContext(pr);
		const oldHead = "head-old";
		const oldRevision = "review-rev-old";
		let passedContext: ReviewContext | undefined;
		const storedFindings = [
			{
				externalId: "finding-1",
				threadKey: buildFindingThreadKey({
					path: "src/example.ts",
					line: 10,
					type: "BUG",
				}),
				path: "src/example.ts",
				line: 10,
				severity: "HIGH" as const,
				type: "BUG" as const,
				confidence: "high" as const,
				title: "Null handling is broken",
				details: "The old review found a null dereference.",
			},
		];
		const client: FakeBitbucketClient = {
			async getPullRequest() {
				return pr;
			},
			async getCodeInsightsReport(commitId) {
				if (commitId === context.headCommit) {
					return undefined;
				}

				const metadata = buildReviewMetadataFields({
					revision: oldRevision,
					reviewedCommit: oldHead,
				}).map(({ title, value }) => ({ title, value }));
				return {
					data: [{ title: "Findings", value: 1 }, ...metadata],
				};
			},
			async findPullRequestCommentByTag() {
				return {
					text: [
						"<!-- copilot-pr-review -->",
						...buildPullRequestCommentMetadataMarkers({
							tag: baseConfig.report.commentTag,
							revision: oldRevision,
							reviewedCommit: oldHead,
							publishedCommit: oldHead,
							findingsJson: JSON.stringify(storedFindings),
						}),
						"## Copilot PR Review",
					].join("\n"),
				};
			},
			async publishCodeInsights() {},
			async reconcilePullRequestFindingComments() {},
			async upsertPullRequestComment() {},
		};

		await runReview(baseConfig, logger, {
			createBitbucketClient: () => client as never,
			prepareReviewContext: async () => ({
				config: baseConfig,
				git: createGitStub(),
				mergeBaseCommit: context.mergeBaseCommit,
			}),
			buildReviewContext: async () => context,
			runCopilotReview: async (_config, reviewContext) => {
				passedContext = reviewContext;
				return createReviewOutcome();
			},
		});

		assert.deepEqual(passedContext?.previousReview, {
			revision: oldRevision,
			reviewedCommit: oldHead,
			findings: storedFindings,
		});
	});
});
