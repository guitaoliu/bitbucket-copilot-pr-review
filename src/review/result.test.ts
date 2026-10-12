import assert from "node:assert/strict";
import { describe, it } from "node:test";
import packageJson from "../../package.json" with { type: "json" };
import { BITBUCKET_PR_COMMENT_MAX_CHARS } from "../shared/text.ts";
import {
	baseReviewerConfig as baseConfig,
	createPullRequest,
} from "../test-support/review-fixtures.ts";
import { buildFindingThreadKey } from "./finding-identity.ts";
import { parseSummaryCommentRevision } from "./markers.ts";
import {
	buildReviewArtifacts,
	buildReviewRunOutput,
	buildSkippedReviewOutput,
} from "./result.ts";
import type { ReviewArtifacts } from "./runner-types.ts";
import type { ReviewContext, ReviewOutcome } from "./types.ts";

function createReviewContext(): ReviewContext {
	const pr = createPullRequest();

	return {
		repoRoot: "/tmp/repo",
		pr,
		headCommit: pr.source.latestCommit,
		baseCommit: pr.target.latestCommit,
		mergeBaseCommit: pr.target.latestCommit,
		reviewRevision: "review-rev-123",
		rawDiff: "",
		diffStats: { fileCount: 2, additions: 3, deletions: 1 },
		reviewableFiles: [
			{
				path: "src/service.ts",
				status: "modified",
				patch: "diff --git a/src/service.ts b/src/service.ts",
				changedLines: [42],
				hunks: [
					{
						oldStart: 42,
						oldLines: 1,
						newStart: 42,
						newLines: 1,
						header: "",
						changedLines: [42],
					},
				],
				additions: 1,
				deletions: 0,
				isBinary: false,
			},
			{
				path: "src/other.ts",
				status: "modified",
				patch: "diff --git a/src/other.ts b/src/other.ts",
				changedLines: [8],
				hunks: [
					{
						oldStart: 8,
						oldLines: 1,
						newStart: 8,
						newLines: 1,
						header: "",
						changedLines: [8],
					},
				],
				additions: 1,
				deletions: 0,
				isBinary: false,
			},
		],
	};
}

function createReviewOutcome(): ReviewOutcome {
	return {
		summary: "Found 1 issue.",
		prSummary: "Hardens the service validation path before merge.",
		findings: [
			{
				externalId: "finding-1",
				threadKey: "thread-1",
				path: "src/service.ts",
				line: 42,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "Null handling is broken",
				details: "The new branch dereferences a possibly null response.",
			},
		],
	};
}

describe("buildSkippedReviewOutput", () => {
	it("returns a skipped run payload with review context and a PASS report", () => {
		const pr = createPullRequest("abc123");
		const skipReason = "Review already published.";
		const output = buildSkippedReviewOutput({
			config: baseConfig,
			pullRequest: pr,
			skipReason,
		});

		assert.deepEqual(output, {
			context: {
				toolVersion: packageJson.version,
				prId: 123,
				title: "Test PR",
				sourceBranch: "feature",
				targetBranch: "main",
				headCommit: "abc123",
				mergeBaseCommit: "base-123",
				reviewableFiles: 0,
			},
			review: {
				summary: skipReason,
				findings: [],
				stale: false,
			},
			report: {
				title: baseConfig.report.title,
				result: "PASS",
				reporter: baseConfig.report.reporter,
			},
			published: false,
			skipped: true,
			skipReason,
		});
	});
});

describe("buildReviewArtifacts", () => {
	it("builds the report and tagged pull request comment", () => {
		const context = createReviewContext();
		const review = createReviewOutcome();
		const artifacts = buildReviewArtifacts(baseConfig, context, review);

		assert.equal(artifacts.report.result, "FAIL");
		assert.deepEqual(
			artifacts.report.data?.map(({ title, value }) => [title, value]),
			[
				["Findings", 1],
				["Review revision", "review-rev-123"],
				["Finding taxonomy", "1 bug"],
				["Review scope", "2 reviewable"],
			],
		);
		assert.match(artifacts.commentBody, /<!-- copilot-pr-review -->/);
		assert.match(
			artifacts.commentBody,
			/<!-- copilot-pr-review:revision:review-rev-123 -->/,
		);
		assert.doesNotMatch(
			artifacts.commentBody,
			/<!-- copilot-pr-review:findings-json:/,
		);
		assert.doesNotMatch(
			artifacts.commentBody,
			/reviewed-commit|published-commit|:schema:/,
		);
		assert.match(
			artifacts.commentBody,
			/### What Changed\nHardens the service validation path before merge\./,
		);
		assert.doesNotMatch(artifacts.commentBody, /### Conclusion/);
		assert.match(artifacts.commentBody, /### Findings/);
		assert.match(artifacts.commentBody, /- 1 reportable issue: 1 bug/);
		assert.match(artifacts.commentBody, /### Review Scope/);
		assert.doesNotMatch(artifacts.commentBody, /### Main Concerns/);
		assert.doesNotMatch(artifacts.commentBody, /### Change Areas/);
		assert.doesNotMatch(artifacts.commentBody, /### File Changes/);
		assert.doesNotMatch(artifacts.commentBody, /### Outside Review Scope/);
		assert.doesNotMatch(artifacts.commentBody, /Adds a null guard/);
		assert.match(
			artifacts.commentBody,
			/1\. \[Type: BUG \| Severity: HIGH \| Confidence: high\].*Null handling is broken/s,
		);
		assert.match(artifacts.commentBody, /Null handling is broken/);
		assert.equal(
			parseSummaryCommentRevision(
				baseConfig.report.commentTag,
				artifacts.commentBody,
			),
			"review-rev-123",
		);
	});

	it("bounds large comment bodies under the Bitbucket limit", () => {
		const context = createReviewContext();
		context.reviewableFiles = Array.from({ length: 200 }, (_, index) => ({
			path: `src/file-${index}.ts`,
			status: "modified" as const,
			patch: `diff --git a/src/file-${index}.ts b/src/file-${index}.ts`,
			changedLines: [index + 1],
			hunks: [
				{
					oldStart: index + 1,
					oldLines: 1,
					newStart: index + 1,
					newLines: 1,
					header: "",
					changedLines: [index + 1],
				},
			],
			additions: 1,
			deletions: 0,
			isBinary: false,
		}));
		context.diffStats = {
			fileCount: context.reviewableFiles.length,
			additions: context.reviewableFiles.length,
			deletions: 0,
		};

		const review: ReviewOutcome = {
			summary: "Found many issues.",
			prSummary: "Large review for truncation coverage.",
			findings: Array.from({ length: 140 }, (_, index) => ({
				externalId: `finding-${index}`,
				path:
					context.reviewableFiles[index % context.reviewableFiles.length]
						?.path ?? "src/service.ts",
				line: index + 1,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				threadKey: buildFindingThreadKey({
					path:
						context.reviewableFiles[index % context.reviewableFiles.length]
							?.path ?? "src/service.ts",
					line: index + 1,
					type: "BUG",
				}),
				title: `Finding ${index} ${"r".repeat(240)}`,
				details: "Large detail.",
			})),
		};

		const artifacts = buildReviewArtifacts(baseConfig, context, review);

		assert.ok(artifacts.commentBody.length <= BITBUCKET_PR_COMMENT_MAX_CHARS);
		assert.match(artifacts.commentBody, /<!-- copilot-pr-review -->/);
		assert.match(
			artifacts.commentBody,
			/omitted to fit Bitbucket comment limit/,
		);
	});
});

describe("buildReviewRunOutput", () => {
	it("combines context, review, and published artifacts into the final output", () => {
		const context = createReviewContext();
		const review: ReviewOutcome = {
			...createReviewOutcome(),
			gitTelemetry: {
				byOperation: {
					diff: {
						count: 2,
						durationMsTotal: 17,
					},
				},
			},
			toolTelemetry: {
				totalRequested: 3,
				totalAllowed: 3,
				totalDenied: 0,
				totalCompleted: 3,
				totalDurationMs: 44,
				sessionDurationMs: 80,
				errorCount: 0,
				byTool: {
					bash: {
						requested: 1,
						allowed: 1,
						denied: 0,
						completed: 1,
						resultCounts: { success: 1 },
						totalDurationMs: 44,
					},
				},
			},
			copilotUsage: {
				aiCredits: 17.99695,
				usageValueUsd: 0.1799695,
				modelMetrics: {},
			},
		};
		const artifacts: ReviewArtifacts = {
			review,
			report: {
				title: baseConfig.report.title,
				result: "FAIL",
				reporter: baseConfig.report.reporter,
			},
			commentBody: "comment body",
			findingComments: [],
		};
		const output = buildReviewRunOutput(context, artifacts, {
			status: "published",
			completedStages: [
				"code_insights",
				"finding_comments",
				"pull_request_comment",
			],
		});

		assert.deepEqual(output, {
			context: {
				toolVersion: packageJson.version,
				prId: 123,
				title: "Test PR",
				sourceBranch: "feature",
				targetBranch: "main",
				headCommit: "head-123",
				mergeBaseCommit: "base-123",
				reviewRevision: "review-rev-123",
				reviewableFiles: 2,
			},
			metrics: {
				gitTelemetry: review.gitTelemetry,
				toolTelemetry: review.toolTelemetry,
				copilotUsage: review.copilotUsage,
			},
			review: {
				summary: review.summary,
				prSummary: review.prSummary,
				findings: review.findings,
				stale: false,
			},
			report: artifacts.report,
			commentBody: "comment body",
			published: true,
			publication: {
				status: "published",
				attempted: true,
				codeInsightsPublished: true,
				findingCommentsUpdated: true,
				pullRequestCommentUpdated: true,
			},
			publicationStatus: "published",
			skipped: false,
		});
	});

	it("maps stale and partial publication results to the run output publication fields", () => {
		const context = createReviewContext();
		const artifacts: ReviewArtifacts = {
			review: createReviewOutcome(),
			report: {
				title: baseConfig.report.title,
				result: "FAIL",
				reporter: baseConfig.report.reporter,
			},
			commentBody: "comment body",
			findingComments: [],
		};
		const stale = buildReviewRunOutput(context, artifacts, {
			status: "stale",
			completedStages: [],
		});
		const partial = buildReviewRunOutput(context, artifacts, {
			status: "partial",
			completedStages: ["code_insights"],
			error: { stage: "finding_comments", message: "boom" },
		});
		const incomplete = buildReviewRunOutput(context, artifacts, {
			status: "failed",
			completedStages: [],
			error: { stage: "review", message: "incomplete" },
		});

		assert.equal(stale.published, false);
		assert.equal(stale.review.stale, true);
		assert.deepEqual(stale.publication, {
			status: "stale",
			attempted: false,
			codeInsightsPublished: false,
			findingCommentsUpdated: false,
			pullRequestCommentUpdated: false,
		});
		assert.equal(partial.review.stale, false);
		assert.deepEqual(partial.publication, {
			status: "partial",
			attempted: true,
			codeInsightsPublished: true,
			findingCommentsUpdated: false,
			pullRequestCommentUpdated: false,
			error: { stage: "finding_comments", message: "boom" },
		});
		assert.equal(incomplete.publication?.attempted, false);
		assert.equal(incomplete.publicationStatus, "failed");
	});

	it("sanitizes model-authored text for the rendered artifacts and the run output", () => {
		const context = createReviewContext();
		const review: ReviewOutcome = {
			summary: "Found issue <!-- injected-summary --> and ping @here.",
			assistantMessage:
				"Assistant message includes <!-- injected-assistant --> and @channel.",
			prSummary:
				"Changed behavior <!-- copilot-pr-review:revision:fake --> for @here.",
			changeAreas: [
				{
					title: "Area <!-- injected-area-title -->",
					paths: ["src/service.ts"],
					summary: "Area summary <!-- injected-area-summary -->.",
				},
			],
			findings: [
				{
					externalId: "finding-1",
					threadKey: "thread-1",
					path: "src/service.ts",
					line: 42,
					severity: "HIGH",
					type: "BUG",
					confidence: "high",
					title: "Finding title <!-- injected-title -->",
					details: "Finding details mention @everyone.",
					category: "security @all",
				},
			],
		};
		const artifacts = buildReviewArtifacts(baseConfig, context, review);
		const output = buildReviewRunOutput(context, artifacts, {
			status: "dry_run",
			completedStages: [],
		});

		assert.doesNotMatch(
			artifacts.commentBody,
			/<!-- injected|@here|revision:fake -->/,
		);
		assert.doesNotMatch(artifacts.report.details ?? "", /<!-- injected|@here/);
		assert.equal(
			parseSummaryCommentRevision(
				baseConfig.report.commentTag,
				artifacts.commentBody,
			),
			context.reviewRevision,
		);

		assert.equal(
			output.review.summary,
			"Found issue &lt;!-- injected-summary --&gt; and ping [at]here.",
		);
		assert.equal(
			output.review.assistantMessage,
			"Assistant message includes &lt;!-- injected-assistant --&gt; and [at]channel.",
		);
		assert.equal(
			output.review.prSummary,
			"Changed behavior &lt;!-- copilot-pr-review:revision:fake --&gt; for [at]here.",
		);
		assert.equal(
			output.review.changeAreas?.[0]?.title,
			"Area &lt;!-- injected-area-title --&gt;",
		);
		assert.equal(
			output.review.changeAreas?.[0]?.summary,
			"Area summary &lt;!-- injected-area-summary --&gt;.",
		);
		assert.equal(
			output.review.findings[0]?.title,
			"Finding title &lt;!-- injected-title --&gt;",
		);
		assert.equal(
			output.review.findings[0]?.details,
			"Finding details mention [at]everyone.",
		);
		assert.equal(output.review.findings[0]?.category, "security [at]all");
	});
});
