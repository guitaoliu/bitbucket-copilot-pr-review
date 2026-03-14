import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Logger } from "../shared/logger.ts";
import { wireReasoningTrace } from "./trace.ts";

type Handler = (event: {
	data: { reasoningId: string; deltaContent?: string; content?: string };
}) => void;

function createSessionStub() {
	const handlers = new Map<string, Handler[]>();

	return {
		on(eventName: string, handler: Handler) {
			handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
		},
		emit(
			eventName: string,
			data: { reasoningId: string; deltaContent?: string; content?: string },
		) {
			for (const handler of handlers.get(eventName) ?? []) {
				handler({ data });
			}
		},
	};
}

describe("wireReasoningTrace", () => {
	it("buffers deltas and logs one reasoning block when completed", () => {
		const traceCalls: Array<{ message: string; details: unknown[] }> = [];
		const logger: Logger = {
			debug() {},
			info() {},
			warn() {},
			error() {},
			trace(message, ...details) {
				traceCalls.push({ message, details });
			},
			json() {},
		};
		const session = createSessionStub();

		wireReasoningTrace(session as never, logger);

		session.emit("assistant.reasoning_delta", {
			reasoningId: "r1",
			deltaContent: "Hel",
		});
		session.emit("assistant.reasoning_delta", {
			reasoningId: "r1",
			deltaContent: "lo",
		});
		session.emit("assistant.reasoning", {
			reasoningId: "r1",
			content: "ignored fallback",
		});

		assert.deepEqual(traceCalls, [
			{
				message: "copilot reasoning",
				details: [{ reasoningId: "r1", content: "Hello" }],
			},
		]);
	});

	it("falls back to full reasoning content when no deltas arrive", () => {
		const traceCalls: Array<{ message: string; details: unknown[] }> = [];
		const logger: Logger = {
			debug() {},
			info() {},
			warn() {},
			error() {},
			trace(message, ...details) {
				traceCalls.push({ message, details });
			},
			json() {},
		};
		const session = createSessionStub();

		wireReasoningTrace(session as never, logger);

		session.emit("assistant.reasoning", {
			reasoningId: "r2",
			content: "Complete reasoning",
		});

		assert.deepEqual(traceCalls, [
			{
				message: "copilot reasoning",
				details: [{ reasoningId: "r2", content: "Complete reasoning" }],
			},
		]);
	});

	it("flushes buffered reasoning on idle when completion does not arrive", () => {
		const traceCalls: Array<{ message: string; details: unknown[] }> = [];
		const logger: Logger = {
			debug() {},
			info() {},
			warn() {},
			error() {},
			trace(message, ...details) {
				traceCalls.push({ message, details });
			},
			json() {},
		};
		const session = createSessionStub();

		wireReasoningTrace(session as never, logger);

		session.emit("assistant.reasoning_delta", {
			reasoningId: "r3",
			deltaContent: "Partial",
		});
		session.emit("session.idle", { reasoningId: "idle" });

		assert.deepEqual(traceCalls, [
			{
				message: "copilot reasoning",
				details: [{ reasoningId: "r3", content: "Partial" }],
			},
		]);
	});
});
