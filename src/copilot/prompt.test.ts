import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ReviewerConfig } from "../config/types.ts";
import { MAX_REVIEWED_FILES_WITH_PER_FILE_SUMMARIES } from "../review/summary.ts";
import type { ReviewContext } from "../review/types.ts";
import { buildPrompt } from "./prompt.ts";

const config: ReviewerConfig = {
	repoRoot: "/tmp/repo",
	gitRemoteName: "origin",
	logLevel: "info",
	bitbucket: {
		baseUrl: "https://bitbucket.example.com",
		projectKey: "PROJ",
		repoSlug: "repo",
		prId: 123,
		auth: { type: "bearer", token: "token" },
		tls: { insecureSkipVerify: false },
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
		maxFindings: 3,
		minConfidence: "high",
		maxPatchChars: 12000,
		defaultFileSliceLines: 250,
		maxFileSliceLines: 400,
		ignorePaths: [],
	},
};

const context: ReviewContext = {
	repoRoot: "/tmp/repo",
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
	diffStats: { fileCount: 1, additions: 2, deletions: 1 },
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
			deletions: 1,
			isBinary: false,
		},
	],
	skippedFiles: [],
};

describe("buildPrompt", () => {
	it("requires test coverage for meaningful behavior changes", () => {
		const prompt = buildPrompt(config, context);

		assert.match(
			prompt,
			/Treat missing or inadequate test coverage for a meaningful behavior change as a reportable issue/,
		);
		assert.match(
			prompt,
			/Tests: for every non-trivial behavior change, verify positive, negative, and edge-case coverage at an appropriate level/,
		);
	});

	it("defines a concrete review checklist and finding taxonomy", () => {
		const prompt = buildPrompt(config, context);

		assert.match(prompt, /Review checklist:/);
		assert.match(
			prompt,
			/Security and access control: authentication, authorization/,
		);
		assert.match(
			prompt,
			/Data integrity and concurrency: transactions, retries, idempotency/,
		);
		assert.match(prompt, /Finding taxonomy:/);
		assert.match(
			prompt,
			/- BUG: concrete correctness, data integrity, contract, state-transition/,
		);
		assert.match(
			prompt,
			/- VULNERABILITY: concrete security defects such as auth or authz bypass/,
		);
		assert.match(
			prompt,
			/- CODE_SMELL: only for substantial merge-relevant fragility with concrete impact/,
		);
	});

	it("discourages speculative and question-shaped findings", () => {
		const prompt = buildPrompt(config, context);

		assert.match(
			prompt,
			/No question-shaped or speculative findings: verify the code path or drop the concern/,
		);
		assert.match(
			prompt,
			/pass repo-relative directories as a directories array/,
		);
		assert.match(
			prompt,
			/Use emit_finding only for concrete validated issues\. If a concern is still a question, investigate more or drop it/,
		);
	});

	it("disables per-file summary instructions for large reviews", () => {
		const prompt = buildPrompt(config, {
			...context,
			reviewedFiles: Array.from(
				{ length: MAX_REVIEWED_FILES_WITH_PER_FILE_SUMMARIES + 1 },
				(_, index) => ({
					path: `src/example-${index}.ts`,
					status: "modified" as const,
					patch: `diff --git a/src/example-${index}.ts b/src/example-${index}.ts`,
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
			),
			diffStats: {
				fileCount: MAX_REVIEWED_FILES_WITH_PER_FILE_SUMMARIES + 1,
				additions: MAX_REVIEWED_FILES_WITH_PER_FILE_SUMMARIES + 1,
				deletions: 0,
			},
		});

		assert.match(
			prompt,
			/new_file_summaries|per_file_summaries: disabled|per-file summaries are disabled/i,
		);
		assert.match(prompt, /do not call record_file_summary for this review/);
		assert.match(
			prompt,
			/Do not record per-file summaries when reviewed files exceed 25/,
		);
	});
});
