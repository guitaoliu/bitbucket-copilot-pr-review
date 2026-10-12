import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	GitInvalidSearchPatternError,
	type GitRepository,
} from "../git/repo.ts";
import type { ReviewContext } from "../review/types.ts";
import type { Logger } from "../shared/logger.ts";
import { ReviewBundle } from "./review-bundle.ts";
import { createReviewToolTelemetryTracker } from "./telemetry.ts";
import {
	createReviewToolState,
	type ReviewToolState,
} from "./tools/context.ts";
import { createReviewTools, REVIEW_TOOL_NAMES } from "./tools/index.ts";

const reviewContext: ReviewContext = {
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
	reviewDiff: "",
	diffStats: { fileCount: 1, additions: 2, deletions: 1 },
	reviewableFiles: [
		{
			path: "src/new-name.ts",
			oldPath: "src/old-name.ts",
			status: "renamed",
			changedLines: [10, 11],
			additions: 2,
			deletions: 1,
			isBinary: false,
		},
		{
			path: "src/multi-hunk.ts",
			status: "modified",
			changedLines: [1, 10],
			additions: 2,
			deletions: 1,
			isBinary: false,
		},
	],
};

const finding = {
	path: "src/new-name.ts",
	line: 10,
	severity: "HIGH",
	type: "BUG",
	confidence: "high",
	title: "Broken behavior",
	details: "The changed line breaks the reviewed behavior.",
};

type ToolResult = {
	resultType?: string;
	textResultForLlm?: string;
	page?: number;
	totalPages?: number;
	content?: string;
	nextPage?: number;
	outOfRange?: true;
	requestedPage?: number;
	paginationReset?: true;
	searchedRevision?: string;
	searchScope?: string;
	patternType?: string;
	patternCount?: number;
	matchingLineCount?: number;
	matchedFileCount?: number;
};

type LogEntry = { message: string; details: unknown[] };

function createLoggerSpy(): {
	logger: Logger;
	info: LogEntry[];
	warn: LogEntry[];
} {
	const info: LogEntry[] = [];
	const warn: LogEntry[] = [];
	return {
		logger: {
			debug() {},
			info(message, ...details) {
				info.push({ message, details });
			},
			warn(message, ...details) {
				warn.push({ message, details });
			},
			error() {},
			trace() {},
			json() {},
		},
		info,
		warn,
	};
}

function createGitStub(overrides: Partial<GitRepository> = {}): GitRepository {
	return {
		listFilesAtCommit: async () => [],
		readTextFileAtCommit: async () => ({ status: "not_found" as const }),
		searchTextAtCommit: async () => [],
		...overrides,
	} as GitRepository;
}

function createTools(
	options: {
		context?: ReviewContext;
		git?: GitRepository;
		logger?: Logger;
		reviewBundle?: ReviewBundle;
	} = {},
) {
	const context = options.context ?? reviewContext;
	const git = options.git ?? createGitStub();
	const state: ReviewToolState = createReviewToolState();
	const tools = createReviewTools({
		context,
		git,
		logger: options.logger ?? createLoggerSpy().logger,
		reviewBundle: options.reviewBundle ?? new ReviewBundle(context, git),
		state,
		toolCalls: createReviewToolTelemetryTracker(),
	});
	let callCount = 0;
	const invoke = async (
		toolName: (typeof REVIEW_TOOL_NAMES)[number],
		args: Record<string, unknown>,
	): Promise<ToolResult & string> => {
		const tool = tools.find((candidate) => candidate.name === toolName);
		assert.ok(tool?.handler, `Expected tool ${toolName}`);
		callCount += 1;
		return (await tool.handler(args, {
			sessionId: "session",
			toolCallId: `${toolName}-${callCount}`,
			toolName,
			arguments: args,
		})) as ToolResult & string;
	};
	return { tools, state, invoke };
}

describe("Copilot tools", () => {
	it("creates only the active review tools in the published order", () => {
		const { tools } = createTools();

		assert.deepEqual(
			tools.map((tool) => tool.name),
			[...REVIEW_TOOL_NAMES],
		);
		assert.deepEqual(REVIEW_TOOL_NAMES, [
			"review_changes",
			"read_file",
			"search_repo",
			"find_files",
			"record_pr_summary",
			"record_change_area_summary",
			"emit_finding",
		]);
		assert.equal(
			tools.find((tool) => tool.name === "read_file")?.overridesBuiltInTool,
			true,
		);
		assert.ok(tools.every((tool) => tool.skipPermission === undefined));
	});

	it("pages trusted guidance, skill metadata, and the complete diff", async () => {
		const git = createGitStub({
			listFilesAtCommit: async () => [
				"AGENTS.md",
				"src/AGENTS.md",
				".agents/skills/review/SKILL.md",
				"src/new-name.ts",
			],
			readTextFileAtCommit: async (_commit, filePath) => ({
				status: "ok" as const,
				content: filePath.endsWith("/SKILL.md")
					? "---\nname: review\ndescription: Use for reviewing risky changes.\n---\nBody"
					: `instructions for ${filePath}`,
			}),
		});
		const context = {
			...reviewContext,
			reviewDiff: `diff for src/old-name.ts,src/new-name.ts,src/multi-hunk.ts\n${"x".repeat(45_000)}`,
		};
		const reviewBundle = new ReviewBundle(context, git);
		const { invoke, state } = createTools({ context, git, reviewBundle });

		const first = await invoke("review_changes", { page: 1 });
		const content = [first.content];
		for (let page = 2; page <= (first.totalPages ?? 0); page += 1) {
			content.push((await invoke("review_changes", { page })).content);
		}
		const result = content.join("");

		assert.match(result, /trusted guidance: AGENTS\.md/);
		assert.match(result, /trusted guidance: src\/AGENTS\.md/);
		assert.doesNotMatch(result, /trusted guidance: src\/new-name\.ts/);
		assert.match(result, /\.agents\/skills\/review\/SKILL\.md/);
		assert.match(result, /description: Use for reviewing risky changes\./);
		assert.match(result, /src\/new-name\.ts/);
		assert.match(result, /src\/multi-hunk\.ts/);
		assert.deepEqual(reviewBundle.getCoverage(), {
			deliveredPages: first.totalPages,
			totalPages: first.totalPages,
			complete: true,
		});
		assert.ok((first.totalPages ?? 0) > 1);
		assert.ok(Buffer.byteLength(first.content ?? "") <= 40_000);
		assert.ok((state.inspection.resultCharsByTool.review_changes ?? 0) > 0);
	});

	it("rejects the summary until every review page is delivered", async () => {
		const context = {
			...reviewContext,
			reviewDiff: `src/multi-hunk.ts\n${"x".repeat(70_000)}`,
		};
		const git = createGitStub();
		const reviewBundle = new ReviewBundle(context, git);
		const { invoke, state } = createTools({ context, git, reviewBundle });

		const first = await invoke("review_changes", { page: 1 });
		const rejected = await invoke("record_pr_summary", { summary: "Summary" });
		assert.equal(rejected.resultType, "failure");
		assert.match(rejected.textResultForLlm ?? "", /review_changes pages: 2/);

		for (let page = 2; page <= (first.totalPages ?? 0); page += 1) {
			await invoke("review_changes", { page });
		}

		assert.deepEqual(reviewBundle.getCoverage(), {
			deliveredPages: first.totalPages,
			totalPages: first.totalPages,
			complete: true,
		});
		assert.equal(
			await invoke("record_pr_summary", { summary: "Summary" }),
			"Recorded the pull request summary.",
		);
		assert.equal(state.summaryDrafts.prSummary, "Summary");
	});

	it("pages search queries, forwards patterns, and clamps context", async () => {
		const logSpy = createLoggerSpy();
		const contextLines: number[] = [];
		const requestedPatterns: string[][] = [];
		const requestedPaths: string[][] = [];
		const git = createGitStub({
			searchTextAtCommit: async (request) => {
				requestedPatterns.push([...request.patterns]);
				requestedPaths.push([...request.paths]);
				contextLines.push(request.contextLines);
				return request.patterns.includes("missing-pattern")
					? []
					: [
							{
								path: "src/example.ts",
								groups: [
									Array.from({ length: 3_000 }, () => ({
										lineNumber: 10,
										isMatch: true,
										text: "match",
									})),
								],
							},
						];
			},
		});
		const { invoke, state } = createTools({ git, logger: logSpy.logger });
		const patterns = ["proprietary-pattern", "second-pattern"];

		const first = await invoke("search_repo", {
			revision: "head",
			patterns,
			paths: [""],
		});

		assert.ok((first.totalPages ?? 0) > 1);
		assert.equal(first.nextPage, 2);
		assert.ok(Buffer.byteLength(first.content ?? "") <= 16_000);
		assert.match(first.content ?? "", /^head-123:src\/example\.ts:10:match\n/);
		assert.deepEqual(
			{
				searchedRevision: first.searchedRevision,
				searchScope: first.searchScope,
				patternType: first.patternType,
				patternCount: first.patternCount,
				matchingLineCount: first.matchingLineCount,
				matchedFileCount: first.matchedFileCount,
			},
			{
				searchedRevision: "head",
				searchScope: "entire repository",
				patternType: "literal",
				patternCount: 2,
				matchingLineCount: 3_000,
				matchedFileCount: 1,
			},
		);
		const scopedQuery = {
			revision: "head",
			patterns,
			paths: ["src/**"],
			contextLines: 99,
			page: 2,
		};
		const second = await invoke("search_repo", scopedQuery);
		assert.equal(second.page, 1);
		assert.equal(second.requestedPage, 2);
		assert.equal(second.paginationReset, true);
		assert.equal((await invoke("search_repo", scopedQuery)).page, 2);
		assert.equal((await invoke("search_repo", scopedQuery)).page, 2);
		assert.deepEqual(contextLines, [0, 12, 12, 12]);
		assert.deepEqual(requestedPatterns, [
			patterns,
			patterns,
			patterns,
			patterns,
		]);
		assert.deepEqual(requestedPaths, [[], ["src/**"], ["src/**"], ["src/**"]]);
		assert.match(JSON.stringify(logSpy.info), /proprietary-pattern/);
		assert.match(JSON.stringify(logSpy.warn), /pagination/);
		const noMatches = await invoke("search_repo", {
			revision: "head",
			patterns: ["missing-pattern"],
			paths: [],
		});
		assert.equal(noMatches.matchingLineCount, 0);
		assert.equal(noMatches.matchedFileCount, 0);
		assert.match(
			noMatches.content ?? "",
			/No matches at head across entire repository for 1 literal pattern/,
		);
		assert.deepEqual(state.inspection.searchRepoMetrics, {
			uniqueQueries: 3,
			duplicateQueries: 1,
			wholeRepoQueries: 2,
			noMatchQueries: 1,
		});
	});

	it("reports out-of-range review pages without counting them as delivered", async () => {
		const reviewBundle = new ReviewBundle(reviewContext, createGitStub());
		const { invoke } = createTools({ reviewBundle });

		const result = await invoke("review_changes", { page: 2 });

		assert.deepEqual(
			{
				page: result.page,
				totalPages: result.totalPages,
				outOfRange: result.outOfRange,
			},
			{ page: 2, totalPages: 1, outOfRange: true },
		);
		assert.deepEqual(reviewBundle.getCoverage(), {
			deliveredPages: 0,
			totalPages: 1,
			complete: false,
		});
	});

	it("rejects invalid arguments before running the tool", async () => {
		const { invoke, state } = createTools();

		const result = await invoke("emit_finding", {
			...finding,
			severity: "CRITICAL",
			unexpected: true,
		});

		assert.equal(result.resultType, "failure");
		assert.match(
			result.textResultForLlm ?? "",
			/^Invalid emit_finding arguments:/,
		);
		assert.match(result.textResultForLlm ?? "", /severity/);
		assert.match(result.textResultForLlm ?? "", /unexpected/);
		assert.deepEqual(state.drafts, []);
	});

	it("rejects malformed regex searches so Copilot can retry", async () => {
		const { invoke } = createTools({
			git: createGitStub({
				searchTextAtCommit: async () => {
					throw new GitInvalidSearchPatternError(
						"Git search failed at head-123 using 1 regex patterns across all pathspecs: fatal: -e option, 'removeUser(': parentheses not balanced",
					);
				},
			}),
		});

		const result = await invoke("search_repo", {
			revision: "head",
			patterns: ["removeUser("],
			patternType: "regex",
			paths: [],
		});

		assert.equal(result.resultType, "failure");
		assert.match(
			result.textResultForLlm ?? "",
			/retry with patternType literal/,
		);
	});

	it("preserves non-pattern repository search failures", async () => {
		const { invoke } = createTools({
			git: createGitStub({
				searchTextAtCommit: async () => {
					throw new Error("Git search failed: bad revision");
				},
			}),
		});

		await assert.rejects(
			invoke("search_repo", {
				revision: "head",
				patterns: ["value"],
				patternType: "regex",
				paths: [],
			}),
			/Git search failed: bad revision/,
		);
	});

	it("rejects read_file paths that escape the repository", async () => {
		const { invoke } = createTools();

		const result = await invoke("read_file", {
			revision: "head",
			path: "../secrets",
		});

		assert.equal(result.resultType, "failure");
		assert.match(result.textResultForLlm ?? "", /relative repository path/);
	});

	it("keeps secret-bearing files unreadable, unsearchable, and unlisted", async () => {
		const secretPaths = [
			".env",
			"config/.env.local",
			"infra/id_rsa",
			"config/secrets/api.txt",
		];
		const readPaths: string[] = [];
		const excludeGlobs: string[][] = [];
		const { invoke } = createTools({
			git: createGitStub({
				readTextFileAtCommit: async (_commit, filePath) => {
					readPaths.push(filePath);
					return { status: "ok" as const, content: "token = SECRET" };
				},
				listFilesAtCommit: async () => [...secretPaths, "src/app.ts"],
				searchTextAtCommit: async (request) => {
					excludeGlobs.push([...request.excludeGlobs]);
					return [...secretPaths, "src/app.ts"].map((path) => ({
						path,
						groups: [
							[
								{
									lineNumber: 1,
									isMatch: true,
									text:
										path === "src/app.ts" ? "token = env()" : "token = SECRET",
								},
							],
						],
					}));
				},
			}),
		});

		for (const path of secretPaths) {
			const result = await invoke("read_file", { revision: "head", path });
			assert.equal(result.resultType, "failure", path);
			assert.match(
				result.textResultForLlm ?? "",
				/potential secret-bearing path/,
			);
		}
		assert.deepEqual(readPaths, []);
		const allowed = await invoke("read_file", {
			revision: "head",
			path: "./src/app.ts",
		});
		assert.equal(allowed.content, "1\ttoken = SECRET");
		assert.deepEqual(readPaths, ["src/app.ts"]);

		const listing = await invoke("find_files", { revision: "head", paths: [] });
		assert.equal(listing.content, "src/app.ts");

		const searched = await invoke("search_repo", {
			revision: "head",
			patterns: ["token"],
			paths: [],
		});
		assert.equal(searched.content, "head-123:src/app.ts:1:token = env()\n");
		assert.equal(searched.matchedFileCount, 1);
		assert.ok(excludeGlobs[0]?.includes("**/node_modules/**"));
	});

	it("rejects emit_finding when the line is not changed", async () => {
		const { invoke, state } = createTools();

		const result = await invoke("emit_finding", { ...finding, line: 9 });

		assert.deepEqual(result, {
			resultType: "failure",
			textResultForLlm:
				"Line 9 is not a changed line in src/new-name.ts. Valid changed line ranges: 10-11",
		});
		assert.deepEqual(state.drafts, []);
		assert.deepEqual(state.droppedFindings, {
			unknown_file: 0,
			unchanged_line: 1,
		});
	});

	it("normalizes oldPath findings onto the reviewed head path", async () => {
		const { invoke, state } = createTools();

		const result = await invoke("emit_finding", {
			...finding,
			path: "src/old-name.ts",
		});

		assert.equal(
			result,
			"Recorded finding 1 for src/new-name.ts:10; normalized path from src/old-name.ts to src/new-name.ts.",
		);
		assert.deepEqual(state.drafts, [finding]);
	});

	it("accepts only file-level findings for reviewed files without added lines", async () => {
		const { invoke, state } = createTools({
			context: {
				...reviewContext,
				reviewableFiles: [
					{
						path: "src/removed.ts",
						status: "deleted",
						changedLines: [],
						additions: 0,
						deletions: 10,
						isBinary: false,
					},
				],
			},
		});

		assert.equal(
			await invoke("emit_finding", {
				...finding,
				path: "src/removed.ts",
				line: 0,
			}),
			"Recorded finding 1 for src/removed.ts:file.",
		);
		assert.deepEqual(
			await invoke("emit_finding", { ...finding, path: "src/removed.ts" }),
			{
				resultType: "failure",
				textResultForLlm:
					"Line 10 is not a changed line in src/removed.ts. Valid changed line ranges: none",
			},
		);
		assert.deepEqual(
			state.drafts.map((draft) => `${draft.path}:${draft.line}`),
			["src/removed.ts:0"],
		);
	});

	it("rejects copied-file findings addressed by the source path", async () => {
		const { invoke, state } = createTools({
			context: {
				...reviewContext,
				reviewableFiles: [
					{
						path: "src/copied.ts",
						oldPath: "src/original.ts",
						status: "copied",
						changedLines: [10],
						additions: 1,
						deletions: 0,
						isBinary: false,
					},
				],
			},
		});

		const result = await invoke("emit_finding", {
			...finding,
			path: "src/original.ts",
		});

		assert.deepEqual(result, {
			resultType: "failure",
			textResultForLlm:
				"The file src/original.ts is not one of the reviewed files.",
		});
		assert.deepEqual(state.drafts, []);
		assert.equal(state.droppedFindings.unknown_file, 1);
	});

	it("publishes runtime payload limits in tool schemas", () => {
		const { tools } = createTools();
		type JsonSchema = {
			required?: string[];
			additionalProperties?: boolean;
			properties?: Record<string, Record<string, unknown>>;
		};
		const jsonSchemaOf = (name: string) =>
			tools.find((tool) => tool.name === name)?.parameters as JsonSchema;
		const schemaOf = (name: string) => jsonSchemaOf(name).properties ?? {};

		for (const tool of tools) {
			assert.equal(
				jsonSchemaOf(tool.name).additionalProperties,
				false,
				tool.name,
			);
		}
		assert.deepEqual(jsonSchemaOf("read_file").required, ["revision", "path"]);
		assert.deepEqual(jsonSchemaOf("emit_finding").required, [
			"path",
			"line",
			"severity",
			"type",
			"confidence",
			"title",
			"details",
		]);

		assert.ok(schemaOf("review_changes").page);
		assert.ok(schemaOf("read_file").ranges);
		const search = schemaOf("search_repo");
		assert.equal(search.contextLines?.default, 0);
		assert.equal(search.contextLines?.minimum, 0);
		assert.equal(search.contextLines?.maximum, 12);
		assert.equal(search.patterns?.minItems, 1);
		assert.equal(search.patterns?.maxItems, 8);
		assert.deepEqual(search.patterns?.items, {
			type: "string",
			minLength: 1,
			maxLength: 500,
		});
		assert.match(
			String(search.paths?.description),
			/empty array for the whole repository/,
		);
		assert.ok(schemaOf("find_files").paths);

		const prSummary = schemaOf("record_pr_summary");
		assert.equal(prSummary.summary?.minLength, 1);
		assert.equal(prSummary.summary?.maxLength, 1000);
		assert.match(
			String(prSummary.summary?.description),
			/Use short bullet points when that is clearer than one sentence/,
		);

		const changeArea = schemaOf("record_change_area_summary");
		assert.equal(changeArea.title?.minLength, 1);
		assert.equal(changeArea.title?.maxLength, 80);
		assert.equal(changeArea.paths?.minItems, 1);
		assert.deepEqual(changeArea.paths?.items, { type: "string", minLength: 1 });
		assert.equal(changeArea.summary?.minLength, 1);
		assert.equal(changeArea.summary?.maxLength, 500);

		const emitFinding = schemaOf("emit_finding");
		assert.equal(emitFinding.path?.minLength, 1);
		assert.equal(emitFinding.line?.minimum, 0);
		assert.deepEqual(emitFinding.severity?.enum, ["LOW", "MEDIUM", "HIGH"]);
		assert.equal(emitFinding.title?.minLength, 1);
		assert.equal(emitFinding.title?.maxLength, 200);
		assert.equal(emitFinding.details?.maxLength, 1600);
		assert.equal(emitFinding.category?.maxLength, 80);
		assert.equal(
			emitFinding.category?.description,
			"Optional short category when obvious and helpful, such as security, correctness, data-integrity, concurrency, reliability, performance, or tests.",
		);
	});

	it("records and replaces a pull request summary", async () => {
		const reviewBundle = new ReviewBundle(reviewContext, createGitStub());
		await reviewBundle.getPage(1);
		const { invoke, state } = createTools({ reviewBundle });

		assert.equal(
			await invoke("record_pr_summary", {
				summary: "Adds stricter validation to the renamed service flow.",
			}),
			"Recorded the pull request summary.",
		);
		assert.equal(
			await invoke("record_pr_summary", {
				summary: "Tightens validation and updates the renamed service path.",
			}),
			"Recorded the pull request summary.",
		);
		assert.equal(
			state.summaryDrafts.prSummary,
			"Tightens validation and updates the renamed service path.",
		);
	});

	it("records change areas with reviewed canonical paths", async () => {
		const { invoke, state } = createTools();

		const result = await invoke("record_change_area_summary", {
			title: "Validation flow",
			paths: ["src/old-name.ts", "src/multi-hunk.ts", "src/multi-hunk.ts"],
			summary: "Tightens validation across renamed service paths.",
		});

		assert.equal(result, "Recorded the change area summary.");
		assert.deepEqual(state.summaryDrafts.changeAreas, [
			{
				title: "Validation flow",
				paths: ["src/new-name.ts", "src/multi-hunk.ts"],
				summary: "Tightens validation across renamed service paths.",
			},
		]);
	});

	it("keeps reviewed path globs compact in change areas", async () => {
		const { invoke, state } = createTools();

		const result = await invoke("record_change_area_summary", {
			title: "Validation flow",
			paths: ["src/*.ts"],
			summary: "Tightens validation across renamed service paths.",
		});

		assert.equal(result, "Recorded the change area summary.");
		assert.deepEqual(state.summaryDrafts.changeAreas, [
			{
				title: "Validation flow",
				paths: ["src/*.ts"],
				summary: "Tightens validation across renamed service paths.",
			},
		]);
	});

	it("rejects change areas that reference files outside the reviewed scope", async () => {
		const { invoke, state } = createTools();

		const result = await invoke("record_change_area_summary", {
			title: "Generated files",
			paths: ["dist/generated.js"],
			summary: "Updates generated output.",
		});

		assert.deepEqual(result, {
			resultType: "failure",
			textResultForLlm:
				"The path dist/generated.js does not match any reviewed file.",
		});
		assert.equal(state.summaryDrafts.changeAreas, undefined);
	});
});
