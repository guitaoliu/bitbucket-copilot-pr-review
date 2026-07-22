import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Tool } from "@github/copilot-sdk";
import type { GitRepository } from "../git/repo.ts";
import type {
	FindingDraft,
	ReviewContext,
	ReviewSummaryDrafts,
} from "../review/types.ts";
import { createReviewToolContext } from "./tools/context.ts";
import { createEmitFindingTool } from "./tools/emit-finding.ts";
import { createReviewTools, REVIEW_TOOL_NAMES } from "./tools/index.ts";
import { createRecordChangeAreaSummaryTool } from "./tools/record-change-area-summary.ts";
import { createRecordPrSummaryTool } from "./tools/record-pr-summary.ts";

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
	reviewableFiles: [
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
};

function createGitStub(overrides: Partial<GitRepository> = {}): GitRepository {
	return {
		readTextFileAtCommit: async () => ({ status: "not_found" as const }),
		...overrides,
	} as GitRepository;
}

function createSummaryDrafts(): ReviewSummaryDrafts {
	return {};
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
			reviewContext,
			createGitStub(),
			[],
			createSummaryDrafts(),
		);

		assert.deepEqual(
			tools.map((tool) => tool.name),
			["record_pr_summary", "record_change_area_summary", "emit_finding"],
		);
		assert.deepEqual(REVIEW_TOOL_NAMES, [
			"record_pr_summary",
			"record_change_area_summary",
			"emit_finding",
		]);
	});

	it("rejects emit_finding when the line is not changed", async () => {
		const drafts: FindingDraft[] = [];
		const tool = createEmitFindingTool(
			createReviewToolContext(
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

	it("loads changed lines lazily for line-level findings", async () => {
		const drafts: FindingDraft[] = [];
		let patchLoads = 0;
		const lazyContext: ReviewContext = {
			...reviewContext,
			reviewableFiles: [
				{
					path: "src/service.ts",
					status: "modified",
					additions: 1,
					deletions: 0,
					isBinary: false,
				},
			],
		};
		const tool = createEmitFindingTool(
			createReviewToolContext(
				lazyContext,
				createGitStub({
					diffFilePatch: async () => {
						patchLoads += 1;
						return [
							"diff --git a/src/service.ts b/src/service.ts",
							"@@ -9,0 +10 @@",
							"+const value = 1;",
						].join("\n");
					},
				}),
				drafts,
				createSummaryDrafts(),
			),
		);
		const handler = getHandler<FindingDraft, string>(tool);

		const result = await handler(
			{
				path: "src/service.ts",
				line: 10,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "Lazy line issue",
				details: "The changed line is validated on demand.",
			},
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "emit_finding",
				arguments: {},
			},
		);

		assert.equal(result, "Recorded finding 1 for src/service.ts:10.");
		assert.equal(patchLoads, 1);
	});

	it("loads renamed file changed lines with old and new pathspecs", async () => {
		const drafts: FindingDraft[] = [];
		let patchPathspec: string | readonly string[] | undefined;
		const lazyContext: ReviewContext = {
			...reviewContext,
			reviewableFiles: [
				{
					path: "src/new-name.ts",
					oldPath: "src/old-name.ts",
					status: "renamed",
					additions: 1,
					deletions: 1,
					isBinary: false,
				},
			],
		};
		const tool = createEmitFindingTool(
			createReviewToolContext(
				lazyContext,
				createGitStub({
					diffFilePatch: async (_base, _head, filePath) => {
						patchPathspec = filePath;
						if (Array.isArray(filePath)) {
							return [
								"diff --git a/src/old-name.ts b/src/new-name.ts",
								"similarity index 55%",
								"rename from src/old-name.ts",
								"rename to src/new-name.ts",
								"--- a/src/old-name.ts",
								"+++ b/src/new-name.ts",
								"@@ -2 +2 @@ keep",
								"-old",
								"+new",
							].join("\n");
						}

						return [
							"diff --git a/src/new-name.ts b/src/new-name.ts",
							"new file mode 100644",
							"--- /dev/null",
							"+++ b/src/new-name.ts",
							"@@ -0,0 +1,2 @@",
							"+keep",
							"+new",
						].join("\n");
					},
				}),
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
				line: 1,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "Rename line issue",
				details: "Line 1 is unchanged after the rename.",
			},
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "emit_finding",
				arguments: {},
			},
		);

		assert.deepEqual(patchPathspec, ["src/old-name.ts", "src/new-name.ts"]);
		assert.deepEqual(result, {
			resultType: "rejected",
			textResultForLlm:
				"Line 1 is not a changed line in src/new-name.ts. Valid changed line ranges: 2",
		});
		assert.deepEqual(drafts, []);
	});

	it("does not load changed lines for file-level findings", async () => {
		const drafts: FindingDraft[] = [];
		let patchLoads = 0;
		const lazyContext: ReviewContext = {
			...reviewContext,
			reviewableFiles: [
				{
					path: "src/service.ts",
					status: "modified",
					additions: 1,
					deletions: 0,
					isBinary: false,
				},
			],
		};
		const tool = createEmitFindingTool(
			createReviewToolContext(
				lazyContext,
				createGitStub({
					diffFilePatch: async () => {
						patchLoads += 1;
						return "";
					},
				}),
				drafts,
				createSummaryDrafts(),
			),
		);
		const handler = getHandler<FindingDraft, string>(tool);

		const result = await handler(
			{
				path: "src/service.ts",
				line: 0,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "File-level issue",
				details: "The file-level finding does not need changed lines.",
			},
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "emit_finding",
				arguments: {},
			},
		);

		assert.equal(result, "Recorded finding 1 for src/service.ts:file.");
		assert.equal(patchLoads, 0);
	});

	it("rejects copied-file findings addressed by the source path", async () => {
		const drafts: FindingDraft[] = [];
		const copiedReviewContext: ReviewContext = {
			...reviewContext,
			reviewableFiles: [
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

	it("marks active read-only tools to skip permission prompts", () => {
		const toolContext = createReviewToolContext(
			reviewContext,
			createGitStub(),
			[],
			createSummaryDrafts(),
		);

		assert.equal(
			createRecordPrSummaryTool(toolContext).skipPermission,
			undefined,
		);
		assert.equal(createEmitFindingTool(toolContext).skipPermission, undefined);
	});

	it("describes finding category fields precisely", () => {
		const toolContext = createReviewToolContext(
			reviewContext,
			createGitStub(),
			[],
			createSummaryDrafts(),
		);
		const emitFindingTool = createEmitFindingTool(toolContext);
		const emitFindingParameters = emitFindingTool.parameters as {
			properties?: Record<string, { description?: string }>;
		};

		assert.equal(
			emitFindingParameters.properties?.category?.description,
			"Optional short category when obvious and helpful, such as security, correctness, data-integrity, concurrency, reliability, performance, or tests.",
		);
	});

	it("records and replaces a pull request summary", async () => {
		const summaryDrafts = createSummaryDrafts();
		const tool = createRecordPrSummaryTool(
			createReviewToolContext(
				reviewContext,
				createGitStub(),
				[],
				summaryDrafts,
			),
		);
		const handler = getHandler<
			{
				summary: string;
				reviewOutcome: "clean" | "findings_recorded";
			},
			string
		>(tool);

		const firstResult = await handler(
			{
				summary: "Adds stricter validation to the renamed service flow.",
				reviewOutcome: "findings_recorded",
			},
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "record_pr_summary",
				arguments: {},
			},
		);
		const secondResult = await handler(
			{
				summary: "Tightens validation and updates the renamed service path.",
				reviewOutcome: "clean",
			},
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
		assert.equal(summaryDrafts.reviewOutcome, "clean");
		assert.match(
			JSON.stringify(tool.parameters),
			/Use short bullet points when that is clearer than one sentence/,
		);
	});

	it("records change areas with reviewed canonical paths", async () => {
		const summaryDrafts = createSummaryDrafts();
		const tool = createRecordChangeAreaSummaryTool(
			createReviewToolContext(
				reviewContext,
				createGitStub(),
				[],
				summaryDrafts,
			),
		);
		const handler = getHandler<
			{ title: string; paths: string[]; summary: string },
			string
		>(tool);

		const result = await handler(
			{
				title: "Validation flow",
				paths: ["src/old-name.ts", "src/multi-hunk.ts", "src/multi-hunk.ts"],
				summary: "Tightens validation across renamed service paths.",
			},
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "record_change_area_summary",
				arguments: {},
			},
		);

		assert.equal(result, "Recorded the change area summary.");
		assert.deepEqual(summaryDrafts.changeAreas, [
			{
				title: "Validation flow",
				paths: ["src/new-name.ts", "src/multi-hunk.ts"],
				summary: "Tightens validation across renamed service paths.",
			},
		]);
	});

	it("keeps reviewed path globs compact in change areas", async () => {
		const summaryDrafts = createSummaryDrafts();
		const tool = createRecordChangeAreaSummaryTool(
			createReviewToolContext(
				reviewContext,
				createGitStub(),
				[],
				summaryDrafts,
			),
		);
		const handler = getHandler<
			{ title: string; paths: string[]; summary: string },
			string
		>(tool);

		const result = await handler(
			{
				title: "Validation flow",
				paths: ["src/*.ts"],
				summary: "Tightens validation across renamed service paths.",
			},
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "record_change_area_summary",
				arguments: {},
			},
		);

		assert.equal(result, "Recorded the change area summary.");
		assert.deepEqual(summaryDrafts.changeAreas, [
			{
				title: "Validation flow",
				paths: ["src/*.ts"],
				summary: "Tightens validation across renamed service paths.",
			},
		]);
	});

	it("rejects change areas that reference files outside the reviewed scope", async () => {
		const summaryDrafts = createSummaryDrafts();
		const tool = createRecordChangeAreaSummaryTool(
			createReviewToolContext(
				reviewContext,
				createGitStub(),
				[],
				summaryDrafts,
			),
		);
		const handler = getHandler<
			{ title: string; paths: string[]; summary: string },
			{ resultType: string; textResultForLlm: string }
		>(tool);

		const result = await handler(
			{
				title: "Generated files",
				paths: ["dist/generated.js"],
				summary: "Updates generated output.",
			},
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "record_change_area_summary",
				arguments: {},
			},
		);

		assert.deepEqual(result, {
			resultType: "rejected",
			textResultForLlm:
				"The file dist/generated.js is not one of the reviewed files.",
		});
		assert.equal(summaryDrafts.changeAreas, undefined);
	});
});
