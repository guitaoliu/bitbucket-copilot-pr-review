import type {
	SessionEvent,
	ToolHandler,
	ToolResultObject,
} from "@github/copilot-sdk";

type ToolResultType = ToolResultObject["resultType"];

const CONTEXT_TOOL_NAMES = ["read_file", "search_repo", "find_files"] as const;
const TOOL_RESULT_TYPES: ReadonlySet<string> = new Set([
	"success",
	"failure",
	"rejected",
	"denied",
	"timeout",
]);

type SafeParseSchema = {
	safeParse(
		value: unknown,
	): { success: true; data: unknown } | { success: false };
};

type TrackedCall = {
	toolName: string;
	operationKey?: string;
};

type TrackableTool = {
	name: string;
	parameters?: unknown;
	handler?: unknown;
};

type ReviewToolExecutionTracker = {
	trackTools<TTools extends TrackableTool[]>(tools: TTools): TTools;
	handleEvent(event: SessionEvent): void;
	getResultCounts(): Record<string, Record<string, number>>;
	getUnresolvedContextTools(): string[];
};

function isContextToolName(
	toolName: string,
): toolName is (typeof CONTEXT_TOOL_NAMES)[number] {
	return CONTEXT_TOOL_NAMES.includes(
		toolName as (typeof CONTEXT_TOOL_NAMES)[number],
	);
}

function isSafeParseSchema(value: unknown): value is SafeParseSchema {
	return (
		typeof value === "object" &&
		value !== null &&
		"safeParse" in value &&
		typeof value.safeParse === "function"
	);
}

function normalizeToolArguments(tool: TrackableTool, args: unknown): unknown {
	if (!isSafeParseSchema(tool.parameters)) {
		return args;
	}

	const parsed = tool.parameters.safeParse(args);
	return parsed.success ? parsed.data : args;
}

function getToolResultType(result: unknown): ToolResultType {
	if (
		typeof result === "object" &&
		result !== null &&
		"resultType" in result &&
		typeof result.resultType === "string" &&
		TOOL_RESULT_TYPES.has(result.resultType)
	) {
		return result.resultType as ToolResultType;
	}

	return "success";
}

export function createReviewToolExecutionTracker(): ReviewToolExecutionTracker {
	const toolsByName = new Map<string, TrackableTool>();
	const callsById = new Map<string, TrackedCall>();
	const finalizedCallIds = new Set<string>();
	const unresolvedOperations = new Map<string, string>();
	const resultCounts = new Map<string, Map<string, number>>();

	const start = (toolCallId: string, toolName: string, args: unknown): void => {
		if (finalizedCallIds.has(toolCallId)) {
			return;
		}

		const tool = toolsByName.get(toolName);
		if (!tool) {
			return;
		}

		callsById.set(toolCallId, {
			toolName,
			...(isContextToolName(toolName)
				? {
						operationKey: JSON.stringify([
							toolName,
							normalizeToolArguments(tool, args),
						]),
					}
				: {}),
		});
	};

	const finish = (toolCallId: string, resultType: ToolResultType): void => {
		if (finalizedCallIds.has(toolCallId)) {
			return;
		}

		const call = callsById.get(toolCallId);
		if (!call) {
			return;
		}

		finalizedCallIds.add(toolCallId);
		callsById.delete(toolCallId);
		const toolCounts = resultCounts.get(call.toolName) ?? new Map();
		toolCounts.set(resultType, (toolCounts.get(resultType) ?? 0) + 1);
		resultCounts.set(call.toolName, toolCounts);

		if (!call.operationKey) {
			return;
		}
		if (resultType === "success") {
			unresolvedOperations.delete(call.operationKey);
		} else if (resultType !== "rejected") {
			unresolvedOperations.set(call.operationKey, call.toolName);
		}
	};
	const trackTools = <TTools extends TrackableTool[]>(
		tools: TTools,
	): TTools => {
		for (const tool of tools) {
			toolsByName.set(tool.name, tool);
		}

		return tools.map((tool) => {
			if (typeof tool.handler !== "function") {
				return tool;
			}
			const handler = tool.handler as ToolHandler;

			return {
				...tool,
				handler: async (
					args: unknown,
					invocation: Parameters<ToolHandler>[1],
				) => {
					start(invocation.toolCallId, tool.name, args);
					try {
						const result = await handler(args, invocation);
						finish(invocation.toolCallId, getToolResultType(result));
						return result;
					} catch (error) {
						finish(invocation.toolCallId, "failure");
						throw error;
					}
				},
			};
		}) as unknown as TTools;
	};

	return {
		trackTools,
		handleEvent(event) {
			if (event.type === "tool.execution_start") {
				start(event.data.toolCallId, event.data.toolName, event.data.arguments);
			} else if (event.type === "tool.execution_complete") {
				finish(
					event.data.toolCallId,
					event.data.success ? "success" : "failure",
				);
			}
		},
		getResultCounts() {
			return Object.fromEntries(
				Array.from(resultCounts, ([toolName, counts]) => [
					toolName,
					Object.fromEntries(counts),
				]),
			);
		},
		getUnresolvedContextTools() {
			const unresolvedToolNames = new Set(unresolvedOperations.values());
			return CONTEXT_TOOL_NAMES.filter((toolName) =>
				unresolvedToolNames.has(toolName),
			);
		},
	};
}
