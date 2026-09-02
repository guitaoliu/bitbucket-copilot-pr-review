import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEvent } from "@github/copilot-sdk";
import type { Logger } from "../shared/logger.ts";
import { createSessionEventTracer } from "./trace.ts";

function createLoggerSpy(): {
	logger: Logger;
	traceCalls: Array<{ message: string; details: unknown[] }>;
	infoCalls: Array<{ message: string; details: unknown[] }>;
	warnCalls: Array<{ message: string; details: unknown[] }>;
} {
	const traceCalls: Array<{ message: string; details: unknown[] }> = [];
	const infoCalls: Array<{ message: string; details: unknown[] }> = [];
	const warnCalls: Array<{ message: string; details: unknown[] }> = [];

	return {
		logger: {
			debug() {},
			info(message, ...details) {
				infoCalls.push({ message, details });
			},
			warn(message, ...details) {
				warnCalls.push({ message, details });
			},
			error() {},
			trace(message, ...details) {
				traceCalls.push({ message, details });
			},
			json() {},
		},
		traceCalls,
		infoCalls,
		warnCalls,
	};
}

describe("createSessionEventTracer", () => {
	it("buffers deltas and logs one reasoning block when completed", () => {
		const { logger, traceCalls } = createLoggerSpy();
		const tracer = createSessionEventTracer(logger);

		tracer.handleEvent({
			id: "1",
			timestamp: "2026-03-25T00:00:00.000Z",
			parentId: null,
			ephemeral: true,
			type: "assistant.reasoning_delta",
			data: {
				reasoningId: "r1",
				deltaContent: "Hel",
			},
		});
		tracer.handleEvent({
			id: "2",
			timestamp: "2026-03-25T00:00:00.000Z",
			parentId: "1",
			ephemeral: true,
			type: "assistant.reasoning_delta",
			data: {
				reasoningId: "r1",
				deltaContent: "lo",
			},
		});
		tracer.handleEvent({
			id: "3",
			timestamp: "2026-03-25T00:00:00.000Z",
			parentId: "2",
			type: "assistant.reasoning",
			data: {
				reasoningId: "r1",
				content: "ignored fallback",
			},
		});

		assert.deepEqual(traceCalls, [
			{
				message: "copilot reasoning",
				details: [{ reasoningId: "r1", content: "Hello" }],
			},
		]);
		assert.equal(tracer.getReasoningStatus(), "content");
	});

	it("reports empty reasoning events without logging content", () => {
		const { logger, traceCalls } = createLoggerSpy();
		const tracer = createSessionEventTracer(logger);

		tracer.handleEvent({
			id: "1",
			timestamp: "2026-03-25T00:00:00.000Z",
			parentId: null,
			type: "assistant.reasoning",
			data: {
				reasoningId: "r-empty",
				content: "",
			},
		});

		assert.deepEqual(traceCalls, []);
		assert.equal(tracer.getReasoningStatus(), "empty");
	});

	it("reports empty reasoning deltas without logging content", () => {
		const { logger, traceCalls } = createLoggerSpy();
		const tracer = createSessionEventTracer(logger);

		tracer.handleEvent({
			id: "1",
			timestamp: "2026-03-25T00:00:00.000Z",
			parentId: null,
			ephemeral: true,
			type: "assistant.reasoning_delta",
			data: {
				reasoningId: "r-empty",
				deltaContent: "",
			},
		});

		assert.deepEqual(traceCalls, []);
		assert.equal(tracer.getReasoningStatus(), "empty");
	});

	it("falls back to full reasoning content when no deltas arrive", () => {
		const { logger, traceCalls } = createLoggerSpy();
		const tracer = createSessionEventTracer(logger);

		tracer.handleEvent({
			id: "1",
			timestamp: "2026-03-25T00:00:00.000Z",
			parentId: null,
			type: "assistant.reasoning",
			data: {
				reasoningId: "r2",
				content: "Complete reasoning",
			},
		});

		assert.deepEqual(traceCalls, [
			{
				message: "copilot reasoning",
				details: [{ reasoningId: "r2", content: "Complete reasoning" }],
			},
		]);
	});

	it("flushes buffered reasoning on idle when completion does not arrive", () => {
		const { logger, traceCalls } = createLoggerSpy();
		const tracer = createSessionEventTracer(logger);

		tracer.handleEvent({
			id: "1",
			timestamp: "2026-03-25T00:00:00.000Z",
			parentId: null,
			ephemeral: true,
			type: "assistant.reasoning_delta",
			data: {
				reasoningId: "r3",
				deltaContent: "Partial",
			},
		});
		tracer.handleEvent({
			id: "2",
			timestamp: "2026-03-25T00:00:00.000Z",
			parentId: "1",
			ephemeral: true,
			type: "session.idle",
			data: {},
		});

		assert.deepEqual(traceCalls, [
			{
				message: "copilot reasoning",
				details: [{ reasoningId: "r3", content: "Partial" }],
			},
		]);
	});

	it("logs system notifications through the shared logger", () => {
		const { logger, infoCalls } = createLoggerSpy();
		const tracer = createSessionEventTracer(logger);

		const event = {
			id: "1",
			timestamp: "2026-03-25T00:00:00.000Z",
			parentId: null,
			ephemeral: true,
			type: "system.notification",
			data: {
				content: "<system_notification>Agent completed</system_notification>",
				kind: {
					type: "agent_completed",
					agentId: "agent-1",
					agentType: "explore",
					status: "completed",
				},
			},
		} as SessionEvent;

		tracer.handleEvent(event);

		assert.deepEqual(infoCalls, [
			{
				message: "Copilot system notification",
				details: [
					{
						kind: "agent_completed",
						status: "completed",
						content:
							"<system_notification>Agent completed</system_notification>",
					},
				],
			},
		]);
	});

	it("records non-zero background shell exits as failures", () => {
		const { infoCalls, logger, warnCalls } = createLoggerSpy();
		const tracer = createSessionEventTracer(logger);

		tracer.handleEvent({
			id: "1",
			timestamp: "2026-03-25T00:00:00.000Z",
			parentId: null,
			ephemeral: true,
			type: "system.notification",
			data: {
				content: "<system_notification>Shell failed</system_notification>",
				kind: {
					type: "shell_completed",
					shellId: "shell-1",
					exitCode: 128,
					description: "Inspect the diff",
				},
			},
		} as SessionEvent);

		assert.equal(tracer.getFailedBackgroundShellCount(), 1);
		assert.deepEqual(infoCalls, []);
		assert.deepEqual(warnCalls, [
			{
				message: "Copilot background shell failed",
				details: [
					{
						shellId: "shell-1",
						exitCode: 128,
						description: "Inspect the diff",
						content: "<system_notification>Shell failed</system_notification>",
					},
				],
			},
		]);
	});

	it("logs assistant intent as visible progress", () => {
		const { logger, infoCalls } = createLoggerSpy();
		const tracer = createSessionEventTracer(logger);

		tracer.handleEvent({
			id: "1",
			timestamp: "2026-03-25T00:00:00.000Z",
			parentId: null,
			ephemeral: true,
			type: "assistant.intent",
			data: {
				intent: "Inspecting the changed file and nearby tests",
			},
		});

		assert.deepEqual(infoCalls, [
			{
				message: "Copilot intent",
				details: [
					{
						agentId: undefined,
						intent: "Inspecting the changed file and nearby tests",
					},
				],
			},
		]);
	});

	it("logs structured model call failure diagnostics", () => {
		const { logger, warnCalls } = createLoggerSpy();
		const tracer = createSessionEventTracer(logger);

		tracer.handleEvent({
			id: "1",
			timestamp: "2026-03-25T00:00:00.000Z",
			parentId: null,
			ephemeral: true,
			type: "model.call_failure",
			data: {
				source: "top_level",
				model: "gpt-5.6-terra",
				failureKind: "api",
				transport: "websocket",
				statusCode: 400,
				badRequestKind: "structured_error",
				errorCode: "model_max_prompt_tokens_exceeded",
				errorType: "websocket_error",
				durationMs: 1250,
				serviceRequestId: "service-request-1",
				providerCallId: "provider-call-1",
				reasoningEffort: "xhigh",
				isAuto: false,
				isByok: false,
			},
		});

		assert.deepEqual(warnCalls, [
			{
				message: "Copilot model call failed",
				details: [
					{
						agentId: undefined,
						source: "top_level",
						model: "gpt-5.6-terra",
						failureKind: "api",
						transport: "websocket",
						statusCode: 400,
						badRequestKind: "structured_error",
						errorCode: "model_max_prompt_tokens_exceeded",
						errorType: "websocket_error",
						durationMs: 1250,
						serviceRequestId: "service-request-1",
						providerCallId: "provider-call-1",
						reasoningEffort: "xhigh",
						isAuto: false,
						isByok: false,
					},
				],
			},
		]);
	});

	it("logs tool planning from assistant messages", () => {
		const { logger, infoCalls, traceCalls } = createLoggerSpy();
		const tracer = createSessionEventTracer(logger);

		tracer.handleEvent({
			id: "1",
			timestamp: "2026-03-25T00:00:00.000Z",
			parentId: null,
			type: "assistant.message",
			data: {
				content: "",
				phase: "tool_planning",
				toolRequests: [
					{
						toolCallId: "tool-1",
						name: "bash",
						arguments: {},
						intentionSummary: "Inspect the diff first",
					},
					{
						toolCallId: "tool-2",
						name: "emit_finding",
						arguments: {},
					},
				],
			},
		} as SessionEvent);

		assert.deepEqual(traceCalls, []);
		assert.deepEqual(infoCalls, [
			{
				message: "Copilot planned tool calls",
				details: [
					{
						phase: "tool_planning",
						toolCount: 2,
						toolNames: ["bash", "emit_finding"],
						intentionSummaries: ["Inspect the diff first"],
					},
				],
			},
		]);
	});

	it("logs sandboxed bash outcomes without command arguments", () => {
		const { logger, infoCalls } = createLoggerSpy();
		const tracer = createSessionEventTracer(logger);

		tracer.handleEvent({
			id: "1",
			timestamp: "2026-03-25T00:00:00.000Z",
			parentId: null,
			type: "tool.execution_start",
			data: {
				toolCallId: "bash-1",
				toolName: "bash",
				arguments: { command: "git diff --stat" },
			},
		} as unknown as SessionEvent);
		tracer.handleEvent({
			id: "2",
			timestamp: new Date("2026-03-25T00:00:01.350Z"),
			parentId: "1",
			type: "tool.execution_complete",
			data: {
				toolCallId: "bash-1",
				success: true,
				sandboxed: true,
				result: { content: "6 files changed" },
			},
		} as unknown as SessionEvent);
		tracer.handleEvent({
			id: "3",
			timestamp: "2026-03-25T00:00:02.000Z",
			parentId: "2",
			type: "tool.execution_start",
			data: {
				toolCallId: "finding-1",
				toolName: "emit_finding",
				arguments: { path: "src/service.ts", line: 10 },
			},
		} as SessionEvent);
		tracer.handleEvent({
			id: "4",
			timestamp: "2026-03-25T00:00:03.000Z",
			parentId: "3",
			type: "tool.execution_complete",
			data: {
				toolCallId: "finding-1",
				success: true,
				result: { content: "Line 10 is not a changed line in src/service.ts." },
			},
		} as SessionEvent);

		assert.deepEqual(infoCalls, [
			{
				message: "Copilot bash call",
				details: [{ toolCallId: "bash-1" }],
			},
			{
				message: "Copilot completed bash call",
				details: [
					{
						toolCallId: "bash-1",
						success: true,
						sandboxed: true,
						durationMs: 1350,
					},
				],
			},
			{
				message: "Copilot completed review tool",
				details: [
					{
						toolCallId: "finding-1",
						toolName: "emit_finding",
						success: true,
						durationMs: 1000,
						result: "Line 10 is not a changed line in src/service.ts.",
					},
				],
			},
		]);
	});

	it("tracks unsandboxed bash without logging its error text", () => {
		const { logger, infoCalls } = createLoggerSpy();
		const tracer = createSessionEventTracer(logger);

		tracer.handleEvent({
			id: "1",
			timestamp: "2026-03-25T00:00:00.000Z",
			parentId: null,
			type: "tool.execution_start",
			data: {
				toolCallId: "bash-1",
				toolName: "bash",
				arguments: { command: "curl -u exposed:credential example.com" },
			},
		} as unknown as SessionEvent);
		tracer.handleEvent({
			id: "2",
			timestamp: "2026-03-25T00:00:01.000Z",
			parentId: "1",
			type: "tool.execution_complete",
			data: {
				toolCallId: "bash-1",
				success: false,
				sandboxed: false,
				error: {
					message: "Command failed: curl -u exposed:credential example.com",
				},
			},
		} as unknown as SessionEvent);

		assert.equal(tracer.getUnsandboxedShellCount(), 1);
		assert.doesNotMatch(JSON.stringify(infoCalls), /exposed:credential/);
	});

	it("logs subagent lifecycle progress", () => {
		const { logger, infoCalls, warnCalls } = createLoggerSpy();
		const tracer = createSessionEventTracer(logger);

		tracer.handleEvent({
			id: "1",
			timestamp: "2026-03-25T00:00:00.000Z",
			parentId: null,
			type: "subagent.started",
			agentId: "agent-1",
			data: {
				agentName: "explore",
				agentDisplayName: "Explore Agent",
				agentDescription: "Searches the codebase",
				toolCallId: "tool-1",
			},
		});
		tracer.handleEvent({
			id: "2",
			timestamp: "2026-03-25T00:00:01.000Z",
			parentId: "1",
			type: "subagent.completed",
			agentId: "agent-1",
			data: {
				agentName: "explore",
				agentDisplayName: "Explore Agent",
				durationMs: 500,
				totalToolCalls: 3,
				toolCallId: "tool-1",
			},
		});
		tracer.handleEvent({
			id: "3",
			timestamp: "2026-03-25T00:00:02.000Z",
			parentId: "2",
			type: "subagent.failed",
			agentId: "agent-2",
			data: {
				agentName: "builder",
				agentDisplayName: "Builder Agent",
				error: "Tool call failed",
				durationMs: 200,
				toolCallId: "tool-2",
			},
		});

		assert.deepEqual(infoCalls, [
			{
				message: "Copilot subagent started",
				details: [
					{
						agentId: "agent-1",
						agentName: "explore",
						agentDisplayName: "Explore Agent",
						agentDescription: "Searches the codebase",
					},
				],
			},
			{
				message: "Copilot subagent completed",
				details: [
					{
						agentId: "agent-1",
						agentName: "explore",
						agentDisplayName: "Explore Agent",
						durationMs: 500,
						totalToolCalls: 3,
					},
				],
			},
		]);
		assert.deepEqual(warnCalls, [
			{
				message: "Copilot subagent failed",
				details: [
					{
						agentId: "agent-2",
						agentName: "builder",
						agentDisplayName: "Builder Agent",
						error: "Tool call failed",
						durationMs: 200,
					},
				],
			},
		]);
	});
});
