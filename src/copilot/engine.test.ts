import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReviewerConfig } from "../config/types.ts";
import type { ChangedFile, HunkSummary } from "../git/types.ts";
import { MAX_REVIEWED_FILES_WITH_PER_FILE_SUMMARIES } from "../review/summary.ts";
import type {
	FindingDraft,
	ReviewContext,
	ReviewSummaryDrafts,
} from "../review/types.ts";
import type { Logger } from "../shared/logger.ts";
import {
	buildCopilotClientOptions,
	createEmptyReviewToolTelemetry,
	createReviewSessionHooks,
	runCopilotReview,
} from "./engine.ts";
import {
	FINDING_TAXONOMY_HINT,
	QUESTION_SHAPED_FINDING_HINT,
	TEST_COVERAGE_HINT,
} from "./review-guidance.ts";

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
		skipBranchPrefixes: ["renovate/"],
	},
};

function createLoggerSpy(): {
	logger: Logger;
	infoEntries: Array<{ message: string; details: unknown[] }>;
	warnEntries: Array<{ message: string; details: unknown[] }>;
} {
	const infoEntries: Array<{ message: string; details: unknown[] }> = [];
	const warnEntries: Array<{ message: string; details: unknown[] }> = [];

	return {
		logger: {
			debug() {},
			info(message, ...details) {
				infoEntries.push({ message, details });
			},
			warn(message, ...details) {
				warnEntries.push({ message, details });
			},
			error() {},
			trace() {},
			json() {},
		},
		infoEntries,
		warnEntries,
	};
}

function createFindingDraft(index: number): FindingDraft {
	return {
		path: `src/example-${index}.ts`,
		line: index,
		severity: "HIGH",
		type: "BUG",
		confidence: "high",
		title: `Issue ${index}`,
		details: `Details ${index}`,
	};
}

function createChangedFile(overrides: Partial<ChangedFile> = {}): ChangedFile {
	const defaultHunk: HunkSummary = {
		oldStart: 1,
		oldLines: 1,
		newStart: 1,
		newLines: 1,
		header: "",
		changedLines: [1],
	};

	return {
		path: "src/example.ts",
		status: "modified",
		patch: "diff --git a/src/example.ts b/src/example.ts",
		changedLines: [1],
		hunks: [defaultHunk],
		additions: 1,
		deletions: 0,
		isBinary: false,
		...overrides,
	};
}

function createReviewContext(): ReviewContext {
	return {
		repoRoot: "/tmp/repo",
		pr: {
			id: 123,
			version: 1,
			state: "OPEN",
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
		diffStats: { fileCount: 1, additions: 1, deletions: 0 },
		reviewedFiles: [createChangedFile()],
		skippedFiles: [],
	};
}

function createProgressState(
	overrides: Partial<ReviewSummaryDrafts> = {},
	reviewedFileCount = 4,
) {
	return {
		reviewedFileCount,
		summaryDrafts: {
			fileSummaries: [],
			...overrides,
		},
	};
}

describe("createReviewSessionHooks", () => {
	it("returns a session-start hint that reinforces high-signal review behavior", async () => {
		const hooks = createReviewSessionHooks(
			config,
			createLoggerSpy().logger,
			[],
		);
		const result = await hooks.onSessionStart();

		assert.match(
			result.additionalContext,
			/material issues introduced by this pull request/,
		);
		assert.match(
			result.additionalContext,
			/Inspect diff plus relevant head\/base code/,
		);
		assert.match(
			result.additionalContext,
			new RegExp(TEST_COVERAGE_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);
		assert.match(
			result.additionalContext,
			/Ignore style, naming, formatting, and preference-only feedback/,
		);
		assert.ok(result.additionalContext.includes(FINDING_TAXONOMY_HINT));
		assert.ok(result.additionalContext.includes(QUESTION_SHAPED_FINDING_HINT));
		assert.match(
			result.additionalContext,
			/continue after the first finding when more distinct issues may exist/,
		);
		assert.match(
			result.additionalContext,
			/high confidence or better, up to 3 total/,
		);
	});

	it("allows approved tools and returns tool-specific pre-use guidance", async () => {
		const { logger, infoEntries } = createLoggerSpy();
		const hooks = createReviewSessionHooks(
			config,
			logger,
			[],
			createProgressState(),
		);
		const result = await hooks.onPreToolUse({
			toolName: "get_file_content",
			toolArgs: { path: "src/file.ts" },
			cwd: "/tmp/repo",
		});

		assert.deepEqual(result, {
			permissionDecision: "allow",
			additionalContext:
				"Read head and base content as needed to verify a concrete regression, broken invariant, or API change.",
		});
		assert.deepEqual(infoEntries, [
			{
				message: "Copilot requested tool get_file_content path=src/file.ts",
				details: [],
			},
		]);
	});

	it("returns pre-use guidance for finding replacement workflow", async () => {
		const hooks = createReviewSessionHooks(
			config,
			createLoggerSpy().logger,
			[],
		);
		const result = await hooks.onPreToolUse({
			toolName: "replace_recorded_finding",
			toolArgs: {},
			cwd: "/tmp/repo",
		});

		assert.deepEqual(result, {
			permissionDecision: "allow",
			additionalContext:
				"Replace a recorded finding only when the new draft is clearly stronger, more accurate, or better located.",
		});
	});

	it("returns pre-use guidance for removing weak findings", async () => {
		const hooks = createReviewSessionHooks(
			config,
			createLoggerSpy().logger,
			[],
		);
		const result = await hooks.onPreToolUse({
			toolName: "remove_recorded_finding",
			toolArgs: {},
			cwd: "/tmp/repo",
		});

		assert.deepEqual(result, {
			permissionDecision: "allow",
			additionalContext:
				"Remove a recorded finding only when it is duplicate, superseded, or too weak to keep in the final set.",
		});
	});

	it("denies unknown tools with a CI review mode reason", async () => {
		const hooks = createReviewSessionHooks(
			config,
			createLoggerSpy().logger,
			[],
		);
		const result = await hooks.onPreToolUse({
			toolName: "bash",
			toolArgs: { command: "rm -rf /" },
			cwd: "/tmp/repo",
		});

		assert.deepEqual(result, {
			permissionDecision: "deny",
			permissionDecisionReason: "Tool bash is not allowed in CI review mode.",
		});
	});

	it("tracks explicit per-tool telemetry counters", async () => {
		const telemetry = createEmptyReviewToolTelemetry();
		const hooks = createReviewSessionHooks(
			config,
			createLoggerSpy().logger,
			[],
			{
				reviewedFileCount: 4,
				summaryDrafts: { fileSummaries: [] },
				toolTelemetry: telemetry,
			},
		);

		await hooks.onPreToolUse({
			toolName: "get_pr_overview",
			toolArgs: {},
			cwd: "/tmp/repo",
		});
		await hooks.onPreToolUse({
			toolName: "bash",
			toolArgs: {},
			cwd: "/tmp/repo",
		});
		await hooks.onPostToolUse({
			toolName: "get_pr_overview",
			toolArgs: {},
			toolResult: {
				textResultForLlm: "ok",
				resultType: "success",
				toolTelemetry: { durationMs: 12 },
			},
			cwd: "/tmp/repo",
		});

		assert.equal(telemetry.totalRequested, 2);
		assert.equal(telemetry.totalAllowed, 1);
		assert.equal(telemetry.totalDenied, 1);
		assert.equal(telemetry.totalCompleted, 1);
		assert.equal(telemetry.totalDurationMs, 12);
		assert.equal(telemetry.errorCount, 0);
		assert.equal(telemetry.assistantMessageChars, 0);
		assert.equal(telemetry.byTool.get_pr_overview?.requested, 1);
		assert.equal(telemetry.byTool.get_pr_overview?.allowed, 1);
		assert.equal(telemetry.byTool.get_pr_overview?.denied, 0);
		assert.equal(telemetry.byTool.get_pr_overview?.completed, 1);
		assert.deepEqual(telemetry.byTool.get_pr_overview?.resultCounts, {
			success: 1,
		});
		assert.equal(telemetry.byTool.get_pr_overview?.totalDurationMs, 12);
		assert.equal(telemetry.byTool.get_pr_overview?.maxDurationMs, 12);
		assert.equal(telemetry.byTool.get_pr_overview?.totalInputChars, 2);
		assert.equal(
			(telemetry.byTool.get_pr_overview?.totalOutputChars ?? 0) > 0,
			true,
		);
		assert.equal(telemetry.byTool.get_pr_overview?.truncatedResponses, 0);
		assert.equal(telemetry.byTool.get_pr_overview?.filteredResultCount, 0);
		assert.deepEqual(telemetry.byTool.bash, {
			requested: 1,
			allowed: 0,
			denied: 1,
			completed: 0,
			resultCounts: {},
			totalDurationMs: 0,
			maxDurationMs: 0,
			totalInputChars: 0,
			totalOutputChars: 0,
			truncatedResponses: 0,
			filteredResultCount: 0,
		});
	});

	it("returns post-use guidance that reflects current finding count", async () => {
		const drafts = [createFindingDraft(1)];
		const { logger, infoEntries } = createLoggerSpy();
		const hooks = createReviewSessionHooks(
			config,
			logger,
			drafts,
			createProgressState({ prSummary: "done", fileSummaries: [] }),
		);
		const result = await hooks.onPostToolUse({
			toolName: "emit_finding",
			toolArgs: { path: "src/file.ts" },
			toolResult: { textResultForLlm: "ok", resultType: "success" },
			cwd: "/tmp/repo",
		});

		assert.deepEqual(result, {
			additionalContext:
				"Findings recorded: 1/3. Keep findings distinct and evidence-backed, then continue searching for additional validated issues.",
		});
		assert.deepEqual(infoEntries, [
			{
				message:
					"Copilot completed tool emit_finding result=success path=src/file.ts findings=1/3 file_summaries=0/4 pr_summary=recorded",
				details: [],
			},
		]);
	});

	it("returns pre-use guidance for emitting findings with taxonomy discipline", async () => {
		const hooks = createReviewSessionHooks(
			config,
			createLoggerSpy().logger,
			[],
		);
		const result = await hooks.onPreToolUse({
			toolName: "emit_finding",
			toolArgs: { path: "src/file.ts", line: 12 },
			cwd: "/tmp/repo",
		});

		assert.deepEqual(result, {
			permissionDecision: "allow",
			additionalContext: `Only emit a finding after verifying the issue from inspected code. ${FINDING_TAXONOMY_HINT} ${QUESTION_SHAPED_FINDING_HINT} Use one finding per root cause, prefer a changed head-side line, and keep looking for additional distinct issues after recording one.`,
		});
	});

	it("warns when the finding limit has been reached", async () => {
		const drafts = [
			createFindingDraft(1),
			createFindingDraft(2),
			createFindingDraft(3),
		];
		const hooks = createReviewSessionHooks(
			config,
			createLoggerSpy().logger,
			drafts,
		);
		const result = await hooks.onPostToolUse({
			toolName: "emit_finding",
			toolArgs: {},
			toolResult: { textResultForLlm: "ok", resultType: "success" },
			cwd: "/tmp/repo",
		});

		assert.deepEqual(result, {
			additionalContext:
				"You have reached the configured maximum of 3 findings. Do not add more unless a clearly stronger issue replaces a weaker one.",
		});
	});

	it("returns narrow exploration guidance after repo search tools", async () => {
		const { logger, infoEntries } = createLoggerSpy();
		const hooks = createReviewSessionHooks(
			config,
			logger,
			[],
			createProgressState(),
		);
		const result = await hooks.onPostToolUse({
			toolName: "search_text_in_repo",
			toolArgs: { query: "foo", version: "head", directories: ["src"] },
			toolResult: { textResultForLlm: "[]", resultType: "success" },
			cwd: "/tmp/repo",
		});

		assert.deepEqual(result, {
			additionalContext:
				"Use this context to confirm or reject a specific hypothesis, then move to the next uncovered risky path. If repeated searches are not sharpening the hypothesis, stop searching and decide based on the evidence you have.",
		});
		assert.deepEqual(infoEntries, [
			{
				message:
					"Copilot completed tool search_text_in_repo result=success query_chars=3 version=head directories=src findings=0/3 file_summaries=0/4 pr_summary=missing",
				details: [],
			},
		]);
	});

	it("guides the model toward nearby-test discovery before broad search", async () => {
		const hooks = createReviewSessionHooks(
			config,
			createLoggerSpy().logger,
			[],
		);
		const result = await hooks.onPreToolUse({
			toolName: "get_related_tests",
			toolArgs: { path: "src/file.ts" },
			cwd: "/tmp/repo",
		});

		assert.deepEqual(result, {
			permissionDecision: "allow",
			additionalContext:
				"Use this to find likely nearby automated tests for a reviewed file before resorting to broader repository search.",
		});
	});

	it("returns post-use guidance for recorded finding inspection", async () => {
		const drafts = [createFindingDraft(1), createFindingDraft(2)];
		const hooks = createReviewSessionHooks(
			config,
			createLoggerSpy().logger,
			drafts,
		);
		const result = await hooks.onPostToolUse({
			toolName: "list_recorded_findings",
			toolArgs: {},
			toolResult: { textResultForLlm: "[]", resultType: "success" },
			cwd: "/tmp/repo",
		});

		assert.deepEqual(result, {
			additionalContext:
				"Recorded findings: 2/3. Avoid duplicates, but continue looking if reviewed risky areas remain unchecked.",
		});
	});

	it("returns post-use guidance after removing a finding", async () => {
		const drafts = [createFindingDraft(1)];
		const { logger, infoEntries } = createLoggerSpy();
		const hooks = createReviewSessionHooks(
			config,
			logger,
			drafts,
			createProgressState({
				fileSummaries: [{ path: "src/example.ts", summary: "done" }],
			}),
		);
		const result = await hooks.onPostToolUse({
			toolName: "remove_recorded_finding",
			toolArgs: { findingNumber: 1 },
			toolResult: { textResultForLlm: "removed", resultType: "success" },
			cwd: "/tmp/repo",
		});

		assert.deepEqual(result, {
			additionalContext:
				"Recorded findings: 1/3. Keep only distinct issues, then continue covering remaining risky reviewed changes.",
		});
		assert.deepEqual(infoEntries, [
			{
				message:
					"Copilot completed tool remove_recorded_finding result=success finding=1 findings=1/3 file_summaries=1/4 pr_summary=missing",
				details: [],
			},
		]);
	});

	it("aborts on hook errors and logs the error context", async () => {
		const error = new Error("boom");
		const { logger, warnEntries } = createLoggerSpy();
		const hooks = createReviewSessionHooks(config, logger, []);
		const result = await hooks.onErrorOccurred({
			errorContext: "tool_call",
			error,
		});

		assert.deepEqual(result, { errorHandling: "abort" });
		assert.deepEqual(warnEntries, [
			{
				message: "Copilot session reported an error in tool_call",
				details: [error],
			},
		]);
	});

	it("logs compact progress details instead of raw large tool arguments", async () => {
		const { logger, infoEntries } = createLoggerSpy();
		const hooks = createReviewSessionHooks(
			config,
			logger,
			[],
			createProgressState(),
		);
		const largePatch = "x".repeat(600);

		await hooks.onPreToolUse({
			toolName: "get_file_diff",
			toolArgs: { path: "src/file.ts", patch: largePatch },
			cwd: "/tmp/repo",
		});

		assert.equal(infoEntries.length, 1);
		assert.deepEqual(infoEntries[0], {
			message: "Copilot requested tool get_file_diff path=src/file.ts",
			details: [],
		});
	});

	it("logs compact progress instead of raw post-tool payloads", async () => {
		const { logger, infoEntries } = createLoggerSpy();
		const hooks = createReviewSessionHooks(
			config,
			logger,
			[],
			createProgressState({ prSummary: "done", fileSummaries: [] }),
		);

		await hooks.onPostToolUse({
			toolName: "get_file_content",
			toolArgs: { path: "src/file.ts", version: "head" },
			toolResult: {
				textResultForLlm: "content",
				resultType: "success",
				sessionLog: "verbose session log",
				toolTelemetry: { durationMs: 25 },
			},
			cwd: "/tmp/repo",
		});

		assert.deepEqual(infoEntries, [
			{
				message:
					"Copilot completed tool get_file_content result=success duration_ms=25 path=src/file.ts version=head findings=0/3 file_summaries=0/4 pr_summary=recorded",
				details: [],
			},
		]);
	});

	it("shows file summary progress after recording a file summary", async () => {
		const { logger, infoEntries } = createLoggerSpy();
		const hooks = createReviewSessionHooks(
			config,
			logger,
			[],
			createProgressState({
				prSummary: "done",
				fileSummaries: [
					{ path: "src/first.ts", summary: "done" },
					{ path: "src/second.ts", summary: "done" },
				],
			}),
		);

		await hooks.onPostToolUse({
			toolName: "record_file_summary",
			toolArgs: { path: "src/third.ts", summary: "adds guard" },
			toolResult: { textResultForLlm: "ok", resultType: "success" },
			cwd: "/tmp/repo",
		});

		assert.deepEqual(infoEntries, [
			{
				message:
					"Copilot completed tool record_file_summary result=success path=src/third.ts findings=0/3 file_summaries=2/4 pr_summary=recorded",
				details: [],
			},
		]);
	});

	it("disables file summary progress and guidance for large reviews", async () => {
		const largeReviewCount = MAX_REVIEWED_FILES_WITH_PER_FILE_SUMMARIES + 1;
		const { logger, infoEntries } = createLoggerSpy();
		const hooks = createReviewSessionHooks(
			config,
			logger,
			[],
			createProgressState(
				{ prSummary: "done", fileSummaries: [] },
				largeReviewCount,
			),
		);

		const sessionStart = await hooks.onSessionStart();
		assert.match(
			sessionStart.additionalContext,
			/per-file summaries are disabled for large reviews with more than 25 reviewed files/i,
		);

		const preUse = await hooks.onPreToolUse({
			toolName: "record_file_summary",
			toolArgs: { path: "src/file.ts", summary: "adds guard" },
			cwd: "/tmp/repo",
		});
		assert.deepEqual(preUse, {
			permissionDecision: "allow",
			additionalContext:
				"Per-file summaries are disabled for reviews with more than 25 reviewed files; do not use this tool.",
		});

		const postUse = await hooks.onPostToolUse({
			toolName: "record_pr_summary",
			toolArgs: { summary: "ok" },
			toolResult: { textResultForLlm: "ok", resultType: "success" },
			cwd: "/tmp/repo",
		});
		assert.deepEqual(postUse, {
			additionalContext:
				"Keep the PR summary concise and factual. Per-file summaries are disabled for reviews with more than 25 reviewed files, so continue reviewing without recording them.",
		});

		assert.deepEqual(infoEntries, [
			{
				message: "Copilot requested tool record_file_summary path=src/file.ts",
				details: [],
			},
			{
				message:
					"Copilot completed tool record_pr_summary result=success summary_chars=2 findings=0/3 file_summaries=disabled pr_summary=recorded",
				details: [],
			},
		]);
	});
});

describe("buildCopilotClientOptions", () => {
	it("pins the resolved bundled copilot cli path into client options", () => {
		const options = buildCopilotClientOptions(
			config,
			() => "/tmp/node_modules/@github/copilot/index.js",
		);

		assert.equal(options.cliPath, "/tmp/node_modules/@github/copilot/index.js");
		assert.equal(options.cwd, config.repoRoot);
		assert.equal(options.logLevel, "error");
		assert.equal("useLoggedInUser" in options, false);
		assert.equal("githubToken" in options, false);
	});

	it("passes the debug log level through without overriding SDK auth", () => {
		const options = buildCopilotClientOptions(
			{
				...config,
				logLevel: "debug",
			},
			() => "/tmp/node_modules/@github/copilot/index.js",
		);

		assert.equal(options.cliPath, "/tmp/node_modules/@github/copilot/index.js");
		assert.equal(options.logLevel, "debug");
		assert.equal("useLoggedInUser" in options, false);
		assert.equal("githubToken" in options, false);
	});
});

describe("runCopilotReview", () => {
	it("passes the explicit bundled cli path into the created Copilot client", async () => {
		const context = createReviewContext();
		const createdOptions: Array<Record<string, unknown>> = [];

		const session = {
			on() {
				return () => {};
			},
			async sendAndWait() {
				return { data: { content: "Looks good." } };
			},
			async disconnect() {},
		};

		const outcome = await runCopilotReview(
			config,
			context,
			{} as never,
			createLoggerSpy().logger,
			{
				resolveCliPath: () => "/tmp/node_modules/@github/copilot/index.js",
				createCopilotClient(options) {
					createdOptions.push(options as Record<string, unknown>);

					return {
						async start() {},
						async createSession() {
							throw new Error("createSession should not be called directly");
						},
						async stop() {
							return [];
						},
					};
				},
				async createReviewSession() {
					return session;
				},
			},
		);

		assert.equal(createdOptions.length, 1);
		assert.equal(
			createdOptions[0]?.cliPath,
			"/tmp/node_modules/@github/copilot/index.js",
		);
		assert.equal(createdOptions[0]?.cwd, config.repoRoot);
		assert.equal(outcome.findings.length, 0);
		assert.equal(outcome.assistantMessage, "Looks good.");
	});
});
