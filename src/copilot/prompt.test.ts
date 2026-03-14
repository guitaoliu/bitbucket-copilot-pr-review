import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ReviewerConfig } from "../config/types.ts";
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
			/For any non-trivial behavior change, verify that tests cover the new or changed behavior at an appropriate level/,
		);
	});
});
