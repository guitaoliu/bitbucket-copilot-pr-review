import type { ChatMessage, ModelStep } from "./fake-model.ts";

export interface ScriptedToolCall {
	name: string;
	args: Record<string, unknown>;
}

interface ObservedToolCall extends ScriptedToolCall {
	result?: string;
}

export interface ScriptedReviewerOptions {
	toolCalls?: ScriptedToolCall[];
	skipReviewChanges?: true;
}

export type ScriptedReviewer = (messages: ChatMessage[]) => ModelStep;

function collectToolCalls(messages: ChatMessage[]): ObservedToolCall[] {
	const calls = new Map<string, ObservedToolCall>();
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

export const VALID_FINDING_ARGS = {
	path: "src/app.js",
	line: 2,
	severity: "MEDIUM",
	type: "BUG",
	confidence: "high",
	title: "Loose equality changes comparison semantics",
	details:
		'`a == b` coerces types, so `same(1, "1")` now returns true where it returned false before.',
	category: "correctness",
};

export const SECRET_PROBE_CALLS: ScriptedToolCall[] = [
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
];

export const READ_CHANGED_FILE_CALL: ScriptedToolCall = {
	name: "read_file",
	args: { revision: "head", path: "src/app.js" },
};

export const EMIT_VALID_FINDING_CALL: ScriptedToolCall = {
	name: "emit_finding",
	args: VALID_FINDING_ARGS,
};

export const RECORD_SUMMARY_CALL: ScriptedToolCall = {
	name: "record_pr_summary",
	args: { summary: "Switches `same` from strict to loose equality." },
};

/**
 * Reads the changed file, probes secret-bearing paths, emits one valid and one
 * out-of-scope finding, then records a summary.
 */
export const DEFAULT_TOOL_CALLS: ScriptedToolCall[] = [
	READ_CHANGED_FILE_CALL,
	...SECRET_PROBE_CALLS,
	EMIT_VALID_FINDING_CALL,
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
	RECORD_SUMMARY_CALL,
];

/**
 * Scripted reviewer: reads every review_changes page unless told to skip the
 * review stream, then issues the planned tool calls in order and finishes.
 */
export function createScriptedReviewer(
	options: ScriptedReviewerOptions = {},
): ScriptedReviewer {
	const toolCalls = options.toolCalls ?? DEFAULT_TOOL_CALLS;
	return (messages) => {
		const calls = collectToolCalls(messages);
		const reviewCalls = calls.filter((call) => call.name === "review_changes");
		const nextPage = reviewCalls
			.at(-1)
			?.result?.match(/"nextPage":\s*(\d+)/)?.[1];
		if (!options.skipReviewChanges && (reviewCalls.length === 0 || nextPage)) {
			return {
				toolCall: {
					name: "review_changes",
					args: { page: nextPage ? Number(nextPage) : 1 },
				},
			};
		}

		const planned = toolCalls[calls.length - reviewCalls.length];
		return planned
			? { toolCall: { name: planned.name, args: planned.args } }
			: { reply: "Review complete." };
	};
}
