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

			if (event.type === "session.idle") {
				for (const reasoningId of reasoningContentById.keys()) {
					flushReasoning(reasoningId);
				}
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
