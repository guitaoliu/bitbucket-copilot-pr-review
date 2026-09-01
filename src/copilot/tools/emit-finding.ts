import { defineTool } from "@github/copilot-sdk";

import { findingDraftSchema } from "../../policy/findings.ts";
import type { FindingDraft } from "../../review/types.ts";
import { toRejectedResult, validateFindingDraftLocation } from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

export function createEmitFindingTool(toolContext: ReviewToolContext) {
	const { drafts, reviewableFileMap, resolveChangedLines } = toolContext;

	return defineTool("emit_finding", {
		description:
			"Record a validated review finding for later publication to Bitbucket.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				path: {
					type: "string",
					minLength: 1,
					description: "Reviewed file path in the current commit.",
				},
				line: {
					type: "integer",
					minimum: 0,
					description:
						"Head-side line number. Use 0 only for a file-level issue.",
				},
				severity: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
				type: { type: "string", enum: ["BUG", "CODE_SMELL", "VULNERABILITY"] },
				confidence: { type: "string", enum: ["low", "medium", "high"] },
				title: {
					type: "string",
					minLength: 1,
					maxLength: 200,
					description: "A short issue title.",
				},
				details: {
					type: "string",
					maxLength: 1600,
					description: "A concise explanation of why this is an issue.",
				},
				category: {
					type: "string",
					maxLength: 80,
					description:
						"Optional short category when obvious and helpful, such as security, correctness, data-integrity, concurrency, reliability, performance, or tests.",
				},
			},
			required: [
				"path",
				"line",
				"severity",
				"type",
				"confidence",
				"title",
				"details",
			],
		},
		handler: async (args: FindingDraft) => {
			const parsed = findingDraftSchema.safeParse(args);
			if (!parsed.success) {
				return toRejectedResult(
					`Invalid finding payload: ${parsed.error.message}`,
				);
			}

			const draft = parsed.data;
			const location = await validateFindingDraftLocation(
				draft,
				reviewableFileMap,
				resolveChangedLines,
			);
			if (location.error) {
				return toRejectedResult(location.error);
			}

			const normalizedDraft = location.normalizedDraft ?? draft;
			drafts.push(normalizedDraft);

			const locationLabel =
				normalizedDraft.line > 0
					? `${normalizedDraft.path}:${normalizedDraft.line}`
					: `${normalizedDraft.path}:file`;
			return location.note
				? `Recorded finding ${drafts.length} for ${locationLabel}; ${location.note}`
				: `Recorded finding ${drafts.length} for ${locationLabel}.`;
		},
	});
}
