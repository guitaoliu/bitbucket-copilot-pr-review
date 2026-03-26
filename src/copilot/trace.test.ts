import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEvent } from "@github/copilot-sdk";
import type { Logger } from "../shared/logger.ts";
import { createSessionEventTracer } from "./trace.ts";

function createLoggerSpy(): {
	logger: Logger;
	traceCalls: Array<{ message: string; details: unknown[] }>;
	infoCalls: Array<{ message: string; details: unknown[] }>;
} {
	const traceCalls: Array<{ message: string; details: unknown[] }> = [];
	const infoCalls: Array<{ message: string; details: unknown[] }> = [];

	return {
		logger: {
			debug() {},
			info(message, ...details) {
				infoCalls.push({ message, details });
			},
			warn() {},
			error() {},
			trace(message, ...details) {
				traceCalls.push({ message, details });
			},
			json() {},
		},
		traceCalls,
		infoCalls,
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
});
