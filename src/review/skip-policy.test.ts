import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
	PullRequestInfo,
	RawBitbucketCodeInsightsReport,
} from "../bitbucket/types.ts";
import type { ReviewerConfig } from "../config/types.ts";
import { buildFindingThreadKey } from "./finding-identity.ts";
import {
	buildPullRequestCommentMetadataMarkers,
	buildReviewMetadataFields,
	getInsightReportReviewedCommit,
} from "./publication-state.ts";
import type { ReviewBitbucketClient } from "./runner-types.ts";
import {
	buildReviewReusePlan,
	getExistingPublicationStatus,
} from "./skip-policy.ts";
import type { ReviewContext, StoredReviewFinding } from "./types.ts";

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
		model: "gpt-5.3-codex",
		reasoningEffort: "xhigh",
		timeoutMs: 1800000,
	},
	report: {
		key: "copilot-review",
		title: "Copilot PR Review",
		reporter: "GitHub Copilot",
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

function createContext(pr = createPullRequest()): ReviewContext {
	return {
		repoRoot: "/tmp/repo",
		pr,
		headCommit: pr.source.latestCommit,
		baseCommit: pr.target.latestCommit,
		mergeBaseCommit: pr.target.latestCommit,
		reviewRevision: "review-rev-123",
		rawDiff: "diff --git a/src/example.ts b/src/example.ts",
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

function createReport(
	context: ReviewContext,
	options: { reviewedCommit?: string } = {},
): RawBitbucketCodeInsightsReport {
	return {
		title: baseConfig.report.title,
		result: "PASS",
		reporter: baseConfig.report.reporter,
		data: [
			{ title: "Findings", type: "NUMBER", value: 1 },
			...buildReviewMetadataFields({
				revision: context.reviewRevision,
				reviewedCommit: options.reviewedCommit ?? context.headCommit,
			}),
		],
	};
}

function createStoredFindings(): StoredReviewFinding[] {
	return [
		{
			externalId: "finding-1",
			threadKey: buildFindingThreadKey({
				path: "src/example.ts",
				line: 10,
				type: "BUG",
			}),
			path: "src/example.ts",
			line: 10,
			severity: "HIGH",
			type: "BUG",
			confidence: "high",
			title: "Null handling is broken",
			details: "The new branch dereferences a possibly null response.",
		},
	];
}

function createTaggedComment(
	options: {
		tag?: string;
		revision?: string;
		reviewedCommit?: string;
		publishedCommit?: string;
		storedFindings?: StoredReviewFinding[];
		body?: string;
	} = {},
): { text: string; id: number; version: number } {
	const tag = options.tag ?? baseConfig.report.commentTag;
	return {
		id: 1,
		version: 1,
		text: [
			`<!-- ${tag} -->`,
			...buildPullRequestCommentMetadataMarkers({
				tag,
				revision: options.revision ?? "review-rev-123",
				reviewedCommit: options.reviewedCommit ?? "head-123",
				publishedCommit: options.publishedCommit ?? "head-123",
				...(options.storedFindings
					? { findingsJson: JSON.stringify(options.storedFindings) }
					: {}),
			}),
			options.body ?? "## Copilot PR Review",
		].join("\n"),
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
		async findPullRequestCommentByTag() {
			return undefined;
		},
		async publishCodeInsights() {},
		async reconcilePullRequestFindingComments() {},
		async upsertPullRequestComment() {},
		...overrides,
	};
}

describe("getExistingPublicationStatus", () => {
	it("loads the current-head report state and marks an exact revision match complete", async () => {
		const context = createContext();
		const report = createReport(context);
		const calls: string[] = [];

		const status = await getExistingPublicationStatus(
			createBitbucketClient({
				async getCodeInsightsReport(commitId, reportKey) {
					calls.push(`report:${commitId}:${reportKey}`);
					return report;
				},
				async findPullRequestCommentByTag(tag) {
					calls.push(`comment:${tag}`);
					return createTaggedComment({
						storedFindings: createStoredFindings(),
					});
				},
			}),
			baseConfig,
			context,
		);

		assert.equal(status.existingReport, report);
		assert.deepEqual(status.commentStoredFindings, createStoredFindings());
		assert.equal(status.existingPublicationComplete, true);
		assert.deepEqual(calls, [
			`comment:${baseConfig.report.commentTag}`,
			`report:${context.headCommit}:${baseConfig.report.key}`,
		]);
	});

	it("falls back to the reviewed commit from the tagged comment when the head changed", async () => {
		const context = createContext();
		const reusedCommit = "head-old";
		const report = createReport(context, { reviewedCommit: reusedCommit });
		const status = await getExistingPublicationStatus(
			createBitbucketClient({
				async getCodeInsightsReport(commitId) {
					return commitId === reusedCommit ? report : undefined;
				},
				async findPullRequestCommentByTag() {
					return createTaggedComment({
						reviewedCommit: reusedCommit,
						publishedCommit: context.headCommit,
						storedFindings: createStoredFindings(),
					});
				},
			}),
			baseConfig,
			context,
		);

		assert.equal(status.existingPublicationComplete, false);
		assert.equal(status.reportCommit, reusedCommit);
		assert.equal(status.reportReviewedCommit, reusedCommit);
		assert.deepEqual(status.commentStoredFindings, createStoredFindings());
	});
});

describe("buildReviewReusePlan", () => {
	it("skips when the current revision is already fully published", () => {
		const context = createContext();
		const plan = buildReviewReusePlan(baseConfig, context, {
			existingReport: createReport(context),
			existingComment: createTaggedComment({
				storedFindings: createStoredFindings(),
			}),
			commentStoredFindings: createStoredFindings(),
			existingPublicationComplete: true,
			reportCommit: context.headCommit,
			reportRevision: context.reviewRevision,
			reportReviewedCommit: context.headCommit,
			reportSchema: "2",
			commentRevision: context.reviewRevision,
			commentPublishedCommit: context.headCommit,
			commentReviewedCommit: context.headCommit,
			unusableReasons: [],
		});

		assert.equal(plan.action, "skip");
		assert.match(plan.reason ?? "", /already has a fully published report/);
	});

	it("republishes cached artifacts when the revision matches but the head changed", () => {
		const context = createContext();
		const oldHead = "head-old";
		const plan = buildReviewReusePlan(baseConfig, context, {
			existingReport: createReport(context, { reviewedCommit: oldHead }),
			existingComment: createTaggedComment({
				reviewedCommit: oldHead,
				publishedCommit: context.headCommit,
				storedFindings: createStoredFindings(),
			}),
			commentStoredFindings: createStoredFindings(),
			existingPublicationComplete: false,
			reportCommit: oldHead,
			reportRevision: context.reviewRevision,
			reportReviewedCommit: oldHead,
			reportSchema: "2",
			commentRevision: context.reviewRevision,
			commentPublishedCommit: context.headCommit,
			commentReviewedCommit: oldHead,
			unusableReasons: [],
		});

		assert.equal(plan.action, "republish");
		assert.ok(plan.reusedArtifacts);
		assert.ok(plan.reusedReview);
		assert.match(plan.repairWarning ?? "", /Reusing the existing review/);
		assert.equal(
			getInsightReportReviewedCommit(plan.reusedArtifacts?.report),
			context.headCommit,
		);
		assert.match(
			plan.reusedArtifacts?.commentBody ?? "",
			/<!-- copilot-pr-review:reviewed-commit:head-123 -->/,
		);
		assert.match(
			plan.reusedArtifacts?.commentBody ?? "",
			/<!-- copilot-pr-review:published-commit:head-123 -->/,
		);
	});

	it("sanitizes reused tagged comment body while preserving rewritten metadata", () => {
		const context = createContext();
		const plan = buildReviewReusePlan(baseConfig, context, {
			existingReport: createReport(context),
			existingComment: createTaggedComment({
				reviewedCommit: context.headCommit,
				publishedCommit: context.headCommit,
				storedFindings: createStoredFindings(),
				body: "## Copilot PR Review\n\nRaw <!-- old-marker --> mentions @here.",
			}),
			commentStoredFindings: createStoredFindings(),
			existingPublicationComplete: false,
			reportCommit: context.headCommit,
			reportRevision: context.reviewRevision,
			reportReviewedCommit: context.headCommit,
			reportSchema: "2",
			commentRevision: context.reviewRevision,
			commentPublishedCommit: context.headCommit,
			commentReviewedCommit: context.headCommit,
			unusableReasons: [],
		});

		assert.equal(plan.action, "republish");
		assert.match(
			plan.reusedArtifacts?.commentBody ?? "",
			/<!-- copilot-pr-review:reviewed-commit:head-123 -->/,
		);
		assert.match(
			plan.reusedArtifacts?.commentBody ?? "",
			/Raw &lt;!-- old-marker --&gt; mentions \[at\]here\./,
		);
		assert.doesNotMatch(
			plan.reusedArtifacts?.commentBody ?? "",
			/Raw <!-- old-marker --> mentions @here\./,
		);
	});

	it("reuses stored findings from the tagged comment", () => {
		const context = createContext();
		const plan = buildReviewReusePlan(baseConfig, context, {
			existingReport: createReport(context),
			existingComment: createTaggedComment({
				reviewedCommit: context.headCommit,
				publishedCommit: context.headCommit,
				storedFindings: createStoredFindings(),
			}),
			commentStoredFindings: createStoredFindings(),
			existingPublicationComplete: false,
			reportCommit: context.headCommit,
			reportRevision: context.reviewRevision,
			reportReviewedCommit: context.headCommit,
			reportSchema: "2",
			commentRevision: context.reviewRevision,
			commentPublishedCommit: context.headCommit,
			commentReviewedCommit: context.headCommit,
			unusableReasons: [],
		});

		assert.equal(plan.action, "republish");
		assert.deepEqual(plan.reusedReview?.findings, [
			{
				externalId: "finding-1",
				threadKey: buildFindingThreadKey({
					path: "src/example.ts",
					line: 10,
					type: "BUG",
				}),
				path: "src/example.ts",
				line: 10,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "Null handling is broken",
				details: "The new branch dereferences a possibly null response.",
			},
		]);
		assert.match(
			plan.reusedArtifacts?.commentBody ?? "",
			/<!-- copilot-pr-review:findings-json:/,
		);
	});

	it("does not reuse stored findings from a mismatched reviewed commit", () => {
		const context = createContext();
		const oldHead = "head-old";
		const plan = buildReviewReusePlan(baseConfig, context, {
			existingReport: createReport(context),
			existingComment: createTaggedComment({
				reviewedCommit: oldHead,
				publishedCommit: context.headCommit,
				storedFindings: createStoredFindings(),
			}),
			commentStoredFindings: createStoredFindings(),
			existingPublicationComplete: false,
			reportCommit: context.headCommit,
			reportRevision: context.reviewRevision,
			reportReviewedCommit: context.headCommit,
			reportSchema: "2",
			commentRevision: context.reviewRevision,
			commentPublishedCommit: context.headCommit,
			commentReviewedCommit: oldHead,
			unusableReasons: [
				`comment reviewed commit ${oldHead} != ${context.headCommit}`,
				"stored finding count 0 != findings 1",
			],
		});

		assert.equal(plan.action, "review");
		assert.equal(plan.reusedReview, undefined);
	});

	it("forces a fresh review when prior artifacts do not match the revision", () => {
		const context = createContext();
		const plan = buildReviewReusePlan(baseConfig, context, {
			existingReport: createReport(context),
			existingComment: createTaggedComment({ revision: "other-revision" }),
			existingPublicationComplete: false,
			reportCommit: context.headCommit,
			reportRevision: context.reviewRevision,
			reportReviewedCommit: context.headCommit,
			reportSchema: "2",
			commentRevision: "other-revision",
			commentPublishedCommit: context.headCommit,
			commentReviewedCommit: context.headCommit,
			unusableReasons: [
				"comment revision other-revision != review-rev-123",
				"stored finding count 0 != findings 1",
			],
		});

		assert.equal(plan.action, "review");
		assert.match(plan.repairWarning ?? "", /rerunning review/);
		assert.match(plan.repairWarning ?? "", /comment revision other-revision/);
		assert.match(
			plan.repairWarning ?? "",
			/stored finding count 0 != findings 1/,
		);
		assert.match(plan.confirmMessage ?? "", /Existing cached artifacts/);
	});

	it("prompts before rerunning when the cached artifacts are unusable for the current head and revision", () => {
		const context = createContext();
		const plan = buildReviewReusePlan(baseConfig, context, {
			existingReport: createReport(context),
			existingComment: createTaggedComment(),
			existingPublicationComplete: false,
			reportCommit: context.headCommit,
			reportRevision: context.reviewRevision,
			reportReviewedCommit: context.headCommit,
			reportSchema: "2",
			commentRevision: context.reviewRevision,
			commentPublishedCommit: context.headCommit,
			commentReviewedCommit: context.headCommit,
			unusableReasons: ["stored finding count 0 != findings 1"],
		});

		assert.equal(plan.action, "review");
		assert.match(plan.confirmMessage ?? "", /Existing cached artifacts/);
	});

	it("reruns automatically when the head changed even if the cached artifacts are unusable", () => {
		const context = createContext();
		const oldHead = "head-old";
		const plan = buildReviewReusePlan(baseConfig, context, {
			existingReport: createReport(context, { reviewedCommit: oldHead }),
			existingComment: createTaggedComment({
				reviewedCommit: oldHead,
				publishedCommit: oldHead,
			}),
			existingPublicationComplete: false,
			reportCommit: oldHead,
			reportRevision: context.reviewRevision,
			reportReviewedCommit: oldHead,
			reportSchema: "2",
			commentRevision: context.reviewRevision,
			commentPublishedCommit: oldHead,
			commentReviewedCommit: oldHead,
			unusableReasons: [
				`comment reviewed commit ${oldHead} != ${context.headCommit}`,
				"stored finding count 0 != findings 1",
			],
		});

		assert.equal(plan.action, "review");
		assert.equal(plan.confirmMessage, undefined);
	});

	it("reruns automatically when the revision changed even if the head is unchanged", () => {
		const context = createContext();
		const oldRevision = "review-rev-old";
		const plan = buildReviewReusePlan(baseConfig, context, {
			existingReport: createReport(context),
			existingComment: createTaggedComment({
				revision: oldRevision,
			}),
			existingPublicationComplete: false,
			reportCommit: context.headCommit,
			reportRevision: oldRevision,
			reportReviewedCommit: context.headCommit,
			reportSchema: "2",
			commentRevision: oldRevision,
			commentPublishedCommit: context.headCommit,
			commentReviewedCommit: context.headCommit,
			unusableReasons: [
				`report revision ${oldRevision} != ${context.reviewRevision}`,
				`comment revision ${oldRevision} != ${context.reviewRevision}`,
				"stored finding count 0 != findings 1",
			],
		});

		assert.equal(plan.action, "review");
		assert.equal(plan.confirmMessage, undefined);
	});
});
