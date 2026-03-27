import { defineTool } from "@github/copilot-sdk";

import { findingDraftSchema } from "../../policy/findings.ts";
import type { FindingDraft } from "../../review/types.ts";
import { toRejectedResult, validateFindingDraftLocation } from "./common.ts";
import type { ReviewToolContext } from "./context.ts";

export function createReplaceRecordedFindingTool(
	toolContext: ReviewToolContext,
) {
	const { drafts, reviewedFileMap } = toolContext;

	return defineTool("replace_recorded_finding", {
		description:
			"Replace an already recorded finding draft with a stronger or more accurate one.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				findingNumber: {
					type: "integer",
					minimum: 1,
					description: "1-based finding number from list_recorded_findings.",
				},
				path: {
					type: "string",
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
				title: { type: "string", description: "A short issue title." },
				details: {
					type: "string",
					description: "A concise explanation of why this is an issue.",
				},
				category: {
					type: "string",
					description:
						"Optional short category when obvious and helpful, such as security, correctness, data-integrity, concurrency, reliability, performance, or tests.",
				},
			},
			required: [
				"findingNumber",
				"path",
				"line",
				"severity",
				"type",
				"confidence",
				"title",
				"details",
			],
		},
		handler: async (args: FindingDraft & { findingNumber: number }) => {
			const findingIndex = args.findingNumber - 1;
			if (findingIndex < 0 || findingIndex >= drafts.length) {
				return toRejectedResult(
					`Finding ${args.findingNumber} does not exist. Recorded findings: ${drafts.length}.`,
				);
			}

			const parsed = findingDraftSchema.safeParse(args);
			if (!parsed.success) {
				return toRejectedResult(
					`Invalid finding payload: ${parsed.error.message}`,
				);
			}

			const draft = parsed.data;
			const location = validateFindingDraftLocation(draft, reviewedFileMap);
			if (location.error) {
				return toRejectedResult(location.error);
			}

			const normalizedDraft = location.normalizedDraft ?? draft;
			drafts[findingIndex] = normalizedDraft;
			const locationLabel =
				normalizedDraft.line > 0
					? `${normalizedDraft.path}:${normalizedDraft.line}`
					: `${normalizedDraft.path}:file`;
			return location.note
				? `Replaced finding ${args.findingNumber} with ${locationLabel}; ${location.note}`
				: `Replaced finding ${args.findingNumber} with ${locationLabel}.`;
		},
	});
}
