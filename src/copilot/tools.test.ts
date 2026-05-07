import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Tool } from "@github/copilot-sdk";
import type { ReviewerConfig } from "../config/types.ts";
import type { GitRepository } from "../git/repo.ts";
import { MAX_REVIEWED_FILES_WITH_PER_FILE_SUMMARIES } from "../review/summary.ts";
import type {
	FindingDraft,
	ReviewContext,
	ReviewSummaryDrafts,
} from "../review/types.ts";
import { createReviewToolContext } from "./tools/context.ts";
import { createEmitFindingTool } from "./tools/emit-finding.ts";
import { createGetPrOverviewTool } from "./tools/get-pr-overview.ts";
import { createReviewTools, REVIEW_TOOL_NAMES } from "./tools/index.ts";
import { createListRecordedFindingsTool } from "./tools/list-recorded-findings.ts";
import { createRecordFileSummaryTool } from "./tools/record-file-summary.ts";
import { createRecordPrSummaryTool } from "./tools/record-pr-summary.ts";
import { createRemoveRecordedFindingTool } from "./tools/remove-recorded-finding.ts";
import { createReplaceRecordedFindingTool } from "./tools/replace-recorded-finding.ts";

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
		maxFindings: 10,
		minConfidence: "high",
		maxPatchChars: 12000,
		defaultFileSliceLines: 3,
		maxFileSliceLines: 4,
		ignorePaths: [],
		skipBranchPrefixes: ["renovate/"],
	},
};

const reviewContext: ReviewContext = {
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
			path: "src/new-name.ts",
			oldPath: "src/old-name.ts",
			status: "renamed",
			patch: "diff --git a/src/old-name.ts b/src/new-name.ts",
			changedLines: [10, 11],
			hunks: [
				{
					oldStart: 10,
					oldLines: 1,
					newStart: 10,
					newLines: 2,
					header: "",
					changedLines: [10, 11],
				},
			],
			additions: 2,
			deletions: 1,
			isBinary: false,
		},
		{
			path: "src/multi-hunk.ts",
			status: "modified",
			patch: [
				"diff --git a/src/multi-hunk.ts b/src/multi-hunk.ts",
				"index 1111111..2222222 100644",
				"--- a/src/multi-hunk.ts",
				"+++ b/src/multi-hunk.ts",
				"@@ -1,3 +1,3 @@",
				"-const first = oldValue;",
				"+const first = newValue;",
				" export { first };",
				"@@ -10,3 +10,4 @@",
				" const stable = true;",
				"+const second = addedValue;",
				" export { stable };",
			].join("\n"),
			changedLines: [1, 10],
			hunks: [
				{
					oldStart: 1,
					oldLines: 3,
					newStart: 1,
					newLines: 3,
					header: "",
					changedLines: [1],
				},
				{
					oldStart: 10,
					oldLines: 3,
					newStart: 10,
					newLines: 4,
					header: "",
					changedLines: [10],
				},
			],
			additions: 2,
			deletions: 1,
			isBinary: false,
		},
	],
	skippedFiles: [],
};

function createGitStub(overrides: Partial<GitRepository> = {}): GitRepository {
	return {
		readFileAtCommit: async () => undefined,
		readTextFileAtCommit: async () => ({ status: "not_found" as const }),
		getPathTypeAtCommit: async () => undefined,
		listFilesAtCommit: async () => [],
		searchTextAtCommit: async () => ({
			matches: [],
			truncated: false,
			totalMatches: 0,
		}),
		...overrides,
	} as GitRepository;
}

function createSummaryDrafts(): ReviewSummaryDrafts {
	return { fileSummaries: [] };
}

function getHandler<TArgs, TResult>(tool: Tool<TArgs>) {
	return tool.handler as (
		args: TArgs,
		invocation: {
			sessionId: string;
			toolCallId: string;
			toolName: string;
			arguments: unknown;
		},
	) => Promise<TResult>;
}

describe("Copilot tools", () => {
	it("creates only the active review tools in the published order", () => {
		const tools = createReviewTools(
			config,
			reviewContext,
			createGitStub(),
			[],
			createSummaryDrafts(),
		);

		assert.deepEqual(
			tools.map((tool) => tool.name),
			[...REVIEW_TOOL_NAMES],
		);
	});

	it("rejects emit_finding when the line is not changed", async () => {
		const drafts: FindingDraft[] = [];
		const tool = createEmitFindingTool(
			createReviewToolContext(
				config,
				reviewContext,
				createGitStub(),
				drafts,
				createSummaryDrafts(),
			),
		);
		const handler = getHandler<
			FindingDraft,
			{ resultType: string; textResultForLlm: string }
		>(tool);

		const result = await handler(
			{
				path: "src/new-name.ts",
				line: 9,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "Wrong line",
				details: "This line is unchanged.",
			},
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "emit_finding",
				arguments: {},
			},
		);

		assert.deepEqual(result, {
			resultType: "rejected",
			textResultForLlm: "Line 9 is not a changed line in src/new-name.ts.",
		});
		assert.deepEqual(drafts, []);
	});

	it("normalizes oldPath findings onto the reviewed head path", async () => {
		const drafts: FindingDraft[] = [];
		const tool = createEmitFindingTool(
			createReviewToolContext(
				config,
				reviewContext,
				createGitStub(),
				drafts,
				createSummaryDrafts(),
			),
		);
		const handler = getHandler<FindingDraft, string>(tool);

		const result = await handler(
			{
				path: "src/old-name.ts",
				line: 10,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "Old path issue",
				details: "The finding started from the base path.",
			},
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "emit_finding",
				arguments: {},
			},
		);

		assert.equal(
			result,
			"Recorded finding 1 for src/new-name.ts:10; normalized path from src/old-name.ts to src/new-name.ts.",
		);
		assert.deepEqual(drafts, [
			{
				path: "src/new-name.ts",
				line: 10,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "Old path issue",
				details: "The finding started from the base path.",
			},
		]);
	});

	it("rejects copied-file findings addressed by the source path", async () => {
		const drafts: FindingDraft[] = [];
		const copiedReviewContext: ReviewContext = {
			...reviewContext,
			reviewedFiles: [
				{
					path: "src/copied.ts",
					oldPath: "src/original.ts",
					status: "copied",
					patch: "diff --git a/src/original.ts b/src/copied.ts",
					changedLines: [10],
					hunks: [
						{
							oldStart: 10,
							oldLines: 0,
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
		};
		const tool = createEmitFindingTool(
			createReviewToolContext(
				config,
				copiedReviewContext,
				createGitStub(),
				drafts,
				createSummaryDrafts(),
			),
		);
		const handler = getHandler<
			FindingDraft,
			{ resultType: string; textResultForLlm: string }
		>(tool);

		const result = await handler(
			{
				path: "src/original.ts",
				line: 10,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "Copied path issue",
				details: "Should not resolve through oldPath for copied files.",
			},
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "emit_finding",
				arguments: {},
			},
		);

		assert.equal(result.resultType, "rejected");
		assert.equal(
			result.textResultForLlm,
			"The file src/original.ts is not one of the reviewed files.",
		);
		assert.deepEqual(drafts, []);
	});

	it("marks only active read-only tools to skip permission prompts", () => {
		const toolContext = createReviewToolContext(
			config,
			reviewContext,
			createGitStub(),
			[],
			createSummaryDrafts(),
		);

		assert.equal(createGetPrOverviewTool(toolContext).skipPermission, true);
		assert.equal(
			createListRecordedFindingsTool(toolContext).skipPermission,
			true,
		);
		assert.equal(
			createRecordPrSummaryTool(toolContext).skipPermission,
			undefined,
		);
		assert.equal(
			createRecordFileSummaryTool(toolContext).skipPermission,
			undefined,
		);
		assert.equal(
			createRemoveRecordedFindingTool(toolContext).skipPermission,
			undefined,
		);
		assert.equal(
			createReplaceRecordedFindingTool(toolContext).skipPermission,
			undefined,
		);
		assert.equal(createEmitFindingTool(toolContext).skipPermission, undefined);
	});

	it("describes overview and finding category fields precisely", () => {
		const toolContext = createReviewToolContext(
			config,
			reviewContext,
			createGitStub(),
			[],
			createSummaryDrafts(),
		);
		const overviewTool = createGetPrOverviewTool(toolContext);
		const emitFindingTool = createEmitFindingTool(toolContext);
		const emitFindingParameters = emitFindingTool.parameters as {
			properties?: Record<string, { description?: string }>;
		};

		assert.equal(
			overviewTool.description,
			"Get canonical review scope: reviewed files you may target and skipped files you must ignore. Use builtin bash for diff and code inspection.",
		);
		assert.equal(
			emitFindingParameters.properties?.category?.description,
			"Optional short category when obvious and helpful, such as security, correctness, data-integrity, concurrency, reliability, performance, or tests.",
		);
	});

	it("returns minimal canonical scope for reviewed and skipped files", async () => {
		const tool = createGetPrOverviewTool(
			createReviewToolContext(
				config,
				{
					...reviewContext,
					skippedFiles: [
						{
							path: "dist/generated.js",
							status: "modified",
							reason: "ignored by policy",
						},
					],
				},
				createGitStub(),
				[],
				createSummaryDrafts(),
			),
		);
		const handler = getHandler<unknown, unknown>(tool);

		const result = await handler(
			{},
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "get_pr_overview",
				arguments: {},
			},
		);

		assert.deepEqual(result, {
			reviewedFiles: [
				{
					path: "src/new-name.ts",
					oldPath: "src/old-name.ts",
					status: "renamed",
				},
				{
					path: "src/multi-hunk.ts",
					status: "modified",
				},
			],
			skippedFiles: [
				{
					path: "dist/generated.js",
					status: "modified",
					reason: "ignored by policy",
				},
			],
		});
	});

	it("rejects unexpected overview arguments", async () => {
		const tool = createGetPrOverviewTool(
			createReviewToolContext(
				config,
				reviewContext,
				createGitStub(),
				[],
				createSummaryDrafts(),
			),
		);
		const handler = getHandler<unknown, unknown>(tool);

		const result = await handler(
			{ reviewedFilesOffset: 1 },
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "get_pr_overview",
				arguments: {},
			},
		);

		assert.deepEqual(result, {
			resultType: "rejected",
			textResultForLlm:
				'Invalid PR overview payload: Unrecognized key: "reviewedFilesOffset"',
		});
	});

	it("lists recorded findings with stable numbering", async () => {
		const drafts: FindingDraft[] = [
			{
				path: "src/new-name.ts",
				line: 10,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "Existing issue",
				details: "Existing details",
			},
		];
		const tool = createListRecordedFindingsTool(
			createReviewToolContext(
				config,
				reviewContext,
				createGitStub(),
				drafts,
				createSummaryDrafts(),
			),
		);
		const handler = getHandler<unknown, unknown>(tool);

		const result = await handler(
			{},
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "list_recorded_findings",
				arguments: {},
			},
		);

		assert.deepEqual(result, {
			count: 1,
			findings: [
				{
					findingNumber: 1,
					path: "src/new-name.ts",
					line: 10,
					severity: "HIGH",
					type: "BUG",
					confidence: "high",
					title: "Existing issue",
					details: "Existing details",
				},
			],
		});
	});

	it("replaces an existing finding draft", async () => {
		const drafts: FindingDraft[] = [
			{
				path: "src/new-name.ts",
				line: 10,
				severity: "MEDIUM",
				type: "CODE_SMELL",
				confidence: "medium",
				title: "Old issue",
				details: "Old details",
			},
		];
		const tool = createReplaceRecordedFindingTool(
			createReviewToolContext(
				config,
				reviewContext,
				createGitStub(),
				drafts,
				createSummaryDrafts(),
			),
		);
		const handler = getHandler<
			FindingDraft & { findingNumber: number },
			string
		>(tool);

		const result = await handler(
			{
				findingNumber: 1,
				path: "src/new-name.ts",
				line: 11,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "New issue",
				details: "New details",
			},
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "replace_recorded_finding",
				arguments: {},
			},
		);

		assert.equal(result, "Replaced finding 1 with src/new-name.ts:11.");
		assert.deepEqual(drafts, [
			{
				path: "src/new-name.ts",
				line: 11,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "New issue",
				details: "New details",
			},
		]);
	});

	it("rejects replacing an existing finding when the line is unchanged", async () => {
		const drafts: FindingDraft[] = [
			{
				path: "src/new-name.ts",
				line: 10,
				severity: "MEDIUM",
				type: "CODE_SMELL",
				confidence: "medium",
				title: "Old issue",
				details: "Old details",
			},
		];
		const tool = createReplaceRecordedFindingTool(
			createReviewToolContext(
				config,
				reviewContext,
				createGitStub(),
				drafts,
				createSummaryDrafts(),
			),
		);
		const handler = getHandler<
			FindingDraft & { findingNumber: number },
			{ resultType: string; textResultForLlm: string }
		>(tool);

		const result = await handler(
			{
				findingNumber: 1,
				path: "src/new-name.ts",
				line: 9,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "New issue",
				details: "New details",
			},
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "replace_recorded_finding",
				arguments: {},
			},
		);

		assert.deepEqual(result, {
			resultType: "rejected",
			textResultForLlm: "Line 9 is not a changed line in src/new-name.ts.",
		});
		assert.deepEqual(drafts, [
			{
				path: "src/new-name.ts",
				line: 10,
				severity: "MEDIUM",
				type: "CODE_SMELL",
				confidence: "medium",
				title: "Old issue",
				details: "Old details",
			},
		]);
	});

	it("removes an existing finding draft and compacts numbering", async () => {
		const drafts: FindingDraft[] = [
			{
				path: "src/new-name.ts",
				line: 10,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "First issue",
				details: "First details",
			},
			{
				path: "src/new-name.ts",
				line: 11,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "Second issue",
				details: "Second details",
			},
		];
		const tool = createRemoveRecordedFindingTool(
			createReviewToolContext(
				config,
				reviewContext,
				createGitStub(),
				drafts,
				createSummaryDrafts(),
			),
		);
		const handler = getHandler<{ findingNumber: number }, string>(tool);

		const result = await handler(
			{ findingNumber: 1 },
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "remove_recorded_finding",
				arguments: {},
			},
		);

		assert.equal(
			result,
			"Removed finding 1 for src/new-name.ts:10. Remaining findings: 1.",
		);
		assert.deepEqual(drafts, [
			{
				path: "src/new-name.ts",
				line: 11,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "Second issue",
				details: "Second details",
			},
		]);
	});

	it("rejects malformed remove finding payloads before mutating drafts", async () => {
		const drafts: FindingDraft[] = [
			{
				path: "src/new-name.ts",
				line: 10,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "First issue",
				details: "First details",
			},
		];
		const tool = createRemoveRecordedFindingTool(
			createReviewToolContext(
				config,
				reviewContext,
				createGitStub(),
				drafts,
				createSummaryDrafts(),
			),
		);
		const handler = tool.handler as (
			args: { findingNumber: unknown },
			invocation: {
				sessionId: string;
				toolCallId: string;
				toolName: string;
				arguments: unknown;
			},
		) => Promise<{ resultType: string; textResultForLlm: string }>;

		const result = await handler(
			{ findingNumber: "1" },
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "remove_recorded_finding",
				arguments: {},
			},
		);

		assert.equal(result.resultType, "rejected");
		assert.match(result.textResultForLlm, /Invalid remove-finding payload/);
		assert.equal(drafts.length, 1);
	});

	it("rejects removing a missing finding draft", async () => {
		const drafts: FindingDraft[] = [];
		const tool = createRemoveRecordedFindingTool(
			createReviewToolContext(
				config,
				reviewContext,
				createGitStub(),
				drafts,
				createSummaryDrafts(),
			),
		);
		const handler = getHandler<
			{ findingNumber: number },
			{ resultType: string; textResultForLlm: string }
		>(tool);

		const result = await handler(
			{ findingNumber: 1 },
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "remove_recorded_finding",
				arguments: {},
			},
		);

		assert.equal(result.resultType, "rejected");
		assert.equal(
			result.textResultForLlm,
			"Finding 1 does not exist. Recorded findings: 0.",
		);
	});

	it("rejects replacing a missing finding draft", async () => {
		const drafts: FindingDraft[] = [];
		const tool = createReplaceRecordedFindingTool(
			createReviewToolContext(
				config,
				reviewContext,
				createGitStub(),
				drafts,
				createSummaryDrafts(),
			),
		);
		const handler = getHandler<
			FindingDraft & { findingNumber: number },
			{ resultType: string; textResultForLlm: string }
		>(tool);

		const result = await handler(
			{
				findingNumber: 1,
				path: "src/new-name.ts",
				line: 10,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "Issue",
				details: "Details",
			},
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "replace_recorded_finding",
				arguments: {},
			},
		);

		assert.equal(result.resultType, "rejected");
		assert.equal(
			result.textResultForLlm,
			"Finding 1 does not exist. Recorded findings: 0.",
		);
	});

	it("rejects malformed replace finding payloads before indexing drafts", async () => {
		const drafts: FindingDraft[] = [
			{
				path: "src/new-name.ts",
				line: 10,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "Issue",
				details: "Details",
			},
		];
		const tool = createReplaceRecordedFindingTool(
			createReviewToolContext(
				config,
				reviewContext,
				createGitStub(),
				drafts,
				createSummaryDrafts(),
			),
		);
		const handler = tool.handler as (
			args: Omit<FindingDraft, "line"> & {
				line: number;
				findingNumber: unknown;
			},
			invocation: {
				sessionId: string;
				toolCallId: string;
				toolName: string;
				arguments: unknown;
			},
		) => Promise<{ resultType: string; textResultForLlm: string }>;

		const result = await handler(
			{
				findingNumber: "1",
				path: "src/new-name.ts",
				line: 10,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "Issue",
				details: "Details",
			},
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "replace_recorded_finding",
				arguments: {},
			},
		);

		assert.equal(result.resultType, "rejected");
		assert.match(result.textResultForLlm, /Invalid replace-finding payload/);
		assert.equal(drafts[0]?.title, "Issue");
	});

	it("records and replaces a pull request summary", async () => {
		const summaryDrafts = createSummaryDrafts();
		const tool = createRecordPrSummaryTool(
			createReviewToolContext(
				config,
				reviewContext,
				createGitStub(),
				[],
				summaryDrafts,
			),
		);
		const handler = getHandler<{ summary: string }, string>(tool);

		const firstResult = await handler(
			{ summary: "Adds stricter validation to the renamed service flow." },
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "record_pr_summary",
				arguments: {},
			},
		);
		const secondResult = await handler(
			{ summary: "Tightens validation and updates the renamed service path." },
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "record_pr_summary",
				arguments: {},
			},
		);

		assert.equal(firstResult, "Recorded the pull request summary.");
		assert.equal(secondResult, "Recorded the pull request summary.");
		assert.equal(
			summaryDrafts.prSummary,
			"Tightens validation and updates the renamed service path.",
		);
		assert.match(
			JSON.stringify(tool.parameters),
			/Use short bullet points when that is clearer than one sentence/,
		);
	});

	it("records and updates a file summary for a reviewed file", async () => {
		const summaryDrafts = createSummaryDrafts();
		const tool = createRecordFileSummaryTool(
			createReviewToolContext(
				config,
				reviewContext,
				createGitStub(),
				[],
				summaryDrafts,
			),
		);
		const handler = getHandler<{ path: string; summary: string }, string>(tool);

		const firstResult = await handler(
			{
				path: "src/new-name.ts",
				summary: "Moves the renamed file to the new path and updates exports.",
			},
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "record_file_summary",
				arguments: {},
			},
		);
		const secondResult = await handler(
			{
				path: "src/new-name.ts",
				summary: "Renames the file and adjusts the exported API.",
			},
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "record_file_summary",
				arguments: {},
			},
		);

		assert.equal(firstResult, "Recorded the summary for src/new-name.ts.");
		assert.equal(secondResult, "Updated the summary for src/new-name.ts.");
		assert.deepEqual(summaryDrafts.fileSummaries, [
			{
				path: "src/new-name.ts",
				summary: "Renames the file and adjusts the exported API.",
			},
		]);
	});

	it("rejects a file summary for a non-reviewed file", async () => {
		const summaryDrafts = createSummaryDrafts();
		const tool = createRecordFileSummaryTool(
			createReviewToolContext(
				config,
				reviewContext,
				createGitStub(),
				[],
				summaryDrafts,
			),
		);
		const handler = getHandler<
			{ path: string; summary: string },
			{ resultType: string; textResultForLlm: string }
		>(tool);

		const result = await handler(
			{ path: "src/not-reviewed.ts", summary: "Nope." },
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "record_file_summary",
				arguments: {},
			},
		);

		assert.equal(result.resultType, "rejected");
		assert.equal(
			result.textResultForLlm,
			"The file src/not-reviewed.ts is not one of the reviewed files.",
		);
	});

	it("rejects file summaries when the review is above the cutoff", async () => {
		const summaryDrafts = createSummaryDrafts();
		const tool = createRecordFileSummaryTool(
			createReviewToolContext(
				config,
				{
					...reviewContext,
					reviewedFiles: Array.from(
						{ length: MAX_REVIEWED_FILES_WITH_PER_FILE_SUMMARIES + 1 },
						(_, index) => ({
							path: `src/large-${index}.ts`,
							status: "modified" as const,
							patch: `diff --git a/src/large-${index}.ts b/src/large-${index}.ts`,
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
				},
				createGitStub(),
				[],
				summaryDrafts,
			),
		);
		const handler = getHandler<
			{ path: string; summary: string },
			{ resultType: string; textResultForLlm: string }
		>(tool);

		const result = await handler(
			{ path: "src/large-0.ts", summary: "Nope." },
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "record_file_summary",
				arguments: {},
			},
		);

		assert.equal(result.resultType, "rejected");
		assert.equal(
			result.textResultForLlm,
			"Per-file summaries are disabled when reviewed files exceed 25.",
		);
	});
});
