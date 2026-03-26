import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InsightReportPayload } from "../bitbucket/types.ts";
import type { ReviewerConfig } from "../config/types.ts";
import { buildPullRequestComment } from "../insights.ts";
import {
	buildPullRequestCommentMetadataMarkers,
	buildReviewMetadataFields,
	getInsightReportFindingCount,
	isPullRequestPublicationComplete,
	parsePullRequestCommentMetadata,
} from "./publication-state.ts";
import type { ReviewContext, ReviewOutcome } from "./types.ts";

const config: ReviewerConfig = {
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
		reporter: "GitHub Copilot",
		commentTag: "copilot-pr-review",
		commentStrategy: "recreate",
	},
	review: {
		dryRun: true,
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

describe("publication completeness", () => {
	it("requires matching revision metadata in the report and comment", () => {
		const outcome: ReviewOutcome = {
			summary: "Found 2 issues.",
			prSummary:
				"Tightens service validation and pagination handling before merge.",
			fileSummaries: [],
			findings: [
				{
					externalId: "finding-1",
					path: "src/service.ts",
					line: 42,
					severity: "HIGH",
					type: "BUG",
					confidence: "high",
					title: "Null handling is broken",
					details: "The new branch dereferences a possibly null response.",
				},
				{
					externalId: "finding-2",
					path: "src/other.ts",
					line: 8,
					severity: "MEDIUM",
					type: "BUG",
					confidence: "high",
					title: "Pagination is incomplete",
					details: "Only the first page is read.",
				},
			],
			stale: false,
		};
		const context: ReviewContext = {
			pr: {
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
					latestCommit: "abcdef123456",
				},
				target: {
					repositoryId: 1,
					projectKey: "PROJ",
					repoSlug: "repo",
					refId: "refs/heads/main",
					displayId: "main",
					latestCommit: "123456abcdef",
				},
			},
			repoRoot: "/tmp/repo",
			headCommit: "abcdef123456",
			baseCommit: "123456abcdef",
			mergeBaseCommit: "123456abcdef",
			reviewRevision: "review-rev-123",
			rawDiff: "",
			diffStats: { fileCount: 2, additions: 3, deletions: 1 },
			reviewedFiles: [],
			skippedFiles: [],
		};

		const report: InsightReportPayload = {
			title: config.report.title,
			result: "FAIL" as const,
			reporter: config.report.reporter,
			data: [
				{ title: "Findings", type: "NUMBER" as const, value: 2 },
				...buildReviewMetadataFields({
					revision: context.reviewRevision,
					reviewedCommit: context.headCommit,
				}),
			],
		};
		const comment = buildPullRequestComment(config, context, outcome);

		assert.equal(getInsightReportFindingCount(report), 2);
		assert.equal(
			isPullRequestPublicationComplete({
				report,
				annotationCount: 2,
				commentTag: config.report.commentTag,
				headCommit: context.headCommit,
				reviewRevision: context.reviewRevision,
				commentText: comment,
			}),
			true,
		);
		assert.equal(
			isPullRequestPublicationComplete({
				report,
				annotationCount: 1,
				commentTag: config.report.commentTag,
				headCommit: context.headCommit,
				reviewRevision: context.reviewRevision,
				commentText: comment,
			}),
			false,
		);
	});

	it("parses revision markers from tagged comments", () => {
		const metadata = parsePullRequestCommentMetadata(
			"copilot-pr-review",
			[
				"<!-- copilot-pr-review -->",
				"<!-- copilot-pr-review:schema:2 -->",
				"<!-- copilot-pr-review:revision:review-rev-123 -->",
				"<!-- copilot-pr-review:reviewed-commit:head-123 -->",
				"<!-- copilot-pr-review:published-commit:head-456 -->",
			].join("\n"),
		);

		assert.deepEqual(metadata, {
			schema: "2",
			revision: "review-rev-123",
			reviewedCommit: "head-123",
			publishedCommit: "head-456",
		});
	});

	it("parses stored findings metadata from tagged comments", () => {
		const comment = [
			"<!-- copilot-pr-review -->",
			...buildPullRequestCommentMetadataMarkers({
				tag: "copilot-pr-review",
				revision: "review-rev-123",
				reviewedCommit: "head-123",
				publishedCommit: "head-123",
				findingsJson: JSON.stringify([
					{
						path: "src/service.ts",
						line: 42,
						severity: "HIGH",
						type: "BUG",
						title: "Null handling is broken",
					},
				]),
			}),
		].join("\n");

		const metadata = parsePullRequestCommentMetadata(
			"copilot-pr-review",
			comment,
		);

		assert.deepEqual(metadata?.storedFindings, [
			{
				path: "src/service.ts",
				line: 42,
				severity: "HIGH",
				type: "BUG",
				title: "Null handling is broken",
			},
		]);
	});
});
