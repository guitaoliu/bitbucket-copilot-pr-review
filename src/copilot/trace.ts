import type { CopilotSession } from "@github/copilot-sdk";

import type { Logger } from "../shared/logger.ts";

export function wireReasoningTrace(
	session: CopilotSession,
	logger: Logger,
): void {
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

	session.on("assistant.reasoning_delta", (event) => {
		appendContent(event.data.reasoningId, event.data.deltaContent);
	});

	session.on("assistant.reasoning", (event) => {
		flushReasoning(event.data.reasoningId, event.data.content);
	});

	session.on("session.idle", () => {
		for (const reasoningId of reasoningContentById.keys()) {
			flushReasoning(reasoningId);
		}
	});
}
