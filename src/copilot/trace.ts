import type { SessionEvent } from "@github/copilot-sdk";

import type { Logger } from "../shared/logger.ts";
import { REVIEW_TOOL_NAMES } from "./tools/index.ts";

export type CopilotSessionEventTracer = {
	handleEvent(event: SessionEvent): void;
	markRejectedShellCall(toolCallId: string | undefined): void;
	getReasoningStatus(): "content" | "empty" | "missing";
	getFailedBackgroundShellCount(): number;
	getUnsandboxedShellCount(): number;
};

const REVIEW_TOOL_NAME_SET: ReadonlySet<string> = new Set(REVIEW_TOOL_NAMES);

type SessionEventWithData = SessionEvent & { data?: Record<string, unknown> };

function getEventData(event: SessionEvent): Record<string, unknown> {
	return (event as SessionEventWithData).data ?? {};
}

function getBashCommand(argumentsValue: unknown): string | undefined {
	if (
		typeof argumentsValue !== "object" ||
		argumentsValue === null ||
		Array.isArray(argumentsValue)
	) {
		return undefined;
	}

	const command = (argumentsValue as Record<string, unknown>).command;
	return typeof command === "string" ? command : undefined;
}

export function createSessionEventTracer(
	logger: Logger,
): CopilotSessionEventTracer {
	const reasoningContentById = new Map<string, string>();
	const startedToolsById = new Map<
		string,
		{ toolName: string; startedAtMs: number }
	>();
	const rejectedShellToolCallIds = new Set<string>();
	let reasoningContentObserved = false;
	let reasoningEventObserved = false;
	let failedBackgroundShellCount = 0;
	let unsandboxedShellCount = 0;

	const appendContent = (reasoningId: string, content: string): void => {
		if (!content) {
			return;
		}

		reasoningContentById.set(
			reasoningId,
			`${reasoningContentById.get(reasoningId) ?? ""}${content}`,
		);
	};

	const flushReasoning = (
		reasoningId: string,
		fallbackContent?: string,
	): void => {
		const bufferedContent = reasoningContentById.get(reasoningId) ?? "";
		const content = bufferedContent || (fallbackContent ?? "");
		reasoningContentById.delete(reasoningId);

		if (!content) {
			return;
		}

		logger.trace("copilot reasoning", { reasoningId, content });
	};

	return {
		markRejectedShellCall(toolCallId) {
			if (toolCallId) {
				rejectedShellToolCallIds.add(toolCallId);
			}
		},
		handleEvent(event) {
			if (event.type === "tool.execution_start") {
				const { toolCallId, toolName } = event.data;
				startedToolsById.set(toolCallId, {
					toolName,
					startedAtMs: new Date(event.timestamp).getTime(),
				});
				if (toolName === "bash") {
					logger.info("Copilot bash call", {
						toolCallId,
						command: getBashCommand(event.data.arguments),
					});
				}
				return;
			}

			if (event.type === "tool.execution_complete") {
				const { error, result, sandboxed, success, toolCallId } = event.data;
				const startedTool = startedToolsById.get(toolCallId);
				startedToolsById.delete(toolCallId);
				if (!startedTool) {
					return;
				}
				const durationMs = Math.max(
					0,
					new Date(event.timestamp).getTime() - startedTool.startedAtMs,
				);

				if (startedTool.toolName === "bash") {
					const rejectedBeforeExecution =
						rejectedShellToolCallIds.delete(toolCallId);
					if (!rejectedBeforeExecution && sandboxed !== true) {
						unsandboxedShellCount += 1;
					}
					logger.info("Copilot completed bash call", {
						toolCallId,
						success,
						sandboxed,
						durationMs,
					});
					return;
				}

				if (REVIEW_TOOL_NAME_SET.has(startedTool.toolName)) {
					logger.info("Copilot completed review tool", {
						toolCallId,
						toolName: startedTool.toolName,
						success,
						durationMs,
						...(result?.content ? { result: result.content } : {}),
						...(error ? { error: error.message } : {}),
					});
				}
				return;
			}

			if (event.type === "assistant.intent") {
				const data = getEventData(event);
				const intent =
					typeof data.intent === "string" ? data.intent : undefined;
				if (intent) {
					logger.info("Copilot intent", {
						agentId: event.agentId,
						intent,
					});
				}
				return;
			}

			if (event.type === "model.call_failure") {
				const {
					badRequestKind,
					durationMs,
					errorCode,
					errorType,
					failureKind,
					isAuto,
					isByok,
					model,
					providerCallId,
					reasoningEffort,
					serviceRequestId,
					source,
					statusCode,
					transport,
				} = event.data;
				logger.warn("Copilot model call failed", {
					agentId: event.agentId,
					source,
					model,
					failureKind,
					transport,
					statusCode,
					badRequestKind,
					errorCode,
					errorType,
					durationMs,
					serviceRequestId,
					providerCallId,
					reasoningEffort,
					isAuto,
					isByok,
				});
				return;
			}

			if (event.type === "assistant.reasoning_delta") {
				const data = getEventData(event);
				const reasoningId =
					typeof data.reasoningId === "string" ? data.reasoningId : undefined;
				const deltaContent =
					typeof data.deltaContent === "string" ? data.deltaContent : undefined;
				if (reasoningId) {
					reasoningEventObserved = true;
					if (deltaContent) {
						reasoningContentObserved = true;
						appendContent(reasoningId, deltaContent);
					}
				}
				return;
			}

			if (event.type === "assistant.reasoning") {
				const data = getEventData(event);
				const reasoningId =
					typeof data.reasoningId === "string" ? data.reasoningId : undefined;
				const content =
					typeof data.content === "string" ? data.content : undefined;
				if (reasoningId) {
					reasoningEventObserved = true;
					if (content) {
						reasoningContentObserved = true;
					}
					flushReasoning(reasoningId, content);
				}
				return;
			}

			if (event.type === "assistant.message") {
				const data = getEventData(event);
				const phase = typeof data.phase === "string" ? data.phase : undefined;
				const toolRequests = Array.isArray(data.toolRequests)
					? data.toolRequests
					: [];

				const toolNames = toolRequests.flatMap((toolRequest) => {
					if (!toolRequest || typeof toolRequest !== "object") {
						return [];
					}

					const name = (toolRequest as Record<string, unknown>).name;
					return typeof name === "string" ? [name] : [];
				});
				if (toolNames.length > 0) {
					const intentionSummaries = toolRequests.flatMap((toolRequest) => {
						if (!toolRequest || typeof toolRequest !== "object") {
							return [];
						}

						const intentionSummary = (toolRequest as Record<string, unknown>)
							.intentionSummary;
						return typeof intentionSummary === "string" &&
							intentionSummary.length > 0
							? [intentionSummary]
							: [];
					});
					const progressDetails: {
						agentId?: string;
						phase?: string;
						toolCount: number;
						toolNames: string[];
						intentionSummaries?: string[];
					} = {
						toolCount: toolNames.length,
						toolNames,
					};

					if (event.agentId !== undefined) {
						progressDetails.agentId = event.agentId;
					}
					if (phase) {
						progressDetails.phase = phase;
					}
					if (intentionSummaries.length > 0) {
						progressDetails.intentionSummaries = intentionSummaries;
					}

					logger.info("Copilot planned tool calls", progressDetails);
				}
				return;
			}

			if (event.type === "session.idle") {
				for (const reasoningId of reasoningContentById.keys()) {
					flushReasoning(reasoningId);
				}
				return;
			}

			if (event.type === "subagent.started") {
				const data = getEventData(event);
				logger.info("Copilot subagent started", {
					agentId: event.agentId,
					agentName:
						typeof data.agentName === "string" ? data.agentName : undefined,
					agentDisplayName:
						typeof data.agentDisplayName === "string"
							? data.agentDisplayName
							: undefined,
					agentDescription:
						typeof data.agentDescription === "string"
							? data.agentDescription
							: undefined,
				});
				return;
			}

			if (event.type === "subagent.completed") {
				const data = getEventData(event);
				logger.info("Copilot subagent completed", {
					agentId: event.agentId,
					agentName:
						typeof data.agentName === "string" ? data.agentName : undefined,
					agentDisplayName:
						typeof data.agentDisplayName === "string"
							? data.agentDisplayName
							: undefined,
					durationMs:
						typeof data.durationMs === "number" ? data.durationMs : undefined,
					totalToolCalls:
						typeof data.totalToolCalls === "number"
							? data.totalToolCalls
							: undefined,
				});
				return;
			}

			if (event.type === "subagent.failed") {
				const data = getEventData(event);
				logger.warn("Copilot subagent failed", {
					agentId: event.agentId,
					agentName:
						typeof data.agentName === "string" ? data.agentName : undefined,
					agentDisplayName:
						typeof data.agentDisplayName === "string"
							? data.agentDisplayName
							: undefined,
					error: typeof data.error === "string" ? data.error : undefined,
					durationMs:
						typeof data.durationMs === "number" ? data.durationMs : undefined,
				});
				return;
			}

			if ((event as { type?: string }).type === "system.notification") {
				const data = getEventData(event);
				const content =
					typeof data.content === "string" ? data.content : undefined;
				const kind =
					data.kind && typeof data.kind === "object"
						? (data.kind as Record<string, unknown>)
						: undefined;
				if (
					kind?.type === "shell_completed" &&
					typeof kind.exitCode === "number" &&
					kind.exitCode !== 0
				) {
					failedBackgroundShellCount += 1;
					logger.warn("Copilot background shell failed", {
						shellId: kind.shellId,
						exitCode: kind.exitCode,
						description: kind.description,
						content,
					});
					return;
				}
				logger.info("Copilot system notification", {
					kind: typeof kind?.type === "string" ? kind.type : undefined,
					status: typeof kind?.status === "string" ? kind.status : undefined,
					content,
				});
			}
		},
		getReasoningStatus() {
			if (reasoningContentObserved) {
				return "content";
			}
			return reasoningEventObserved ? "empty" : "missing";
		},
		getFailedBackgroundShellCount() {
			return failedBackgroundShellCount;
		},
		getUnsandboxedShellCount() {
			return unsandboxedShellCount;
		},
	};
}
