import { createServer } from "node:http";

import { closeServer, listenOnLoopback, readRequestBody } from "./http.ts";

export interface ChatToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export interface ChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: unknown;
	tool_calls?: ChatToolCall[];
	tool_call_id?: string;
}

export interface ChatCompletionRequest {
	model?: string;
	stream?: boolean;
	messages?: ChatMessage[];
}

export type ModelStep =
	| { toolCall: { name: string; args: Record<string, unknown> } }
	| { reply: string };

export interface FakeModel {
	url: string;
	requests: ChatCompletionRequest[];
	close(): Promise<void>;
}

function buildAssistantMessage(step: ModelStep, callId: string) {
	if ("reply" in step) {
		return { role: "assistant", content: step.reply };
	}

	return {
		role: "assistant",
		content: null,
		tool_calls: [
			{
				id: callId,
				type: "function",
				function: {
					name: step.toolCall.name,
					arguments: JSON.stringify(step.toolCall.args),
				},
			},
		],
	};
}

/**
 * OpenAI chat-completions server whose replies come from a deterministic
 * script, so the real Copilot runtime can run a full review offline.
 */
export async function startFakeModel(
	nextStep: (messages: ChatMessage[]) => ModelStep,
): Promise<FakeModel> {
	const requests: ChatCompletionRequest[] = [];
	const server = createServer(async (request, response) => {
		const rawBody = await readRequestBody(request);
		const body = (rawBody ? JSON.parse(rawBody) : {}) as ChatCompletionRequest;
		if (!request.url?.endsWith("/chat/completions")) {
			response.writeHead(404).end();
			return;
		}

		requests.push(body);
		const step = nextStep(body.messages ?? []);
		const id = `chatcmpl-${requests.length}`;
		const message = buildAssistantMessage(step, `call_${requests.length}`);
		const finishReason = "toolCall" in step ? "tool_calls" : "stop";
		const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };

		if (!body.stream) {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					id,
					object: "chat.completion",
					created: 0,
					model: body.model,
					choices: [{ index: 0, message, finish_reason: finishReason }],
					usage,
				}),
			);
			return;
		}

		const { content, tool_calls: toolCalls } = message;
		const delta = toolCalls
			? {
					role: "assistant",
					tool_calls: toolCalls.map((call, index) => ({ index, ...call })),
				}
			: { role: "assistant", content };
		const chunk = (choice: Record<string, unknown>, extra = {}) =>
			`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, ...choice }], ...extra })}\n\n`;
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write(chunk({ delta, finish_reason: null }));
		response.write(
			chunk({ delta: {}, finish_reason: finishReason }, { usage }),
		);
		response.end("data: [DONE]\n\n");
	});

	const baseUrl = await listenOnLoopback(server);
	return {
		url: `${baseUrl}/v1`,
		requests,
		close: () => closeServer(server),
	};
}
