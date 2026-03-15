import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PullRequestInfo } from "../bitbucket/types.ts";
import type { ReviewerConfig } from "../config/types.ts";
import { BITBUCKET_PR_COMMENT_MAX_CHARS } from "../shared/text.ts";
import {
	buildReviewArtifacts,
	buildReviewRunOutput,
	buildSkippedReviewOutput,
} from "./result.ts";
import type { ReviewArtifacts } from "./runner-types.ts";
import { MAX_REVIEWED_FILES_WITH_PER_FILE_SUMMARIES } from "./summary.ts";
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
		reviewedFiles: [
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
		skippedFiles: [
			{
				path: "dist/generated.js",
				status: "modified",
				reason: "ignored by policy",
			},
		],
	};
}

function createReviewOutcome(): ReviewOutcome {
	return {
		summary: "Found 1 issue.",
		prSummary: "Hardens the service validation path before merge.",
		fileSummaries: [
			{
				path: "src/service.ts",
				summary: "Adds a null guard before dereferencing the service response.",
			},
			{
				path: "src/other.ts",
				summary:
					"Adjusts the related helper to match the new service behavior.",
			},
		],
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
		],
		stale: false,
	};
}

describe("buildSkippedReviewOutput", () => {
	it("returns a skipped run payload with review context and a PASS report", () => {
		const pr = createPullRequest("abc123");
		const skipReason = "Review already published.";
		const output = buildSkippedReviewOutput(baseConfig, pr, skipReason);

		assert.deepEqual(output, {
			context: {
				prId: 123,
				title: "Test PR",
				sourceBranch: "feature",
				targetBranch: "main",
				headCommit: "abc123",
				mergeBaseCommit: "base-123",
				reviewedFiles: 0,
				skippedFiles: 0,
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
			annotations: [],
			published: false,
			skipped: true,
			skipReason,
		});
	});
});

describe("buildReviewArtifacts", () => {
	it("builds the report, annotations, and tagged pull request comment", () => {
		const context = createReviewContext();
		const review = createReviewOutcome();
		const artifacts = buildReviewArtifacts(baseConfig, context, review);

		assert.equal(artifacts.report.result, "FAIL");
		assert.deepEqual(
			artifacts.report.data?.map(({ title, value }) => [title, value]),
			[
				["Findings", 1],
				["Finding taxonomy", "1 bug"],
				["Review revision", "review-rev-123"],
				["Review schema", "2"],
				["Reviewed commit", "head-123"],
				["Review scope", "2 reviewed, 1 skipped"],
			],
		);
		assert.equal(artifacts.annotations.length, 1);
		assert.deepEqual(artifacts.annotations[0], {
			externalId: "finding-1",
			path: "src/service.ts",
			line: 42,
			message: [
				"Null handling is broken",
				"Type: BUG | Severity: HIGH | Confidence: high",
				"The new branch dereferences a possibly null response.",
			].join("\n"),
			severity: "HIGH",
			type: "BUG",
		});
		assert.match(artifacts.commentBody, /<!-- copilot-pr-review -->/);
		assert.match(
			artifacts.commentBody,
			/<!-- copilot-pr-review:revision:review-rev-123 -->/,
		);
		assert.match(
			artifacts.commentBody,
			/<!-- copilot-pr-review:reviewed-commit:head-123 -->/,
		);
		assert.match(
			artifacts.commentBody,
			/<!-- copilot-pr-review:published-commit:head-123 -->/,
		);
		assert.match(
			artifacts.commentBody,
			/### What Changed\nHardens the service validation path before merge\./,
		);
		assert.match(artifacts.commentBody, /### Conclusion/);
		assert.match(
			artifacts.commentBody,
			/- Recommendation: address 1 reportable issue before merge\./,
		);
		assert.match(artifacts.commentBody, /### Review Scope/);
		assert.match(artifacts.commentBody, /### Main Concerns/);
		assert.match(artifacts.commentBody, /### Reviewed Changes/);
		assert.match(artifacts.commentBody, /### Outside Review Scope/);
		assert.match(
			artifacts.commentBody,
			/src\/service\.ts.*Adds a null guard before dereferencing the service response\./s,
		);
		assert.match(artifacts.commentBody, /- Main risks: 1 bug/);
		assert.match(
			artifacts.commentBody,
			/1\. \[BUG\/HIGH\/high\].*Null handling is broken/s,
		);
		assert.match(artifacts.commentBody, /Null handling is broken/);
	});

	it("omits the line property for file-level annotations", () => {
		const context = createReviewContext();
		const review: ReviewOutcome = {
			summary: "Found 1 issue.",
			prSummary: "Highlights a file-level issue in the related helper.",
			fileSummaries: [
				{
					path: "src/other.ts",
					summary:
						"Changes the helper in a way that cannot be pinned to one changed line.",
				},
			],
			findings: [
				{
					externalId: "finding-file",
					path: "src/other.ts",
					line: 0,
					severity: "MEDIUM",
					type: "BUG",
					confidence: "medium",
					title: "File-level issue",
					details: "Cannot be pinned to a single line.",
				},
			],
			stale: false,
		};

		const artifacts = buildReviewArtifacts(baseConfig, context, review);

		assert.deepEqual(artifacts.annotations, [
			{
				externalId: "finding-file",
				path: "src/other.ts",
				message: [
					"File-level issue",
					"Type: BUG | Severity: MEDIUM | Confidence: medium",
					"Cannot be pinned to a single line.",
				].join("\n"),
				severity: "MEDIUM",
				type: "BUG",
			},
		]);
	});

	it("bounds large comment bodies under the Bitbucket limit", () => {
		const context = createReviewContext();
		context.reviewedFiles = Array.from({ length: 200 }, (_, index) => ({
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
		context.skippedFiles = Array.from({ length: 200 }, (_, index) => ({
			path: `dist/generated-${index}.js`,
			status: "modified" as const,
			reason: `generated or vendored path ${index}`,
		}));
		context.diffStats = {
			fileCount: context.reviewedFiles.length + context.skippedFiles.length,
			additions: context.reviewedFiles.length,
			deletions: 0,
		};

		const review: ReviewOutcome = {
			summary: "Found many issues.",
			prSummary: "Large review for truncation coverage.",
			fileSummaries: context.reviewedFiles.map((file, index) => ({
				path: file.path,
				summary: `Summary ${index} ${"q".repeat(120)}.`,
			})),
			findings: Array.from({ length: 140 }, (_, index) => ({
				externalId: `finding-${index}`,
				path:
					context.reviewedFiles[index % context.reviewedFiles.length]?.path ??
					"src/service.ts",
				line: index + 1,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: `Finding ${index} ${"r".repeat(80)}`,
				details: "Large detail.",
			})),
			stale: false,
		};

		const artifacts = buildReviewArtifacts(baseConfig, context, review);

		assert.ok(artifacts.commentBody.length <= BITBUCKET_PR_COMMENT_MAX_CHARS);
		assert.match(artifacts.commentBody, /<!-- copilot-pr-review -->/);
		assert.match(
			artifacts.commentBody,
			/omitted to fit Bitbucket comment limit/,
		);
	});

	it("omits reviewed changes in artifacts for reviews above the summary cutoff", () => {
		const context = createReviewContext();
		context.reviewedFiles = Array.from(
			{ length: MAX_REVIEWED_FILES_WITH_PER_FILE_SUMMARIES + 1 },
			(_, index) => ({
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
			}),
		);
		context.diffStats = {
			fileCount: context.reviewedFiles.length + context.skippedFiles.length,
			additions: context.reviewedFiles.length,
			deletions: 0,
		};

		const artifacts = buildReviewArtifacts(baseConfig, context, {
			...createReviewOutcome(),
			fileSummaries: [],
		});

		assert.doesNotMatch(artifacts.commentBody, /### Reviewed Changes/);
		assert.match(artifacts.commentBody, /### What Changed/);
		assert.match(artifacts.commentBody, /### Main Concerns/);
	});
});

describe("buildReviewRunOutput", () => {
	it("combines context, review, and published artifacts into the final output", () => {
		const context = createReviewContext();
		const review = createReviewOutcome();
		const artifacts: ReviewArtifacts = {
			report: {
				title: baseConfig.report.title,
				result: "FAIL",
				reporter: baseConfig.report.reporter,
			},
			annotations: [
				{
					externalId: "finding-1",
					path: "src/service.ts",
					line: 42,
					message: "message",
					severity: "HIGH",
					type: "BUG",
				},
			],
			commentBody: "comment body",
		};
		const output = buildReviewRunOutput(context, review, artifacts, true);

		assert.deepEqual(output, {
			context: {
				prId: 123,
				title: "Test PR",
				sourceBranch: "feature",
				targetBranch: "main",
				headCommit: "head-123",
				mergeBaseCommit: "base-123",
				reviewRevision: "review-rev-123",
				reviewedFiles: 2,
				skippedFiles: 1,
			},
			review,
			report: artifacts.report,
			annotations: artifacts.annotations,
			commentBody: "comment body",
			published: true,
			skipped: false,
		});
	});
});
