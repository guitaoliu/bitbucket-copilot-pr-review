import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReviewerConfig } from "./config/types.ts";
import { buildInsightReport, buildPullRequestComment } from "./insights.ts";
import { MAX_REVIEWED_FILES_WITH_PER_FILE_SUMMARIES } from "./review/summary.ts";
import type { ReviewContext, ReviewOutcome } from "./review/types.ts";
import { BITBUCKET_PR_COMMENT_MAX_CHARS } from "./shared/text.ts";

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

function createContext(prLink: string | undefined): ReviewContext {
	return {
		repoRoot: "/tmp/repo",
		pr: {
			id: 123,
			version: 1,
			title: "Test PR",
			description: "Tighten request validation and clean up renamed paths.",
			...(prLink ? { link: prLink } : {}),
			source: {
				repositoryId: 1,
				projectKey: "PROJ",
				repoSlug: "repo",
				refId: "refs/heads/feature",
				displayId: "feature",
				latestCommit: "head-123",
			},
			target: {
				repositoryId: 1,
				projectKey: "PROJ",
				repoSlug: "repo",
				refId: "refs/heads/main",
				displayId: "main",
				latestCommit: "base-123",
			},
		},
		headCommit: "head-123",
		baseCommit: "base-123",
		mergeBaseCommit: "base-123",
		reviewRevision: "review-rev-123",
		rawDiff: "",
		diffStats: { fileCount: 6, additions: 4, deletions: 1 },
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
				path: "src/new-file.ts",
				status: "added",
				patch: "diff --git a/src/new-file.ts b/src/new-file.ts",
				changedLines: [1, 2],
				hunks: [
					{
						oldStart: 0,
						oldLines: 0,
						newStart: 1,
						newLines: 2,
						header: "",
						changedLines: [1, 2],
					},
				],
				additions: 2,
				deletions: 0,
				isBinary: false,
			},
			{
				path: "src/new-name.ts",
				oldPath: "src/old-name.ts",
				status: "renamed",
				patch: "diff --git a/src/old-name.ts b/src/new-name.ts",
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
				deletions: 1,
				isBinary: false,
			},
		],
		skippedFiles: [
			{
				path: "dist/generated.js",
				status: "modified",
				reason: "generated or vendored path",
			},
			{
				path: "i18n/locales/en.json",
				status: "modified",
				reason: "ignored path pattern (i18n/locales/**/*.json)",
			},
			{
				path: "src/copied.ts",
				oldPath: "src/original.ts",
				status: "copied",
				reason: "exceeds REVIEW_MAX_FILES limit (3)",
			},
			{
				path: "src/removed.ts",
				status: "deleted",
				reason: "deleted file",
			},
		],
	};
}

function createOutcome(): ReviewOutcome {
	return {
		summary: "Found 2 issues.",
		prSummary:
			"Tightens request validation in the service flow and cleans up renamed modules before merge.",
		fileSummaries: [
			{
				path: "src/service.ts",
				summary:
					"Adds stricter null handling and updates the main service branch behavior.",
			},
			{
				path: "src/new-file.ts",
				summary: "Introduces a new helper used by the updated validation flow.",
			},
			{
				path: "src/new-name.ts",
				summary:
					"Renames the module and adjusts its imports to match the new location.",
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
			{
				externalId: "finding-2",
				path: "src/new-name.ts",
				line: 0,
				severity: "MEDIUM",
				type: "CODE_SMELL",
				confidence: "high",
				title: "Rename lost an import",
				details: "The renamed file no longer imports the shared helper.",
			},
		],
		stale: false,
	};
}

describe("buildPullRequestComment", () => {
	it("includes a PR summary and links changed files back to the pull request diff", () => {
		const prLink =
			"https://bitbucket.example.com/projects/PROJ/repos/repo/pull-requests/123";
		const comment = buildPullRequestComment(
			config,
			createContext(prLink),
			createOutcome(),
		);

		assert.match(comment, /### Conclusion/);
		assert.match(
			comment,
			/### What Changed\nTightens request validation in the service flow and cleans up renamed modules before merge\./,
		);
		assert.match(
			comment,
			/- Recommendation: address 2 reportable issues before merge\./,
		);
		assert.match(comment, /### Review Scope/);
		assert.match(
			comment,
			/- PR: \[#123 Test PR\]\(https:\/\/bitbucket\.example\.com\/projects\/PROJ\/repos\/repo\/pull-requests\/123\)/,
		);
		assert.match(comment, /- Branches: `feature` -> `main`/);
		assert.match(comment, /- Diff size: 6 files, \+4, -1/);
		assert.match(
			comment,
			/- Change mix: 1 added file, 3 modified files, 1 renamed file, 1 copied file, 1 deleted file/,
		);
		assert.match(comment, /- Reviewed in scope: 3 files/);
		assert.match(comment, /- Outside scope: 4 files/);
		assert.match(
			comment,
			/- Outside-scope reasons: deleted file \(1\), generated or vendored path \(1\), ignored path pattern \(1\), max-files limit \(1\)/,
		);
		assert.doesNotMatch(comment, /Changed files:/);
		assert.match(comment, /### Main Concerns/);
		assert.match(comment, /- Main risks: 1 bug, 1 code smell/);
		assert.match(comment, /### Reviewed Changes/);
		assert.match(
			comment,
			/- \[src\/service\.ts\]\(https:\/\/bitbucket\.example\.com\/projects\/PROJ\/repos\/repo\/pull-requests\/123\/diff#src%2Fservice\.ts\): Adds stricter null handling and updates the main service branch behavior\./,
		);
		assert.match(
			comment,
			/- \[src\/new-file\.ts\]\(https:\/\/bitbucket\.example\.com\/projects\/PROJ\/repos\/repo\/pull-requests\/123\/diff#src%2Fnew-file\.ts\): Introduces a new helper used by the updated validation flow\./,
		);
		assert.match(
			comment,
			/- \[src\/new-name\.ts\]\(https:\/\/bitbucket\.example\.com\/projects\/PROJ\/repos\/repo\/pull-requests\/123\/diff#src%2Fnew-name\.ts\): Renames the module and adjusts its imports to match the new location\./,
		);
		assert.match(comment, /### Outside Review Scope/);
		assert.match(
			comment,
			/- \[dist\/generated\.js\]\(https:\/\/bitbucket\.example\.com\/projects\/PROJ\/repos\/repo\/pull-requests\/123\/diff#dist%2Fgenerated\.js\): generated or vendored path/,
		);
		assert.match(
			comment,
			/- \[i18n\/locales\/en\.json\]\(https:\/\/bitbucket\.example\.com\/projects\/PROJ\/repos\/repo\/pull-requests\/123\/diff#i18n%2Flocales%2Fen\.json\): ignored path pattern/,
		);
		assert.match(
			comment,
			/- \[src\/copied\.ts\]\(https:\/\/bitbucket\.example\.com\/projects\/PROJ\/repos\/repo\/pull-requests\/123\/diff#src%2Fcopied\.ts\): copied from src\/original\.ts; max-files limit/,
		);
		assert.match(
			comment,
			/- \[src\/removed\.ts\]\(https:\/\/bitbucket\.example\.com\/projects\/PROJ\/repos\/repo\/pull-requests\/123\/diff#src%2Fremoved\.ts\): deleted file/,
		);
		assert.match(
			comment,
			/1\. \[BUG\/HIGH\/high\] \[src\/service\.ts:42\]\(https:\/\/bitbucket\.example\.com\/projects\/PROJ\/repos\/repo\/pull-requests\/123\/diff#src%2Fservice\.ts\?t=42\) - Null handling is broken/,
		);
		assert.match(
			comment,
			/2\. \[CODE_SMELL\/MEDIUM\/high\] \[src\/new-name\.ts\]\(https:\/\/bitbucket\.example\.com\/projects\/PROJ\/repos\/repo\/pull-requests\/123\/diff#src%2Fnew-name\.ts\) - Rename lost an import/,
		);
	});

	it("falls back to plain file references when the pull request link is unavailable", () => {
		const comment = buildPullRequestComment(
			config,
			createContext(undefined),
			createOutcome(),
		);

		assert.match(comment, /- PR: #123 Test PR/);
		assert.match(
			comment,
			/### What Changed\nTightens request validation in the service flow and cleans up renamed modules before merge\./,
		);
		assert.match(
			comment,
			/- Recommendation: address 2 reportable issues before merge\./,
		);
		assert.match(
			comment,
			/- Outside-scope reasons: deleted file \(1\), generated or vendored path \(1\), ignored path pattern \(1\), max-files limit \(1\)/,
		);
		assert.doesNotMatch(comment, /- `src\/service\.ts` - modified/);
		assert.match(comment, /### Main Concerns/);
		assert.match(comment, /- Main risks: 1 bug, 1 code smell/);
		assert.match(
			comment,
			/- `src\/service\.ts`: Adds stricter null handling and updates the main service branch behavior\./,
		);
		assert.match(comment, /### Outside Review Scope/);
		assert.match(
			comment,
			/- `dist\/generated\.js`: generated or vendored path/,
		);
		assert.match(comment, /- `i18n\/locales\/en\.json`: ignored path pattern/);
		assert.match(
			comment,
			/1\. \[BUG\/HIGH\/high\] `src\/service\.ts:42` - Null handling is broken/,
		);
		assert.doesNotMatch(comment, /\[src\/service\.ts:42\]\(/);
	});

	it("adds taxonomy detail to the insight report summary", () => {
		const report = buildInsightReport(
			config,
			createContext(
				"https://bitbucket.example.com/projects/PROJ/repos/repo/pull-requests/123",
			),
			createOutcome(),
		);

		assert.match(
			report.details ?? "",
			/Only validated findings on reviewable changed files and changed lines are published\./,
		);
		assert.match(report.details ?? "", /Taxonomy: 1 bug, 1 code smell/);
		assert.match(report.details ?? "", /Top validated findings:/);
		assert.match(
			report.details ?? "",
			/1\. \[BUG\/HIGH\/high\] src\/service\.ts:42 - Null handling is broken/,
		);
		assert.ok((report.data?.length ?? 0) <= 6);
		assert.deepEqual(
			report.data?.map(({ title, value }) => [title, value]),
			[
				["Findings", 2],
				["Finding taxonomy", "1 bug, 1 code smell"],
				["Review revision", "review-rev-123"],
				["Review schema", "2"],
				["Reviewed commit", "head-123"],
				["Review scope", "3 reviewed, 4 skipped"],
			],
		);
	});

	it("truncates low-priority sections to stay under the Bitbucket comment limit", () => {
		const context = createContext(
			"https://bitbucket.example.com/projects/PROJ/repos/repo/pull-requests/123",
		);
		context.reviewedFiles = Array.from({ length: 180 }, (_, index) => ({
			path: `src/reviewed-${index}.ts`,
			status: "modified" as const,
			patch: `diff --git a/src/reviewed-${index}.ts b/src/reviewed-${index}.ts`,
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
		context.skippedFiles = Array.from({ length: 350 }, (_, index) => ({
			path: `dist/generated-${index}.js`,
			status: "modified" as const,
			reason: `generated or vendored path ${"x".repeat(40)}`,
		}));
		context.diffStats = {
			fileCount: context.reviewedFiles.length + context.skippedFiles.length,
			additions: context.reviewedFiles.length,
			deletions: 0,
		};

		const outcome: ReviewOutcome = {
			summary: "Found many issues.",
			prSummary: "Expands validation and support code across many modules.",
			fileSummaries: context.reviewedFiles.map((file, index) => ({
				path: file.path,
				summary: `Detailed review summary ${index} ${"y".repeat(120)}.`,
			})),
			findings: Array.from({ length: 120 }, (_, index) => ({
				externalId: `finding-${index}`,
				path:
					context.reviewedFiles[index % context.reviewedFiles.length]?.path ??
					"src/service.ts",
				line: index + 1,
				severity: "HIGH" as const,
				type: "BUG" as const,
				confidence: "high" as const,
				title: `Important finding ${index} ${"z".repeat(80)}`,
				details: "Large review detail.",
			})),
			stale: false,
		};

		const comment = buildPullRequestComment(config, context, outcome);

		assert.ok(comment.length <= BITBUCKET_PR_COMMENT_MAX_CHARS);
		assert.match(comment, /<!-- copilot-pr-review -->/);
		assert.match(comment, /<!-- copilot-pr-review:revision:review-rev-123 -->/);
		assert.match(comment, /<!-- copilot-pr-review:findings-json:/);
		assert.match(comment, /### Conclusion/);
		assert.match(comment, /### What Changed/);
		assert.match(comment, /### Review Scope/);
		assert.match(comment, /omitted to fit Bitbucket comment limit/);
	});

	it("omits reviewed change summaries when the review is above the cutoff", () => {
		const prLink =
			"https://bitbucket.example.com/projects/PROJ/repos/repo/pull-requests/123";
		const context = createContext(prLink);
		context.reviewedFiles = Array.from(
			{ length: MAX_REVIEWED_FILES_WITH_PER_FILE_SUMMARIES + 1 },
			(_, index) => ({
				path: `src/reviewed-${index}.ts`,
				status: "modified" as const,
				patch: `diff --git a/src/reviewed-${index}.ts b/src/reviewed-${index}.ts`,
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

		const comment = buildPullRequestComment(config, context, {
			...createOutcome(),
			fileSummaries: [],
		});

		assert.match(comment, /### Conclusion/);
		assert.match(comment, /### What Changed/);
		assert.match(comment, /### Review Scope/);
		assert.doesNotMatch(comment, /### Reviewed Changes/);
	});
});
