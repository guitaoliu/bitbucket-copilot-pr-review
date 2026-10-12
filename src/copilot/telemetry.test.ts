import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PermissionRequest, SessionEvent } from "@github/copilot-sdk";

import { createReviewToolTelemetryTracker } from "./telemetry.ts";
import { buildToolCompletionLog } from "./tool-log.ts";
import { createReviewToolState } from "./tools/context.ts";

function startEvent(
	toolCallId: string,
	toolName: string,
	timestamp: string,
	args: unknown = {},
): SessionEvent {
	return {
		id: `start-${toolCallId}`,
		timestamp,
		parentId: null,
		type: "tool.execution_start",
		data: { toolCallId, toolName, arguments: args },
	} as SessionEvent;
}

function completeEvent(
	toolCallId: string,
	timestamp: string,
	outcome: { success: true; content?: string } | { error: string },
): SessionEvent {
	return {
		id: `complete-${toolCallId}`,
		timestamp,
		parentId: null,
		type: "tool.execution_complete",
		data:
			"error" in outcome
				? { toolCallId, success: false, error: { message: outcome.error } }
				: {
						toolCallId,
						success: true,
						...(outcome.content
							? { result: { content: outcome.content } }
							: {}),
					},
	} as SessionEvent;
}

const emptySnapshotInput = {
	sessionDurationMs: 5_000,
	inspection: createReviewToolState().inspection,
	coverage: { deliveredPages: 0, complete: false },
};

describe("createReviewToolTelemetryTracker", () => {
	it("counts each tool call once with durations from event timestamps", () => {
		const tracker = createReviewToolTelemetryTracker();

		tracker.handleEvent(
			startEvent("call-1", "read_file", "2026-09-11T00:00:00.000Z"),
		);
		const completed = tracker.handleEvent(
			completeEvent("call-1", "2026-09-11T00:00:01.250Z", {
				success: true,
			}),
		);
		tracker.handleEvent(
			completeEvent("call-1", "2026-09-11T00:00:02.000Z", {
				success: true,
			}),
		);

		assert.equal(completed?.durationMs, 1_250);
		assert.deepEqual(tracker.snapshot(emptySnapshotInput), {
			totalRequested: 1,
			totalAllowed: 1,
			totalDenied: 0,
			totalCompleted: 1,
			totalDurationMs: 1_250,
			sessionDurationMs: 5_000,
			errorCount: 0,
			completionFollowUps: 0,
			byTool: {
				read_file: {
					requested: 1,
					allowed: 1,
					denied: 0,
					completed: 1,
					resultCounts: { success: 1 },
					totalDurationMs: 1_250,
				},
			},
		});
	});

	it("uses the handler result to distinguish rejected calls from failures", () => {
		const tracker = createReviewToolTelemetryTracker();

		tracker.handleEvent(
			startEvent("call-1", "search_repo", "2026-09-11T00:00:00.000Z"),
		);
		tracker.recordHandlerStart({
			toolCallId: "call-1",
			toolName: "search_repo",
			operationKey: "regex-query",
		});
		tracker.recordHandlerResult("call-1", "rejected");
		tracker.handleEvent(
			completeEvent("call-1", "2026-09-11T00:00:00.100Z", {
				error: "Invalid repository search regex.",
			}),
		);

		assert.deepEqual(tracker.getUnresolvedContextTools(), []);
		assert.deepEqual(
			tracker.snapshot(emptySnapshotInput).byTool.search_repo?.resultCounts,
			{ rejected: 1 },
		);
	});

	it("classifies SDK input validation failures as rejected", () => {
		const tracker = createReviewToolTelemetryTracker();

		tracker.handleEvent(
			startEvent("call-1", "read_file", "2026-09-11T00:00:00.000Z"),
		);
		tracker.handleEvent(
			completeEvent("call-1", "2026-09-11T00:00:00.100Z", {
				error:
					'Invalid input for builtin tool read_file: /ranges/1: "end" is a required property',
			}),
		);

		assert.deepEqual(tracker.getUnresolvedContextTools(), []);
		const snapshot = tracker.snapshot(emptySnapshotInput);
		assert.deepEqual(snapshot.byTool.read_file?.resultCounts, { rejected: 1 });
		assert.equal(snapshot.errorCount, 1);
	});

	it("keeps a context failure unresolved until the same operation succeeds", () => {
		const tracker = createReviewToolTelemetryTracker();
		const runCall = (
			toolCallId: string,
			operationKey: string,
			resultType: "success" | "failure",
		) => {
			tracker.handleEvent(
				startEvent(toolCallId, "search_repo", "2026-09-11T00:00:00.000Z"),
			);
			tracker.recordHandlerStart({
				toolCallId,
				toolName: "search_repo",
				operationKey,
			});
			tracker.recordHandlerResult(toolCallId, resultType);
			tracker.handleEvent(
				completeEvent(
					toolCallId,
					"2026-09-11T00:00:00.100Z",
					resultType === "success" ? { success: true } : { error: "boom" },
				),
			);
		};

		runCall("call-1", "query-a", "failure");
		runCall("call-2", "query-b", "success");
		assert.deepEqual(tracker.getUnresolvedContextTools(), ["search_repo"]);

		runCall("call-3", "query-a", "success");
		assert.deepEqual(tracker.getUnresolvedContextTools(), []);
		assert.deepEqual(
			tracker.snapshot(emptySnapshotInput).byTool.search_repo?.resultCounts,
			{ failure: 1, success: 2 },
		);
	});

	it("fails closed when a context tool fails before its handler runs", () => {
		const tracker = createReviewToolTelemetryTracker();

		tracker.handleEvent(
			startEvent("call-1", "find_files", "2026-09-11T00:00:00.000Z"),
		);
		tracker.handleEvent(
			completeEvent("call-1", "2026-09-11T00:00:00.100Z", {
				error: "Timed out",
			}),
		);

		assert.deepEqual(tracker.getUnresolvedContextTools(), ["find_files"]);
	});

	it("counts permission denials, reported errors, and inspection metrics", () => {
		const tracker = createReviewToolTelemetryTracker();
		const inspection = createReviewToolState().inspection;
		inspection.resultCharsByTool.review_changes = 42;
		inspection.searchRepoMetrics.uniqueQueries = 2;

		tracker.handleEvent(
			startEvent("call-1", "review_changes", "2026-09-11T00:00:00.000Z"),
		);
		tracker.handleEvent(
			startEvent("call-2", "search_repo", "2026-09-11T00:00:00.000Z"),
		);
		tracker.recordPermissionDenied({
			kind: "custom-tool",
			toolCallId: "call-2",
			toolName: "search_repo",
			toolDescription: "Search",
		} satisfies PermissionRequest);
		tracker.recordPermissionDenied({
			kind: "shell",
			toolCallId: "shell-1",
			commands: [],
			fullCommandText: "git diff",
			intention: "Inspect",
			hasWriteFileRedirection: false,
			possiblePaths: [],
			possibleUrls: [],
			canOfferSessionApproval: false,
		} as PermissionRequest);
		tracker.recordError();

		const snapshot = tracker.snapshot({
			sessionDurationMs: 10,
			inspection,
			coverage: { deliveredPages: 1, totalPages: 1, complete: true },
		});

		assert.equal(snapshot.totalRequested, 2);
		assert.equal(snapshot.totalAllowed, 1);
		assert.equal(snapshot.totalDenied, 2);
		assert.equal(snapshot.errorCount, 1);
		assert.equal(snapshot.byTool.search_repo?.denied, 1);
		assert.equal(snapshot.byTool.search_repo?.uniqueQueries, 2);
		assert.deepEqual(
			{
				resultCharsTotal: snapshot.byTool.review_changes?.resultCharsTotal,
				coverageDeliveredPages:
					snapshot.byTool.review_changes?.coverageDeliveredPages,
				coverageTotalPages: snapshot.byTool.review_changes?.coverageTotalPages,
				coverageComplete: snapshot.byTool.review_changes?.coverageComplete,
			},
			{
				resultCharsTotal: 42,
				coverageDeliveredPages: 1,
				coverageTotalPages: 1,
				coverageComplete: true,
			},
		);
	});
});

describe("buildToolCompletionLog", () => {
	it("summarizes the call with arguments, duration, and review progress", () => {
		const state = createReviewToolState();
		state.droppedFindings.unchanged_line = 1;

		assert.deepEqual(
			buildToolCompletionLog(
				{
					toolCallId: "call-1",
					toolName: "emit_finding",
					arguments: { path: "src/app.ts", line: 9 },
					resultType: "rejected",
					durationMs: 12,
					error: "Line 9 is not a changed line in src/app.ts.",
					result: "Line 9 is not a changed line in src/app.ts.",
				},
				state,
			),
			{
				message:
					'Copilot completed tool emit_finding result=rejected duration_ms=12 error="Line 9 is not a changed line in src/app.ts." path=src/app.ts line=9 findings=0 dropped_findings_unknown_file=0 dropped_findings_unchanged_line=1 pr_summary=missing',
				details: { result: "Line 9 is not a changed line in src/app.ts." },
			},
		);
	});
});
