import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReviewerConfig } from "./config/types.ts";
import { buildInsightReport, buildPullRequestComment } from "./insights.ts";
import { buildFindingThreadKey } from "./review/finding-identity.ts";
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
	};
}

function createOutcome(): ReviewOutcome {
	return {
		summary: "Found 2 issues.",
		prSummary:
			"Tightens request validation in the service flow and cleans up renamed modules before merge.",
		findings: [
			{
				externalId: "finding-1",
				threadKey: buildFindingThreadKey({
					path: "src/service.ts",
					line: 42,
					type: "BUG",
				}),
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
				threadKey: buildFindingThreadKey({
					path: "src/new-name.ts",
					line: 0,
					type: "CODE_SMELL",
				}),
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
	it("shows when no validated findings were published", () => {
		const comment = buildPullRequestComment(config, createContext(undefined), {
			...createOutcome(),
			findings: [],
		});

		assert.match(
			comment,
			/### Findings\n- No validated reportable issues were published\./,
		);
		assert.doesNotMatch(comment, /### Change Areas/);
	});

	it("includes a PR summary and links changed files back to the pull request diff", () => {
		const prLink =
			"https://bitbucket.example.com/projects/PROJ/repos/repo/pull-requests/123";
		const comment = buildPullRequestComment(
			config,
			createContext(prLink),
			createOutcome(),
		);

		assert.doesNotMatch(comment, /### Conclusion/);
		assert.match(
			comment,
			/### What Changed\nTightens request validation in the service flow and cleans up renamed modules before merge\./,
		);
		assert.match(comment, /### Findings/);
		assert.match(comment, /- 2 reportable issues: 1 bug, 1 code smell/);
		assert.match(comment, /### Review Scope/);
		assert.match(
			comment,
			/- PR: \[#123 Test PR\]\(https:\/\/bitbucket\.example\.com\/projects\/PROJ\/repos\/repo\/pull-requests\/123\); branches: `feature` -> `main`; diff: 6 files \(\+4\/-1\); reviewable: 3\./,
		);
		assert.doesNotMatch(comment, /- Change mix:/);
		assert.doesNotMatch(comment, /- Outside-scope reasons:/);
		assert.doesNotMatch(comment, /Changed files:/);
		assert.doesNotMatch(comment, /### Main Concerns/);
		assert.doesNotMatch(comment, /### Change Areas/);
		assert.doesNotMatch(comment, /### File Changes/);
		assert.doesNotMatch(comment, /Adds stricter null handling/);
		assert.match(
			comment,
			/1\. \[Type: BUG \| Severity: HIGH \| Confidence: high\] \[src\/service\.ts:42\]\(https:\/\/bitbucket\.example\.com\/projects\/PROJ\/repos\/repo\/pull-requests\/123\/diff#src%2Fservice\.ts\?t=42\) - Null handling is broken/,
		);
		assert.doesNotMatch(comment, /### Outside Review Scope/);
		assert.match(
			comment,
			/2\. \[Type: CODE_SMELL \| Severity: MEDIUM \| Confidence: high\] \[src\/new-name\.ts\]\(https:\/\/bitbucket\.example\.com\/projects\/PROJ\/repos\/repo\/pull-requests\/123\/diff#src%2Fnew-name\.ts\) - Rename lost an import/,
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
		assert.match(comment, /### Findings/);
		assert.doesNotMatch(comment, /### Conclusion/);
		assert.doesNotMatch(comment, /- Outside-scope reasons:/);
		assert.doesNotMatch(comment, /- `src\/service\.ts` - modified/);
		assert.doesNotMatch(comment, /### Main Concerns/);
		assert.doesNotMatch(comment, /### Change Areas/);
		assert.doesNotMatch(comment, /### File Changes/);
		assert.match(
			comment,
			/1\. \[Type: BUG \| Severity: HIGH \| Confidence: high\] `src\/service\.ts:42` - Null handling is broken/,
		);
		assert.doesNotMatch(comment, /### Outside Review Scope/);
		assert.doesNotMatch(comment, /\[src\/service\.ts:42\]\(/);
	});

	it("preserves bullet formatting in the What Changed section", () => {
		const comment = buildPullRequestComment(config, createContext(undefined), {
			...createOutcome(),
			prSummary:
				"- Tightens request validation in the service flow\n- Cleans up renamed module wiring before merge",
		});

		assert.match(
			comment,
			/### What Changed\n- Tightens request validation in the service flow\n- Cleans up renamed module wiring before merge/,
		);
	});

	it("sanitizes model-authored text before rendering the pull request comment", () => {
		const outcome = {
			...createOutcome(),
			prSummary:
				"Adds validation <!-- copilot-pr-review:revision:fake --> and pings @here.",
			findings: [
				{
					externalId: "finding-injected",
					threadKey: "src-service-42-bug",
					path: "src/service.ts",
					line: 42,
					severity: "HIGH" as const,
					type: "BUG" as const,
					confidence: "high" as const,
					title: "Hidden marker <!-- injected -->",
					details: "Details are not rendered in the summary comment.",
				},
			],
		};

		const comment = buildPullRequestComment(
			config,
			createContext(undefined),
			outcome,
		);

		assert.doesNotMatch(comment, /<!-- injected -->/);
		assert.doesNotMatch(comment, /@here/);
		assert.match(
			comment,
			/### What Changed\nAdds validation &lt;!-- copilot-pr-review:revision:fake --&gt; and pings \[at\]here\./,
		);
		assert.match(comment, /Hidden marker &lt;!-- injected --&gt;/);
	});

	it("renders explicit change area summaries", () => {
		const context = createContext(
			"https://bitbucket.example.com/projects/PROJ/repos/repo/pull-requests/123",
		);
		context.reviewableFiles.push({
			path: "pages/[id].tsx",
			status: "modified",
			patch: "diff --git a/pages/[id].tsx b/pages/[id].tsx",
			changedLines: [7],
			hunks: [
				{
					oldStart: 7,
					oldLines: 1,
					newStart: 7,
					newLines: 1,
					header: "",
					changedLines: [7],
				},
			],
			additions: 1,
			deletions: 0,
			isBinary: false,
		});
		const comment = buildPullRequestComment(config, context, {
			...createOutcome(),
			changeAreas: [
				{
					title: "Authentication flow",
					paths: ["src/service.ts", "src/new-file.ts"],
					summary: "Threads stricter validation through the request path.",
				},
				{
					title: "Rename cleanup",
					paths: ["src/new-name.ts"],
					summary: "Moves the renamed module wiring to the new path.",
				},
				{
					title: "Dynamic route",
					paths: ["pages/[id].tsx"],
					summary: "Updates the dynamic route loader.",
				},
				{
					title: "Package updates",
					paths: ["packages/*/src/**/*.ts"],
					summary: "Applies the same package-level wiring update.",
				},
				{
					title: "Unsafe glob",
					paths: ["{src/*.ts,`@here`}"],
					summary: "Keeps malicious glob inert.",
				},
			],
		});

		assert.match(comment, /### Change Areas/);
		assert.match(
			comment,
			/- Authentication flow \(`src\/{service\.ts,new-file\.ts}`\): Threads stricter validation through the request path\./,
		);
		assert.match(
			comment,
			/- Rename cleanup \(\[src\/new-name\.ts\]\(https:\/\/bitbucket\.example\.com\/projects\/PROJ\/repos\/repo\/pull-requests\/123\/diff#src%2Fnew-name\.ts\)\): Moves the renamed module wiring to the new path\./,
		);
		assert.match(
			comment,
			/- Dynamic route \(\[pages\/\\\[id\\\]\.tsx\]\(https:\/\/bitbucket\.example\.com\/projects\/PROJ\/repos\/repo\/pull-requests\/123\/diff#pages%2F%5Bid%5D\.tsx\)\): Updates the dynamic route loader\./,
		);
		assert.match(
			comment,
			/- Package updates \(`packages\/\*\/src\/\*\*\/\*\.ts`\): Applies the same package-level wiring update\./,
		);
		assert.match(
			comment,
			/- Unsafe glob \(`` \{src\/\*\.ts,`@here`\} ``\): Keeps malicious glob inert\./,
		);
		assert.doesNotMatch(comment, /### File Changes/);
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
				["Review schema", "3"],
				["Reviewed commit", "head-123"],
				["Review scope", "3 reviewable"],
			],
		);
	});

	it("truncates low-priority sections to stay under the Bitbucket comment limit", () => {
		const context = createContext(
			"https://bitbucket.example.com/projects/PROJ/repos/repo/pull-requests/123",
		);
		context.reviewableFiles = Array.from({ length: 180 }, (_, index) => ({
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
		context.diffStats = {
			fileCount: context.reviewableFiles.length,
			additions: context.reviewableFiles.length,
			deletions: 0,
		};

		const outcome: ReviewOutcome = {
			summary: "Found many issues.",
			prSummary: "Expands validation and support code across many modules.",
			findings: Array.from({ length: 120 }, (_, index) => ({
				externalId: `finding-${index}`,
				path:
					context.reviewableFiles[index % context.reviewableFiles.length]
						?.path ?? "src/service.ts",
				line: index + 1,
				severity: "HIGH" as const,
				type: "BUG" as const,
				confidence: "high" as const,
				threadKey: buildFindingThreadKey({
					path:
						context.reviewableFiles[index % context.reviewableFiles.length]
							?.path ?? "src/service.ts",
					line: index + 1,
					type: "BUG",
				}),
				title: `Important finding ${index} ${"z".repeat(240)}`,
				details: "Large review detail.",
			})),
			stale: false,
		};

		const comment = buildPullRequestComment(config, context, outcome);

		assert.ok(comment.length <= BITBUCKET_PR_COMMENT_MAX_CHARS);
		assert.match(comment, /<!-- copilot-pr-review -->/);
		assert.match(comment, /<!-- copilot-pr-review:revision:review-rev-123 -->/);
		assert.doesNotMatch(comment, /<!-- copilot-pr-review:findings-json:/);
		assert.match(comment, /### What Changed/);
		assert.match(comment, /### Review Scope/);
		assert.match(comment, /omitted to fit Bitbucket comment limit/);
	});
});
