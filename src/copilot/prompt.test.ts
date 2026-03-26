import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SystemMessageCustomizeConfig } from "@github/copilot-sdk";

import type { ReviewerConfig } from "../config/types.ts";
import { MAX_REVIEWED_FILES_WITH_PER_FILE_SUMMARIES } from "../review/summary.ts";
import type { ReviewContext } from "../review/types.ts";
import { buildPrompt, buildSystemMessage } from "./prompt.ts";

function expectCustomizeSystemMessage(
	systemMessage: ReturnType<typeof buildSystemMessage>,
): SystemMessageCustomizeConfig {
	assert.equal(systemMessage.mode, "customize");
	return systemMessage;
}

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
		reporter: "GitHub Copilot",
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
		skipBranchPrefixes: ["renovate/"],
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
	it("keeps trusted pull request context and repo instructions in the user prompt", () => {
		const prompt = buildPrompt(config, {
			...context,
			repoAgentsInstructions: [
				{
					path: "AGENTS.md",
					appliesTo: ["."],
					content: "root instructions",
				},
			],
		});

		assert.match(
			prompt,
			/Please review this Bitbucket Data Center pull request/,
		);
		assert.match(prompt, /<pull_request_context>/);
		assert.match(prompt, /title: Test PR/);
		assert.match(prompt, /head_commit: head-123/);
		assert.match(
			prompt,
			/Repository instructions from trusted AGENTS\.md files:/,
		);
		assert.match(prompt, /root instructions/);
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
		assert.doesNotMatch(prompt, /Finding taxonomy:/);
		assert.doesNotMatch(prompt, /Review checklist:/);
	});
});

describe("buildSystemMessage", () => {
	it("moves stable review policy into customized system sections", () => {
		const systemMessage = expectCustomizeSystemMessage(
			buildSystemMessage(config, context.reviewedFiles.length),
		);

		assert.match(
			systemMessage.sections?.guidelines?.content ?? "",
			/Missing or inadequate tests are reportable only when the gap materially weakens confidence in a meaningful behavior change/,
		);
		assert.match(
			systemMessage.sections?.guidelines?.content ?? "",
			/Review checklist:/,
		);
		assert.match(
			systemMessage.sections?.environment_context?.content ?? "",
			/pass concrete repo-relative directories as a directories array; wildcard directory patterns are not supported/,
		);
		assert.match(
			systemMessage.sections?.code_change_rules?.content ?? "",
			/Use emit_finding only for concrete validated issues\. If a concern is still a question, investigate more or drop it/,
		);
		assert.match(
			systemMessage.sections?.tool_efficiency?.content ?? "",
			/Call get_pr_overview first to understand the PR, changed files, file summaries, and CI context/,
		);
		assert.match(
			systemMessage.sections?.last_instructions?.content ?? "",
			/Return only a short plain-text summary, not JSON/,
		);
	});

	it("includes review taxonomy and constraints in the system message", () => {
		const systemMessage = expectCustomizeSystemMessage(
			buildSystemMessage(config, context.reviewedFiles.length),
		);

		assert.match(
			systemMessage.sections?.guidelines?.content ?? "",
			/No question-shaped or speculative findings: verify the code path or drop the concern/,
		);
		assert.match(
			systemMessage.sections?.guidelines?.content ?? "",
			/Finding taxonomy:/,
		);
		assert.match(
			systemMessage.sections?.guidelines?.content ?? "",
			/- BUG: concrete correctness, data integrity, contract, state-transition/,
		);
		assert.match(
			systemMessage.sections?.guidelines?.content ?? "",
			/- VULNERABILITY: concrete security defects such as auth or authz bypass/,
		);
		assert.match(
			systemMessage.sections?.guidelines?.content ?? "",
			/- CODE_SMELL: only for substantial merge-relevant fragility with concrete impact/,
		);
	});

	it("turns off per-file summary rules for large reviews in the system message", () => {
		const systemMessage = expectCustomizeSystemMessage(
			buildSystemMessage(
				config,
				MAX_REVIEWED_FILES_WITH_PER_FILE_SUMMARIES + 1,
			),
		);

		assert.match(
			systemMessage.sections?.code_change_rules?.content ?? "",
			/do not call record_file_summary for this review/,
		);
		assert.match(
			systemMessage.sections?.tool_efficiency?.content ?? "",
			/Do not record per-file summaries when reviewed files exceed 25/,
		);
	});
});
