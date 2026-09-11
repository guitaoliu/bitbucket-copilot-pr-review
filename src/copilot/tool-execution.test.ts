import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	defineTool,
	type SessionEvent,
	type ToolHandler,
} from "@github/copilot-sdk";
import { z } from "zod";

import { createReviewToolExecutionTracker } from "./tool-execution.ts";

const searchSchema = z.object({
	revision: z.enum(["merge-base", "base", "head"]),
	patterns: z.array(z.string()),
	patternType: z.enum(["literal", "regex"]).default("literal"),
	paths: z.array(z.string()).default([]),
	contextLines: z.number().default(0),
	page: z.number().default(1),
});

function invocation(toolCallId: string, args: unknown) {
	return {
		sessionId: "session-1",
		toolCallId,
		toolName: "search_repo",
		arguments: args,
	};
}

function executionEvent(
	type: "tool.execution_start" | "tool.execution_complete",
	data: Record<string, unknown>,
): SessionEvent {
	return {
		id: `${type}-${String(data.toolCallId)}`,
		timestamp: "2026-09-11T00:00:00.000Z",
		parentId: null,
		type,
		data,
	} as unknown as SessionEvent;
}

function getHandler(tool: { handler?: unknown }): ToolHandler {
	assert.equal(typeof tool.handler, "function");
	return tool.handler as ToolHandler;
}

describe("createReviewToolExecutionTracker", () => {
	it("uses the handler result to distinguish rejected calls from failures", async () => {
		const tracker = createReviewToolExecutionTracker();
		const [tool] = tracker.trackTools([
			defineTool("search_repo", {
				parameters: searchSchema,
				handler: async () => ({
					textResultForLlm: "Invalid regular expression",
					resultType: "rejected" as const,
				}),
			}),
		]);
		assert.ok(tool);
		const args = { revision: "head", patterns: ["("] };

		await getHandler(tool)(args, invocation("call-1", args));
		tracker.handleEvent(
			executionEvent("tool.execution_complete", {
				toolCallId: "call-1",
				success: false,
				error: { message: "Invalid regular expression" },
			}),
		);

		assert.deepEqual(tracker.getUnresolvedContextTools(), []);
		assert.deepEqual(tracker.getResultCounts(), {
			search_repo: { rejected: 1 },
		});
	});

	it("fails closed for an event-only context failure", () => {
		const tracker = createReviewToolExecutionTracker();
		tracker.trackTools([
			defineTool("search_repo", {
				parameters: searchSchema,
				handler: async () => "unused",
			}),
		]);
		const args = { revision: "head", patterns: ["value"] };

		tracker.handleEvent(
			executionEvent("tool.execution_start", {
				toolCallId: "call-1",
				toolName: "search_repo",
				arguments: args,
			}),
		);
		tracker.handleEvent(
			executionEvent("tool.execution_complete", {
				toolCallId: "call-1",
				success: false,
				error: { message: "Timed out" },
			}),
		);

		assert.deepEqual(tracker.getUnresolvedContextTools(), ["search_repo"]);
		assert.deepEqual(tracker.getResultCounts(), {
			search_repo: { failure: 1 },
		});
	});

	it("clears only the same normalized operation after a successful retry", async () => {
		const tracker = createReviewToolExecutionTracker();
		const [tool] = tracker.trackTools([
			defineTool("search_repo", {
				parameters: searchSchema,
				handler: async () => "matches",
			}),
		]);
		assert.ok(tool);
		const failedArgs = { revision: "head", patterns: ["value"] };

		tracker.handleEvent(
			executionEvent("tool.execution_start", {
				toolCallId: "call-1",
				toolName: "search_repo",
				arguments: failedArgs,
			}),
		);
		tracker.handleEvent(
			executionEvent("tool.execution_complete", {
				toolCallId: "call-1",
				success: false,
				error: { message: "Timed out" },
			}),
		);
		const differentArgs = { revision: "head", patterns: ["other"] };
		await getHandler(tool)(differentArgs, invocation("call-2", differentArgs));
		assert.deepEqual(tracker.getUnresolvedContextTools(), ["search_repo"]);

		const explicitDefaults = {
			...failedArgs,
			patternType: "literal" as const,
			paths: [],
			contextLines: 0,
			page: 1,
		};
		await getHandler(tool)(
			explicitDefaults,
			invocation("call-3", explicitDefaults),
		);

		assert.deepEqual(tracker.getUnresolvedContextTools(), []);
	});
});
