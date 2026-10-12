import type { PermissionRequest, SessionEvent } from "@github/copilot-sdk";

import type {
	ReviewToolTelemetry,
	ReviewToolTelemetryCounter,
} from "../review/types.ts";
import type { ReviewCoverage } from "./review-bundle.ts";
import type { ReviewInspectionState } from "./tools/context.ts";
import type { ReviewToolCallObserver, ToolResultType } from "./tools/define.ts";
import { CONTEXT_TOOL_NAMES } from "./tools/index.ts";

interface ToolCallRecord {
	toolName?: string;
	arguments?: unknown;
	startedAtMs?: number;
	operationKey?: string;
	handlerResult?: ToolResultType;
	denied?: true;
	completion?: { resultType: ToolResultType; durationMs: number };
}

export interface CompletedToolCall {
	toolCallId: string;
	toolName: string;
	arguments: unknown;
	resultType: ToolResultType;
	durationMs: number;
	error?: string;
	result?: string;
}

export interface ReviewToolTelemetryTracker extends ReviewToolCallObserver {
	handleEvent(event: SessionEvent): CompletedToolCall | undefined;
	recordPermissionDenied(request: PermissionRequest): void;
	recordError(): void;
	recordCompletionFollowUp(): void;
	getUnresolvedContextTools(): string[];
	snapshot(input: {
		sessionDurationMs: number;
		inspection: ReviewInspectionState;
		coverage: ReviewCoverage;
	}): ReviewToolTelemetry;
}

export function isSdkToolInputValidationError(
	message: string | undefined,
): boolean {
	return (
		message !== undefined &&
		/^(?:invalid input for\b|invalid tool input(?: json)?:)/i.test(message)
	);
}

export function createReviewToolTelemetryTracker(): ReviewToolTelemetryTracker {
	const calls = new Map<string, ToolCallRecord>();
	const unresolvedOperations = new Map<string, string>();
	let unattributedDenials = 0;
	let reportedErrors = 0;
	let completionFollowUps = 0;

	const getCall = (toolCallId: string): ToolCallRecord => {
		const existing = calls.get(toolCallId);
		if (existing) {
			return existing;
		}
		const created: ToolCallRecord = {};
		calls.set(toolCallId, created);
		return created;
	};

	const complete = (
		toolCallId: string,
		event: Extract<SessionEvent, { type: "tool.execution_complete" }>,
	): CompletedToolCall | undefined => {
		const call = calls.get(toolCallId);
		if (!call?.toolName || call.completion) {
			return undefined;
		}

		const error = event.data.error?.message;
		const resultType =
			call.handlerResult ??
			(event.data.success
				? "success"
				: isSdkToolInputValidationError(error)
					? "rejected"
					: "failure");
		const durationMs =
			call.startedAtMs === undefined
				? 0
				: Math.max(0, Date.parse(event.timestamp) - call.startedAtMs);
		call.completion = { resultType, durationMs };

		if ((CONTEXT_TOOL_NAMES as readonly string[]).includes(call.toolName)) {
			const operationKey = call.operationKey ?? `call:${toolCallId}`;
			if (resultType === "success") {
				unresolvedOperations.delete(operationKey);
			} else if (resultType !== "rejected") {
				unresolvedOperations.set(operationKey, call.toolName);
			}
		}

		return {
			toolCallId,
			toolName: call.toolName,
			arguments: call.arguments,
			resultType,
			durationMs,
			...(error ? { error } : {}),
			...(event.data.result?.content
				? { result: event.data.result.content }
				: {}),
		};
	};

	return {
		recordHandlerStart({ toolCallId, toolName, operationKey }) {
			const call = getCall(toolCallId);
			call.toolName ??= toolName;
			call.operationKey = operationKey;
		},
		recordHandlerResult(toolCallId, resultType) {
			getCall(toolCallId).handlerResult = resultType;
		},
		handleEvent(event) {
			if (event.type === "tool.execution_start") {
				const call = getCall(event.data.toolCallId);
				call.toolName = event.data.toolName;
				call.arguments = event.data.arguments;
				call.startedAtMs = Date.parse(event.timestamp);
				return undefined;
			}
			if (event.type === "tool.execution_complete") {
				return complete(event.data.toolCallId, event);
			}
			return undefined;
		},
		recordPermissionDenied(request) {
			if (request.kind !== "custom-tool" || !request.toolCallId) {
				unattributedDenials += 1;
				return;
			}
			const call = getCall(request.toolCallId);
			call.toolName ??= request.toolName;
			call.denied = true;
		},
		recordError() {
			reportedErrors += 1;
		},
		recordCompletionFollowUp() {
			completionFollowUps += 1;
		},
		getUnresolvedContextTools() {
			const unresolvedToolNames = new Set(unresolvedOperations.values());
			return CONTEXT_TOOL_NAMES.filter((toolName) =>
				unresolvedToolNames.has(toolName),
			);
		},
		snapshot({ sessionDurationMs, inspection, coverage }) {
			const telemetry: ReviewToolTelemetry = {
				totalRequested: 0,
				totalAllowed: 0,
				totalDenied: unattributedDenials,
				totalCompleted: 0,
				totalDurationMs: 0,
				sessionDurationMs,
				errorCount: reportedErrors,
				completionFollowUps,
				byTool: {},
			};
			for (const call of calls.values()) {
				if (!call.toolName) {
					continue;
				}
				const counter: ReviewToolTelemetryCounter = telemetry.byTool[
					call.toolName
				] ?? {
					requested: 0,
					allowed: 0,
					denied: 0,
					completed: 0,
					resultCounts: {},
					totalDurationMs: 0,
				};
				telemetry.byTool[call.toolName] = counter;
				counter.requested += 1;
				telemetry.totalRequested += 1;
				if (call.denied) {
					counter.denied += 1;
					telemetry.totalDenied += 1;
				} else {
					counter.allowed += 1;
					telemetry.totalAllowed += 1;
				}
				if (call.completion) {
					const { resultType, durationMs } = call.completion;
					counter.completed += 1;
					counter.resultCounts[resultType] =
						(counter.resultCounts[resultType] ?? 0) + 1;
					counter.totalDurationMs += durationMs;
					telemetry.totalCompleted += 1;
					telemetry.totalDurationMs += durationMs;
					if (resultType !== "success") {
						telemetry.errorCount += 1;
					}
				}
			}

			for (const [toolName, resultChars] of Object.entries(
				inspection.resultCharsByTool,
			)) {
				const counter = telemetry.byTool[toolName];
				if (counter) {
					counter.resultCharsTotal = resultChars;
				}
			}
			const reviewCounter = telemetry.byTool.review_changes;
			if (reviewCounter) {
				reviewCounter.coverageDeliveredPages = coverage.deliveredPages;
				if (coverage.totalPages !== undefined) {
					reviewCounter.coverageTotalPages = coverage.totalPages;
				}
				reviewCounter.coverageComplete = coverage.complete;
			}
			const searchCounter = telemetry.byTool.search_repo;
			if (searchCounter) {
				Object.assign(searchCounter, inspection.searchRepoMetrics);
			}
			return telemetry;
		},
	};
}
