import type { SessionEvent } from "@github/copilot-sdk";

import type { Logger } from "../shared/logger.ts";

export type CopilotSessionEventTracer = {
	handleEvent(event: SessionEvent): void;
};

type SessionEventWithData = SessionEvent & { data?: Record<string, unknown> };

function getEventData(event: SessionEvent): Record<string, unknown> {
	return (event as SessionEventWithData).data ?? {};
}

export function createSessionEventTracer(
	logger: Logger,
): CopilotSessionEventTracer {
	const reasoningContentById = new Map<string, string>();

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
		handleEvent(event) {
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

			if (event.type === "assistant.reasoning_delta") {
				const data = getEventData(event);
				const reasoningId =
					typeof data.reasoningId === "string" ? data.reasoningId : undefined;
				const deltaContent =
					typeof data.deltaContent === "string" ? data.deltaContent : undefined;
				if (reasoningId && deltaContent) {
					appendContent(reasoningId, deltaContent);
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
				logger.info("Copilot system notification", {
					kind: typeof kind?.type === "string" ? kind.type : undefined,
					status: typeof kind?.status === "string" ? kind.status : undefined,
					content,
				});
			}
		},
	};
}
