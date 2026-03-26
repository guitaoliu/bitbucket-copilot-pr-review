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
import { createGetCiSummaryTool } from "./tools/get-ci-summary.ts";
import { createGetFileContentTool } from "./tools/get-file-content.ts";
import { createGetFileDiffTool } from "./tools/get-file-diff.ts";
import { createGetFileDiffHunkTool } from "./tools/get-file-diff-hunk.ts";
import { createGetFileListByDirectoryTool } from "./tools/get-file-list-by-directory.ts";
import { createGetPrOverviewTool } from "./tools/get-pr-overview.ts";
import { createGetRelatedFileContentTool } from "./tools/get-related-file-content.ts";
import { createGetRelatedTestsTool } from "./tools/get-related-tests.ts";
import { createListChangedFilesTool } from "./tools/list-changed-files.ts";
import { createListRecordedFindingsTool } from "./tools/list-recorded-findings.ts";
import { createRecordFileSummaryTool } from "./tools/record-file-summary.ts";
import { createRecordPrSummaryTool } from "./tools/record-pr-summary.ts";
import { createRemoveRecordedFindingTool } from "./tools/remove-recorded-finding.ts";
import { createReplaceRecordedFindingTool } from "./tools/replace-recorded-finding.ts";
import { createSearchSymbolNameTool } from "./tools/search-symbol-name.ts";
import { createSearchTextInRepoTool } from "./tools/search-text-in-repo.ts";

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
	it("reads base content from oldPath for renamed files", async () => {
		const git = createGitStub({
			readTextFileAtCommit: async (commit, filePath) => {
				assert.equal(commit, "base-123");
				assert.equal(filePath, "src/old-name.ts");
				return {
					status: "ok" as const,
					content: ["one", "two", "three", "four", "five"].join("\n"),
				};
			},
		});
		const tool = createGetFileContentTool(
			createReviewToolContext(
				config,
				reviewContext,
				git,
				[],
				createSummaryDrafts(),
			),
		);
		const handler = getHandler<
			{
				path: string;
				version: "head" | "base";
				startLine?: number;
				endLine?: number;
			},
			unknown
		>(tool);

		const result = await handler(
			{ path: "src/new-name.ts", version: "base", startLine: 2, endLine: 5 },
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "get_file_content",
				arguments: {},
			},
		);

		assert.deepEqual(result, {
			path: "src/old-name.ts",
			version: "base",
			totalLines: 5,
			returnedStartLine: 2,
			returnedEndLine: 5,
			content: "2: two\n3: three\n4: four\n5: five",
		});
	});

	it("reads base content from the current path for copied files", async () => {
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
		const git = createGitStub({
			readTextFileAtCommit: async (commit, filePath) => {
				assert.equal(commit, "base-123");
				assert.equal(filePath, "src/copied.ts");
				return {
					status: "ok" as const,
					content: ["one", "two"].join("\n"),
				};
			},
		});
		const tool = createGetFileContentTool(
			createReviewToolContext(
				config,
				copiedReviewContext,
				git,
				[],
				createSummaryDrafts(),
			),
		);
		const handler = getHandler<
			{
				path: string;
				version: "head" | "base";
				startLine?: number;
				endLine?: number;
			},
			unknown
		>(tool);

		const result = await handler(
			{ path: "src/copied.ts", version: "base" },
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "get_file_content",
				arguments: {},
			},
		);

		assert.deepEqual(result, {
			path: "src/copied.ts",
			version: "base",
			totalLines: 2,
			returnedStartLine: 1,
			returnedEndLine: 2,
			content: "1: one\n2: two",
		});
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

		assert.equal(
			result,
			"Recorded finding 1 for src/new-name.ts:file; requested line 9 is not a changed line in src/new-name.ts; stored as a file-level annotation.",
		);
		assert.deepEqual(drafts, [
			{
				path: "src/new-name.ts",
				line: 0,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "Wrong line",
				details: "This line is unchanged.",
			},
		]);
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
		const handler = getHandler<
			FindingDraft,
			{ resultType: string; textResultForLlm: string }
		>(tool);

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

	it("normalizes search options and directory restriction", async () => {
		const git = createGitStub({
			getPathTypeAtCommit: async (commit, filePath) => {
				assert.equal(commit, "head-123");
				assert.equal(filePath, "src");
				return "directory";
			},
			searchTextAtCommit: async (commit, query, options) => {
				assert.equal(commit, "head-123");
				assert.equal(query, "needle");
				assert.deepEqual(options, {
					directoryPaths: ["src"],
					limit: 200,
					mode: "literal",
					wholeWord: true,
				});
				return {
					matches: [{ path: "src/new-name.ts", line: 10, text: "needle" }],
					truncated: false,
					totalMatches: 1,
				};
			},
		});
		const tool = createSearchTextInRepoTool(
			createReviewToolContext(
				config,
				reviewContext,
				git,
				[],
				createSummaryDrafts(),
			),
		);
		const handler = getHandler<
			{
				query: string;
				version: "head" | "base";
				directories?: string[];
				mode?: "literal" | "regex";
				wholeWord?: boolean;
				limit?: number;
			},
			unknown
		>(tool);

		const result = await handler(
			{
				query: "needle",
				version: "head",
				directories: ["src"],
				wholeWord: true,
				limit: 999,
			},
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "search_text_in_repo",
				arguments: {},
			},
		);

		assert.deepEqual(result, {
			query: "needle",
			version: "head",
			mode: "literal",
			wholeWord: true,
			directories: ["src"],
			matches: [{ path: "src/new-name.ts", line: 10, text: "needle" }],
			truncated: false,
			totalMatches: 1,
			unfilteredMatchCount: 1,
			filteredMatchCount: 0,
			safeTotalMatches: 1,
		});
	});

	it("rejects invalid regex searches without aborting the tool", async () => {
		const tool = createSearchTextInRepoTool(
			createReviewToolContext(
				config,
				reviewContext,
				createGitStub(),
				[],
				createSummaryDrafts(),
			),
		);
		const handler = getHandler<
			{
				query: string;
				version: "head" | "base";
				mode?: "literal" | "regex";
			},
			{ resultType: string; textResultForLlm: string }
		>(tool);

		const result = await handler(
			{ query: "(", version: "head", mode: "regex" },
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "search_text_in_repo",
				arguments: {},
			},
		);

		assert.equal(result.resultType, "rejected");
		assert.match(result.textResultForLlm, /^Invalid regex search pattern:/);
	});

	it("rejects file paths passed as directories for repo search", async () => {
		const git = createGitStub({
			getPathTypeAtCommit: async () => "file",
		});
		const tool = createSearchTextInRepoTool(
			createReviewToolContext(
				config,
				reviewContext,
				git,
				[],
				createSummaryDrafts(),
			),
		);
		const handler = getHandler<
			{
				query: string;
				version: "head" | "base";
				directories?: string[];
			},
			{ resultType: string; textResultForLlm: string }
		>(tool);

		const result = await handler(
			{
				query: "needle",
				version: "head",
				directories: ["src/new-name.ts"],
			},
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "search_text_in_repo",
				arguments: {},
			},
		);

		assert.equal(result.resultType, "rejected");
		assert.equal(
			result.textResultForLlm,
			"Directory access rejected: src/new-name.ts is a file, not a directory.",
		);
	});

	it("filters blocked files out of symbol search results", async () => {
		const git = createGitStub({
			getPathTypeAtCommit: async () => "directory",
			searchTextAtCommit: async () => ({
				matches: [
					{ path: "src/new-name.ts", line: 10, text: "PasswordChallenge" },
					{ path: "src/.env.local", line: 1, text: "PasswordChallenge" },
				],
				truncated: false,
				totalMatches: 2,
			}),
		});
		const tool = createSearchSymbolNameTool(
			createReviewToolContext(
				config,
				reviewContext,
				git,
				[],
				createSummaryDrafts(),
			),
		);
		const handler = getHandler<
			{
				symbol: string;
				version: "head" | "base";
				directories?: string[];
			},
			unknown
		>(tool);

		const result = await handler(
			{
				symbol: "PasswordChallenge",
				version: "head",
				directories: ["src"],
			},
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "search_symbol_name",
				arguments: {},
			},
		);

		assert.deepEqual(result, {
			symbol: "PasswordChallenge",
			version: "head",
			directories: ["src"],
			matches: [
				{ path: "src/new-name.ts", line: 10, text: "PasswordChallenge" },
			],
			truncated: true,
			totalMatches: 1,
			unfilteredMatchCount: 2,
			filteredMatchCount: 1,
			safeTotalMatches: 1,
		});
	});

	it("preserves git-layer truncation metadata for text search", async () => {
		const git = createGitStub({
			getPathTypeAtCommit: async () => "directory",
			searchTextAtCommit: async () => ({
				matches: [{ path: "src/new-name.ts", line: 10, text: "needle" }],
				truncated: true,
				totalMatches: 2,
			}),
		});
		const tool = createSearchTextInRepoTool(
			createReviewToolContext(
				config,
				reviewContext,
				git,
				[],
				createSummaryDrafts(),
			),
		);
		const handler = getHandler<
			{
				query: string;
				version: "head" | "base";
				limit?: number;
				directories?: string[];
			},
			unknown
		>(tool);

		const result = await handler(
			{ query: "needle", version: "head", directories: ["src"], limit: 1 },
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "search_text_in_repo",
				arguments: {},
			},
		);

		assert.deepEqual(result, {
			query: "needle",
			version: "head",
			mode: "literal",
			wholeWord: false,
			directories: ["src"],
			matches: [{ path: "src/new-name.ts", line: 10, text: "needle" }],
			truncated: true,
			totalMatches: 1,
			unfilteredMatchCount: 2,
			filteredMatchCount: 0,
			safeTotalMatches: 2,
		});
	});

	it("suggests nearby tests from concrete directories", async () => {
		const git = createGitStub({
			getPathTypeAtCommit: async (_commit, filePath) => {
				if (filePath === "src" || filePath === "test") {
					return "directory";
				}

				return undefined;
			},
			listFilesAtCommit: async (commit, directoryPaths) => {
				assert.equal(commit, "head-123");
				if (directoryPaths?.[0] === "src") {
					return [
						"src/new-name.ts",
						"src/new-name.test.ts",
						"src/helper.spec.ts",
					];
				}

				if (directoryPaths?.[0] === "test") {
					return ["test/new-name.test.ts", "test/unrelated.test.ts"];
				}

				return [];
			},
		});
		const tool = createGetRelatedTestsTool(
			createReviewToolContext(
				config,
				reviewContext,
				git,
				[],
				createSummaryDrafts(),
			),
		);
		const handler = getHandler<
			{ path: string; version?: "head" | "base"; limit?: number },
			unknown
		>(tool);

		const result = await handler(
			{ path: "src/new-name.ts", limit: 3 },
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "get_related_tests",
				arguments: {},
			},
		);

		assert.deepEqual(result, {
			path: "src/new-name.ts",
			version: "head",
			directoriesSearched: ["src", "test", "tests"],
			candidateCount: 2,
			candidates: [
				{ path: "test/new-name.test.ts", score: 20 },
				{ path: "src/new-name.test.ts", score: 15 },
			],
		});
	});

	it("lists files across multiple directories and filters blocked descendants", async () => {
		const git = createGitStub({
			getPathTypeAtCommit: async (_commit, filePath) => {
				assert.match(filePath, /^(src|test)$/);
				return "directory";
			},
			listFilesAtCommit: async (commit, directoryPaths) => {
				assert.equal(commit, "head-123");
				assert.deepEqual(directoryPaths, ["src", "test"]);
				return ["src/new-name.ts", "src/.env.local", "test/review.test.ts"];
			},
		});
		const tool = createGetFileListByDirectoryTool(
			createReviewToolContext(
				config,
				reviewContext,
				git,
				[],
				createSummaryDrafts(),
			),
		);
		const handler = getHandler<
			{ directories?: string[]; version: "head" | "base"; limit?: number },
			unknown
		>(tool);

		const result = await handler(
			{ directories: ["src", "test"], version: "head" },
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "get_file_list_by_directory",
				arguments: {},
			},
		);

		assert.deepEqual(result, {
			directories: ["src", "test"],
			version: "head",
			filteredFileCount: 1,
			files: ["src/new-name.ts", "test/review.test.ts"],
			truncated: true,
			totalFiles: 2,
		});
	});

	it("rejects reversed file-content line ranges", async () => {
		const tool = createGetFileContentTool(
			createReviewToolContext(
				config,
				reviewContext,
				createGitStub(),
				[],
				createSummaryDrafts(),
			),
		);
		const handler = getHandler<
			{
				path: string;
				version: "head" | "base";
				startLine?: number;
				endLine?: number;
			},
			{ resultType: string; textResultForLlm: string }
		>(tool);

		const result = await handler(
			{ path: "src/new-name.ts", version: "head", startLine: 5, endLine: 4 },
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "get_file_content",
				arguments: {},
			},
		);

		assert.equal(result.resultType, "rejected");
		assert.equal(
			result.textResultForLlm,
			"endLine (4) must be greater than or equal to startLine (5).",
		);
	});

	it("returns structured out-of-range details for file content", async () => {
		const git = createGitStub({
			readTextFileAtCommit: async () => ({
				status: "ok",
				content: ["one", "two", "three"].join("\n"),
			}),
		});
		const tool = createGetFileContentTool(
			createReviewToolContext(
				config,
				reviewContext,
				git,
				[],
				createSummaryDrafts(),
			),
		);
		const handler = getHandler<
			{ path: string; version: "head" | "base"; startLine?: number },
			unknown
		>(tool);

		const result = await handler(
			{ path: "src/new-name.ts", version: "head", startLine: 10 },
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "get_file_content",
				arguments: {},
			},
		);

		assert.deepEqual(result, {
			status: "out_of_range",
			path: "src/new-name.ts",
			version: "head",
			totalLines: 3,
			message:
				"Requested startLine 10 is beyond the end of src/new-name.ts (3 lines).",
		});
	});

	it("rejects directory reads for related file content", async () => {
		const git = createGitStub({
			readTextFileAtCommit: async () => ({ status: "not_file" }),
		});
		const tool = createGetRelatedFileContentTool(
			createReviewToolContext(
				config,
				reviewContext,
				git,
				[],
				createSummaryDrafts(),
			),
		);
		const handler = getHandler<
			{ path: string; version: "head" | "base" },
			{ resultType: string; textResultForLlm: string }
		>(tool);

		const result = await handler(
			{ path: "src", version: "head" },
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "get_related_file_content",
				arguments: {},
			},
		);

		assert.equal(result.resultType, "rejected");
		assert.equal(
			result.textResultForLlm,
			"Related file access rejected: src is a directory, not a file.",
		);
	});

	it("returns structured CI summary responses", async () => {
		const tool = createGetCiSummaryTool(
			createReviewToolContext(
				config,
				{ ...reviewContext },
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
				toolName: "get_ci_summary",
				arguments: {},
			},
		);

		assert.deepEqual(result, {
			status: "missing",
			message: "No CI summary was provided.",
		});
	});

	it("marks safe read-only tools to skip permission prompts", () => {
		const toolContext = createReviewToolContext(
			config,
			reviewContext,
			createGitStub(),
			[],
			createSummaryDrafts(),
		);

		assert.equal(createGetPrOverviewTool(toolContext).skipPermission, true);
		assert.equal(createListChangedFilesTool(toolContext).skipPermission, true);
		assert.equal(createGetFileContentTool(toolContext).skipPermission, true);
		assert.equal(
			createGetRelatedFileContentTool(toolContext).skipPermission,
			true,
		);
		assert.equal(createGetCiSummaryTool(toolContext).skipPermission, true);
		assert.equal(
			createRecordPrSummaryTool(toolContext).skipPermission,
			undefined,
		);
		assert.equal(createEmitFindingTool(toolContext).skipPermission, undefined);
	});

	it("reports diff truncation metadata", async () => {
		const diffConfig = {
			...config,
			review: {
				...config.review,
				maxPatchChars: 20,
			},
		};
		const tool = createGetFileDiffTool(
			createReviewToolContext(
				diffConfig,
				reviewContext,
				createGitStub(),
				[],
				createSummaryDrafts(),
			),
		);
		const handler = getHandler<{ path: string }, unknown>(tool);

		const result = await handler(
			{ path: "src/multi-hunk.ts" },
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "get_file_diff",
				arguments: {},
			},
		);

		assert.equal((result as { truncated: boolean }).truncated, true);
		assert.equal(
			typeof (result as { returnedPatchChars: number }).returnedPatchChars,
			"number",
		);
	});

	it("returns a specific diff hunk with file header context", async () => {
		const tool = createGetFileDiffHunkTool(
			createReviewToolContext(
				config,
				reviewContext,
				createGitStub(),
				[],
				createSummaryDrafts(),
			),
		);
		const handler = getHandler<{ path: string; hunkIndex: number }, unknown>(
			tool,
		);

		const result = await handler(
			{ path: "src/multi-hunk.ts", hunkIndex: 2 },
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "get_file_diff_hunk",
				arguments: {},
			},
		);

		assert.deepEqual(result, {
			path: "src/multi-hunk.ts",
			oldPath: undefined,
			status: "modified",
			additions: 2,
			deletions: 1,
			changedLineCount: 2,
			changedLineRanges: "1, 10",
			hunks: [
				{ newStart: 1, newEnd: 3, header: "" },
				{ newStart: 10, newEnd: 13, header: "" },
			],
			hunkIndex: 2,
			totalHunks: 2,
			fileHeader: [
				"diff --git a/src/multi-hunk.ts b/src/multi-hunk.ts",
				"index 1111111..2222222 100644",
				"--- a/src/multi-hunk.ts",
				"+++ b/src/multi-hunk.ts",
			].join("\n"),
			patch: [
				"@@ -10,3 +10,4 @@",
				" const stable = true;",
				"+const second = addedValue;",
				" export { stable };",
			].join("\n"),
			truncated: false,
			returnedPatchChars: [
				"@@ -10,3 +10,4 @@",
				" const stable = true;",
				"+const second = addedValue;",
				" export { stable };",
			].join("\n").length,
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
			unknown
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

	it("replaces an existing finding with a file-level annotation when the line is unchanged", async () => {
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

		assert.equal(
			result,
			"Replaced finding 1 with src/new-name.ts:file; requested line 9 is not a changed line in src/new-name.ts; stored as a file-level annotation.",
		);
		assert.deepEqual(drafts, [
			{
				path: "src/new-name.ts",
				line: 0,
				severity: "HIGH",
				type: "BUG",
				confidence: "high",
				title: "New issue",
				details: "New details",
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
		const handler = getHandler<{ findingNumber: number }, unknown>(tool);

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

		const result = await handler(
			{ summary: "Adds stricter validation to the renamed service flow." },
			{
				sessionId: "session",
				toolCallId: "tool",
				toolName: "record_pr_summary",
				arguments: {},
			},
		);

		assert.equal(result, "Recorded the pull request summary.");
		assert.equal(
			summaryDrafts.prSummary,
			"Adds stricter validation to the renamed service flow.",
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
