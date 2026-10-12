import type {
	Tool,
	ToolInvocation,
	ToolResultObject,
} from "@github/copilot-sdk";
import { z } from "zod";

export type ToolResultType = ToolResultObject["resultType"];

class ToolRejection {
	readonly message: string;

	constructor(message: string) {
		this.message = message;
	}
}

export interface ReviewToolCallObserver {
	recordHandlerStart(call: {
		toolCallId: string;
		toolName: string;
		operationKey: string;
	}): void;
	recordHandlerResult(toolCallId: string, resultType: ToolResultType): void;
}

export interface ReviewToolDefinition {
	name: string;
	bind(observer: ReviewToolCallObserver): Tool;
}

export function rejectToolCall(message: string): ToolRejection {
	return new ToolRejection(message);
}

function toModelFeedback(message: string): ToolResultObject {
	// The runtime ends the agent turn on "rejected" results, so correctable input
	// problems are reported as failures the model can act on in the same turn.
	return { textResultForLlm: message, resultType: "failure" };
}

export function defineReviewTool<TSchema extends z.ZodType>(
	name: string,
	config: {
		description: string;
		schema: TSchema;
		overridesBuiltInTool?: true;
		handler(
			args: z.output<TSchema>,
			invocation: ToolInvocation,
		): Promise<string | object>;
	},
): ReviewToolDefinition {
	const parameters = z.toJSONSchema(config.schema, { io: "input" });
	return {
		name,
		bind: (observer) => ({
			name,
			description: config.description,
			parameters,
			...(config.overridesBuiltInTool ? { overridesBuiltInTool: true } : {}),
			handler: async (args, invocation) => {
				const parsed = config.schema.safeParse(args);
				if (!parsed.success) {
					observer.recordHandlerResult(invocation.toolCallId, "rejected");
					return toModelFeedback(
						`Invalid ${name} arguments: ${z.prettifyError(parsed.error)}`,
					);
				}

				observer.recordHandlerStart({
					toolCallId: invocation.toolCallId,
					toolName: name,
					operationKey: JSON.stringify([name, parsed.data]),
				});
				try {
					const result = await config.handler(parsed.data, invocation);
					if (result instanceof ToolRejection) {
						observer.recordHandlerResult(invocation.toolCallId, "rejected");
						return toModelFeedback(result.message);
					}
					observer.recordHandlerResult(invocation.toolCallId, "success");
					return result;
				} catch (error) {
					observer.recordHandlerResult(invocation.toolCallId, "failure");
					throw error;
				}
			},
		}),
	};
}
