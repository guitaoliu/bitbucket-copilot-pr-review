import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReviewerConfig } from "../config/types.ts";
import type { FindingDraft, ReviewSummaryDrafts } from "../review/types.ts";
import type { Logger } from "../shared/logger.ts";
import { createReviewSessionHooks } from "./engine.ts";

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
			/Inspect the diff and relevant head\/base code/,
		);
		assert.match(
			result.additionalContext,
			/Flag any meaningful behavior change that lacks appropriate automated test coverage/,
		);
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
			toolArgs: { query: "foo", version: "head", directory: "src" },
			toolResult: { textResultForLlm: "[]", resultType: "success" },
			cwd: "/tmp/repo",
		});

		assert.deepEqual(result, {
			additionalContext:
				"Use this context to confirm or reject a specific hypothesis, then move to the next uncovered risky path and stay focused on PR-introduced risk.",
		});
		assert.deepEqual(infoEntries, [
			{
				message:
					"Copilot completed tool search_text_in_repo result=success query=foo version=head directory=src findings=0/3 file_summaries=0/4 pr_summary=missing",
				details: [],
			},
		]);
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
					"Copilot completed tool get_file_content result=success path=src/file.ts version=head findings=0/3 file_summaries=0/4 pr_summary=recorded",
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
});
