import type { ChatMessage, ModelStep } from "./fake-model.ts";

interface ScriptedToolCall {
	name: string;
	args: Record<string, unknown>;
	result?: string;
}

function collectToolCalls(messages: ChatMessage[]): ScriptedToolCall[] {
	const calls = new Map<string, ScriptedToolCall>();
	for (const message of messages) {
		for (const call of message.tool_calls ?? []) {
			calls.set(call.id, {
				name: call.function.name,
				args: JSON.parse(call.function.arguments),
			});
		}
		const answered =
			message.role === "tool" && message.tool_call_id
				? calls.get(message.tool_call_id)
				: undefined;
		if (answered) {
			answered.result =
				typeof message.content === "string"
					? message.content
					: JSON.stringify(message.content);
		}
	}
	return [...calls.values()];
}

const PLANNED_TOOL_CALLS: ScriptedToolCall[] = [
	{ name: "read_file", args: { revision: "head", path: "src/app.js" } },
	{ name: "read_file", args: { revision: "head", path: ".env" } },
	{
		name: "read_file",
		args: { revision: "base", path: "config/secrets/key.txt" },
	},
	{
		name: "search_repo",
		args: {
			revision: "head",
			patterns: ["SECRET_TOKEN", "key-material"],
			paths: [],
		},
	},
	{ name: "find_files", args: { revision: "head", paths: [] } },
	{
		name: "emit_finding",
		args: {
			path: "src/app.js",
			line: 2,
			severity: "MEDIUM",
			type: "BUG",
			confidence: "high",
			title: "Loose equality changes comparison semantics",
			details:
				'`a == b` coerces types, so `same(1, "1")` now returns true where it returned false before.',
			category: "correctness",
		},
	},
	{
		name: "emit_finding",
		args: {
			path: "src/app.js",
			line: 1,
			severity: "LOW",
			type: "BUG",
			confidence: "high",
			title: "Finding on an unchanged line",
			details: "The reviewer must reject this location.",
		},
	},
	{
		name: "record_pr_summary",
		args: { summary: "Switches `same` from strict to loose equality." },
	},
];

/**
 * Scripted reviewer: reads every review page, probes secret-bearing paths,
 * emits one valid and one out-of-scope finding, then records a summary.
 */
export function nextReviewerStep(messages: ChatMessage[]): ModelStep {
	const calls = collectToolCalls(messages);
	const reviewCalls = calls.filter((call) => call.name === "review_changes");
	const nextPage = reviewCalls
		.at(-1)
		?.result?.match(/"nextPage":\s*(\d+)/)?.[1];
	if (reviewCalls.length === 0 || nextPage) {
		return {
			toolCall: {
				name: "review_changes",
				args: { page: nextPage ? Number(nextPage) : 1 },
			},
		};
	}

	const planned = PLANNED_TOOL_CALLS[calls.length - reviewCalls.length];
	return planned
		? { toolCall: { name: planned.name, args: planned.args } }
		: { reply: "Review complete." };
}
